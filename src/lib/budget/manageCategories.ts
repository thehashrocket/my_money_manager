import { eq, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { CategoryNameTakenError, CategoryNotFoundError } from "@/lib/categoryErrors";

type Db = typeof defaultDb;
type CategoryKind = "income" | "expense" | "fund";
type CarryoverPolicy = "none" | "rollover" | "reset";

/**
 * DS12: `sort_order`'s column default of `0` would put every new category
 * at the top of its group/band — new rows append instead. "Siblings" means
 * literally "same `parent_id` value," matching `sort_order`'s own contract
 * (`schema.ts`: "Ordering only ever compares siblings sharing a parent_id")
 * — a new top-level group's siblings are every other `parent_id IS NULL`
 * row, which is harmless even though only OTHER groups are ever compared
 * against it (income/fund leaves sort by their own rule, never `sort_order`).
 */
function nextSortOrder(db: AnyDb, parentId: number | null): number {
  const row = db
    .select({ max: sql<number | null>`MAX(${schema.categories.sortOrder})` })
    .from(schema.categories)
    .where(parentId === null ? isNull(schema.categories.parentId) : eq(schema.categories.parentId, parentId))
    .get();
  return (row?.max ?? 0) + 1;
}

function assertNameAvailable(db: AnyDb, name: string, excludingId?: number): void {
  const existing = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.name, name))
    .get();
  if (existing && existing.id !== excludingId) throw new CategoryNameTakenError(name);
}

export type CreatedCategory = {
  id: number;
  name: string;
  kind: CategoryKind;
  parentId: number | null;
  sortOrder: number;
};

/**
 * DS20: a group is just a category nobody else has categorized transactions
 * against directly — `parentId: null`, `kind` left at the schema default
 * ('expense'). A group's own `kind` is never read: `loadMonthView`'s three
 * band filters all exclude anything referenced as a parent (`!parentIds.has(c.id)`)
 * before `kind` is ever consulted, so a group header's `kind` column value
 * is structurally inert. Not exposed as a param for that reason — there is
 * nothing meaningful to choose.
 */
export function createCategoryGroup(db: Db, name: string): CreatedCategory {
  return db.transaction((tx) => {
    assertNameAvailable(tx, name);
    const sortOrder = nextSortOrder(tx, null);
    const [row] = tx
      .insert(schema.categories)
      .values({ name, parentId: null, sortOrder })
      .returning({ id: schema.categories.id, name: schema.categories.name, kind: schema.categories.kind })
      .all();
    return { id: row.id, name: row.name, kind: row.kind, parentId: null, sortOrder };
  });
}

/**
 * DS20: inline leaf creation — "+ Add a line to Housing." `parentId: null`
 * is valid too (an unparented leaf, same shape the seeded income/fund
 * categories already use).
 */
export function createCategory(
  db: Db,
  params: { name: string; kind: CategoryKind; parentId: number | null; carryoverPolicy?: CarryoverPolicy },
): CreatedCategory {
  const { name, kind, parentId, carryoverPolicy = "none" } = params;
  return db.transaction((tx) => {
    assertNameAvailable(tx, name);
    if (parentId !== null) {
      const parent = tx.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.id, parentId)).get();
      if (!parent) throw new CategoryNotFoundError(parentId);
    }
    const sortOrder = nextSortOrder(tx, parentId);
    const [row] = tx
      .insert(schema.categories)
      .values({ name, kind, parentId, carryoverPolicy, sortOrder })
      .returning({ id: schema.categories.id, name: schema.categories.name, kind: schema.categories.kind })
      .all();
    return { id: row.id, name: row.name, kind: row.kind, parentId, sortOrder };
  });
}

export type RenamedCategory = { id: number; name: string };

/**
 * A8/T28: this is the action that first makes a "looks like income" state
 * reachable going forward — renaming a category doesn't change its `kind`,
 * so a category renamed to sound like income (or away from a name that
 * signaled it) can silently drift from what its transactions actually look
 * like. `resolveExpenseRow`'s `looksLikeIncome` hint (T28) is the mitigation;
 * this function itself has no special-casing for it — a plain rename.
 */
