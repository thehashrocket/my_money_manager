import { and, eq, ne, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { currentMonth } from "@/lib/now";
import {
  CategoryArchiveRefusedError,
  CategoryHasChildrenError,
  CategoryNotFoundError,
  UncategorizedArchiveError,
} from "@/lib/categoryErrors";

type Db = typeof defaultDb;

export type ArchiveCategoryResult = {
  categoryId: number;
  categoryName: string;
  archivedAt: Date;
};

/**
 * T27/§7.2 — archive, not delete. `transactions.category_id` is
 * `onDelete: 'set null'` and `budget_periods.category_id` is
 * `onDelete: 'cascade'`, so a real delete would silently dump every
 * transaction back into the backlog and destroy the allocation history the
 * trend chart reads. Archiving instead sets `archived_at` and leaves
 * everything else — the rule matcher (`buildRuleMatcher`, X3) and pickers
 * (`listLeafCategories`, X3) both learn to skip it; historical months that
 * already spent or allocated against it keep showing it (X3's other half).
 *
 * Refusals, in order:
 * - `Uncategorized` — the trigger-protected landing zone, same rule as the
 *   DELETE-side `categories_uncategorized_no_delete` trigger.
 * - has children — a parent is header-only; archiving it would orphan an
 *   inconsistent half-archived group rather than hide anything real.
 * - a non-zero `budget_periods` row in the current or a future month (F4) —
 *   archiving would hide that money from Left to Budget's equation without
 *   ever spending or un-planning it. A PAST month's allocation does not
 *   block archive: history doesn't need protecting from this the way an
 *   open plan does.
 *
 * Idempotent: archiving an already-archived category is a no-op that
 * returns its existing `archivedAt` rather than re-stamping it (or erroring
 * — a stale form resubmit must not fail).
 */
export function archiveCategory(db: Db, categoryId: number, now: Date = new Date()): ArchiveCategoryResult {
  return db.transaction((tx) => {
    const category = tx
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        archivedAt: schema.categories.archivedAt,
      })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .get();
    if (!category) throw new CategoryNotFoundError(categoryId);
    if (category.archivedAt !== null) {
      return { categoryId, categoryName: category.name, archivedAt: category.archivedAt };
    }
    if (category.name === "Uncategorized") throw new UncategorizedArchiveError(categoryId);

    const firstChild = tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.parentId, categoryId))
      .limit(1)
      .get();
    if (firstChild) throw new CategoryHasChildrenError(categoryId, category.name);

    const { year, month } = currentMonth(now);
    const openAllocation = tx
      .select({ year: schema.budgetPeriods.year, month: schema.budgetPeriods.month })
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, categoryId),
          ne(schema.budgetPeriods.allocatedCents, 0),
          sql`(${schema.budgetPeriods.year} > ${year} OR (${schema.budgetPeriods.year} = ${year} AND ${schema.budgetPeriods.month} >= ${month}))`,
        ),
      )
      .orderBy(schema.budgetPeriods.year, schema.budgetPeriods.month)
      .limit(1)
      .get();
    if (openAllocation) {
      throw new CategoryArchiveRefusedError(categoryId, category.name, openAllocation.year, openAllocation.month);
    }

    tx.update(schema.categories).set({ archivedAt: now }).where(eq(schema.categories.id, categoryId)).run();
    return { categoryId, categoryName: category.name, archivedAt: now };
  });
}

export type UnarchiveCategoryResult = {
  categoryId: number;
  categoryName: string;
};

/**
 * The reversibility half of "archive, not delete" — without an unarchive
 * path, an archived category is operationally indistinguishable from a
 * deleted one the moment it drops out of every picker and row list. Idempotent
 * the same way `archiveCategory` is: unarchiving an already-active category
 * is a no-op, not an error.
 */
export function unarchiveCategory(db: Db, categoryId: number): UnarchiveCategoryResult {
  return db.transaction((tx) => {
    const category = tx
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .get();
    if (!category) throw new CategoryNotFoundError(categoryId);

    tx.update(schema.categories).set({ archivedAt: null }).where(eq(schema.categories.id, categoryId)).run();
    return { categoryId, categoryName: category.name };
  });
}
