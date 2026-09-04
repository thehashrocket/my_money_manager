import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { CategoryNotFoundError } from "@/lib/categoryErrors";

type Db = typeof defaultDb;
type CategoryKind = "income" | "expense" | "fund";

/**
 * Candidates for the F1 banner's reclassify picker: leaf, expense-kind,
 * non-archived categories — the only starting kind X1 permits a used
 * category to leave. `setCategoryKind` itself enforces the real rule; this
 * list is just what's worth offering rather than every category the action
 * would refuse anyway. Excludes archived categories for the same reason
 * `listLeafCategories`'s `includeArchived` guard does (X3/B7): reclassifying
 * one wouldn't actually fix F1's "no income categories" banner, since an
 * archived category stays hidden from the budget grid regardless of `kind`
 * — offering it here would let the dialog report success while the banner
 * silently persists.
 */
export function listExpenseLeafCategories(db: Db): { id: number; name: string }[] {
  const parentIds = db
    .selectDistinct({ parentId: schema.categories.parentId })
    .from(schema.categories)
    .all()
    .map((r) => r.parentId)
    .filter((id): id is number => id !== null);

  const rows = db
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(
      parentIds.length > 0
        ? and(
            eq(schema.categories.kind, "expense"),
            isNull(schema.categories.archivedAt),
            notInArray(schema.categories.id, parentIds),
          )
        : and(eq(schema.categories.kind, "expense"), isNull(schema.categories.archivedAt)),
    )
    .all();

  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export type ReclassifyCandidate = {
  id: number;
  name: string;
  transactionCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  /** X1's exact test, precomputed so the confirmation dialog can state it
   * as evidence up front (DS32) instead of only discovering it on submit. */
  allPositive: boolean;
};

/**
 * DS32: the reclassify dialog states a concrete count, date range, and the
 * all-positive check X1 requires — as evidence, not a precondition
 * discovered only after a refused submit. One grouped query across every
 * candidate rather than one query per row in the picker.
 *
 * A category with a `budget_periods` row but zero transactions is excluded
 * entirely rather than listed with `allPositive: true` — `setCategoryKind`'s
 * D9A "used" check refuses it regardless of `allPositive` (X1's exception
 * requires `count > 0`, not just "no negative rows"), so listing it here
 * would be exactly the "discovered only after a refused submit" case DS32
 * exists to prevent.
 */
export function loadReclassifyCandidates(db: Db): ReclassifyCandidate[] {
  const leaves = listExpenseLeafCategories(db);
  if (leaves.length === 0) return [];

  const leafIds = leaves.map((l) => l.id);

  const statRows = db
    .select({
      categoryId: schema.transactions.categoryId,
      count: sql<number>`COUNT(*)`,
      negativeCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amountCents} < 0 THEN 1 ELSE 0 END), 0)`,
      earliestDate: sql<string | null>`MIN(${schema.transactions.date})`,
      latestDate: sql<string | null>`MAX(${schema.transactions.date})`,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.categoryId, leafIds))
    .groupBy(schema.transactions.categoryId)
    .all();

  const statsById = new Map(statRows.map((r) => [r.categoryId as number, r]));

  const plannedCategoryIds = new Set(
    db
      .selectDistinct({ categoryId: schema.budgetPeriods.categoryId })
      .from(schema.budgetPeriods)
      .where(inArray(schema.budgetPeriods.categoryId, leafIds))
      .all()
      .map((r) => r.categoryId),
  );

  return leaves
    .filter((leaf) => !plannedCategoryIds.has(leaf.id))
    .map((leaf) => {
      const stat = statsById.get(leaf.id);
      return {
        id: leaf.id,
        name: leaf.name,
        transactionCount: stat?.count ?? 0,
        earliestDate: stat?.earliestDate ?? null,
        latestDate: stat?.latestDate ?? null,
        allPositive: (stat?.negativeCount ?? 0) === 0,
      };
    });
}

/**
 * D9A: a used category (≥1 transaction or ≥1 `budget_periods` row) refuses
 * reclassification. Carries what the confirmation dialog (DS32) needs to
 * name concretely — a count and a date range, never a generic warning.
 */
export class CategoryKindChangeRefusedError extends Error {
  constructor(
    readonly categoryId: number,
    readonly categoryName: string,
    readonly transactionCount: number,
    readonly earliestDate: string | null,
    readonly latestDate: string | null,
  ) {
    super(
      transactionCount > 0
        ? `"${categoryName}" has ${transactionCount} transaction${transactionCount === 1 ? "" : "s"} (${earliestDate} – ${latestDate}) and cannot be reclassified.`
        : `"${categoryName}" already has a budget planned for at least one month and cannot be reclassified.`,
    );
    this.name = "CategoryKindChangeRefusedError";
  }
}

export type SetCategoryKindResult = {
  categoryId: number;
  previousKind: CategoryKind;
  newKind: CategoryKind;
};

/**
 * D9A + X1: change a category's `kind`.
 *
 * A category with any transaction or `budget_periods` row is "used" and
 * refuses outright — reclassifying it retroactively rewrites every past
 * month's summary, the trend chart, goal inclusion, and categorize
 * eligibility, a blast radius no confirmation dialog can honestly enumerate.
 *
 * X1's one exception: expense → income on a category with at least one
 * transaction, all of them positive. That is the F1 failure mode's repair
 * path (a renamed income category, full of paychecks, that D9A would
 * otherwise refuse to fix forever) — decidable by one query rather than a
 * judgment call, and every OTHER transition stays absolute. A category
 * that is "used" only via a `budget_periods` row (planned, never spent) does
 * not fit that repair story and stays refused — `count > 0` is required,
 * not just "no negative rows found."
 */
export function setCategoryKind(db: Db, categoryId: number, newKind: CategoryKind): SetCategoryKindResult {
  return db.transaction((tx) => {
    const category = tx
      .select({ id: schema.categories.id, name: schema.categories.name, kind: schema.categories.kind })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .get();
    if (!category) throw new CategoryNotFoundError(categoryId);

    const previousKind = category.kind;
    if (previousKind === newKind) {
      return { categoryId, previousKind, newKind };
    }

    const txnStats = tx
      .select({
        count: sql<number>`COUNT(*)`,
        negativeCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amountCents} < 0 THEN 1 ELSE 0 END), 0)`,
        earliestDate: sql<string | null>`MIN(${schema.transactions.date})`,
        latestDate: sql<string | null>`MAX(${schema.transactions.date})`,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.categoryId, categoryId))
      .get()!;

    const periodCount =
      tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(schema.budgetPeriods)
        .where(eq(schema.budgetPeriods.categoryId, categoryId))
        .get()?.count ?? 0;

    const isUsed = txnStats.count > 0 || periodCount > 0;
    if (isUsed) {
      const isX1Exception =
        previousKind === "expense" && newKind === "income" && txnStats.count > 0 && txnStats.negativeCount === 0;
      if (!isX1Exception) {
        throw new CategoryKindChangeRefusedError(
          category.id,
          category.name,
          txnStats.count,
          txnStats.earliestDate,
          txnStats.latestDate,
        );
      }
    }

    // Dual-write (T5, D1B/A2): `createGoalAction` already keeps
    // `is_savings_goal` truthful alongside `kind` "until PR3 drops the
    // column entirely" (its own comment). PR2b's general `setCategoryKind`
    // (T25) is the other place `kind` can now change post-creation — without
    // this, reclassifying any category to/from `fund` through the `⋯` menu
    // would silently diverge the two columns the moment anything besides
    // `createGoalAction` reads `is_savings_goal` again.
    tx.update(schema.categories)
      .set({ kind: newKind, isSavingsGoal: newKind === "fund" })
      .where(eq(schema.categories.id, categoryId))
      .run();

    // Kind decides rollover eligibility (T2's income guard) and Left to
    // Budget's math, so every cached `effective_allocation_cents` for this
    // category is stale the moment `kind` changes. Invalidate from its
    // earliest budget_periods row forward — there is nothing to invalidate
    // for a category that was genuinely unused (no rows exist).
    const earliestPeriod = tx
      .select({ year: schema.budgetPeriods.year, month: schema.budgetPeriods.month })
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, categoryId))
      .orderBy(asc(schema.budgetPeriods.year), asc(schema.budgetPeriods.month))
      .limit(1)
      .get();
    if (earliestPeriod) {
      invalidateForwardRollover(tx, categoryId, earliestPeriod.year, earliestPeriod.month);
    }

    return { categoryId, previousKind, newKind };
  });
}