export function renameCategory(db: Db, categoryId: number, name: string): RenamedCategory {
  return db.transaction((tx) => {
    const category = tx.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.id, categoryId)).get();
    if (!category) throw new CategoryNotFoundError(categoryId);
    assertNameAvailable(tx, name, categoryId);
    tx.update(schema.categories).set({ name }).where(eq(schema.categories.id, categoryId)).run();
    return { id: categoryId, name };
  });
}

export type CarryoverPolicyResult = { categoryId: number; carryoverPolicy: CarryoverPolicy };

/**
 * §7.1: "already a documented invalidation trigger" — flipping
 * rollover↔reset re-keys every downstream month's effective allocation the
 * same way a `kind` change does (`setCategoryKind`), so this invalidates
 * forward from the category's earliest `budget_periods` row.
 */
export function setCarryoverPolicy(db: Db, categoryId: number, carryoverPolicy: CarryoverPolicy): CarryoverPolicyResult {
  return db.transaction((tx) => {
    const category = tx.select({ id: schema.categories.id }).from(schema.categories).where(eq(schema.categories.id, categoryId)).get();
    if (!category) throw new CategoryNotFoundError(categoryId);

    tx.update(schema.categories).set({ carryoverPolicy }).where(eq(schema.categories.id, categoryId)).run();

    const earliestPeriod = tx
      .select({ year: schema.budgetPeriods.year, month: schema.budgetPeriods.month })
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, categoryId))
      .orderBy(schema.budgetPeriods.year, schema.budgetPeriods.month)
      .limit(1)
      .get();
    if (earliestPeriod) {
      invalidateForwardRollover(tx, categoryId, earliestPeriod.year, earliestPeriod.month);
    }

    return { categoryId, carryoverPolicy };
  });
}

export type MoveDirection = "up" | "down";

export type MoveCategoryResult = {
  categoryId: number;
  /** The sibling it swapped with, or `null` when already at that end of the
   * list (a no-op — DS16's reorder controls stay enabled-but-inert there
   * rather than disabled, per §6.5, since PR2a's reorder UI reuses this). */
  swappedWithId: number | null;
  newPosition: number;
  siblingCount: number;
};

/**
 * T29/§6.4: swap `sort_order` with the adjacent sibling in `sort_order ASC,
 * name ASC` order — the exact order `loadMonthView` renders in, so "up"
 * always matches what the user sees move up. "Siblings" = same `parent_id`,
 * so this works identically for a leaf within a group and a group within
 * the top level ("at both levels" — one implementation, not two).
 */
export function moveCategory(db: Db, categoryId: number, direction: MoveDirection): MoveCategoryResult {
  return db.transaction((tx) => {
    const category = tx
      .select({ id: schema.categories.id, parentId: schema.categories.parentId, sortOrder: schema.categories.sortOrder })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .get();
    if (!category) throw new CategoryNotFoundError(categoryId);

    const siblings = tx
      .select({ id: schema.categories.id, sortOrder: schema.categories.sortOrder, name: schema.categories.name })
      .from(schema.categories)
      .where(
        category.parentId === null ? isNull(schema.categories.parentId) : eq(schema.categories.parentId, category.parentId),
      )
      .all()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const index = siblings.findIndex((s) => s.id === categoryId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= siblings.length) {
      return { categoryId, swappedWithId: null, newPosition: index, siblingCount: siblings.length };
    }

    const target = siblings[targetIndex];
    tx.update(schema.categories).set({ sortOrder: target.sortOrder }).where(eq(schema.categories.id, category.id)).run();
    tx.update(schema.categories).set({ sortOrder: category.sortOrder }).where(eq(schema.categories.id, target.id)).run();

    return { categoryId, swappedWithId: target.id, newPosition: targetIndex, siblingCount: siblings.length };
  });
}
