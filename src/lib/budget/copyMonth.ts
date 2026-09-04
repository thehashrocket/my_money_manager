import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRolloverMany } from "@/lib/budget";
import { previousMonth } from "@/lib/budget/monthOfIso";

type Db = typeof defaultDb;

export type CopyPreviousMonthResult = {
  copied: number;
  skipped: number;
  skippedArchived: number;
};

/**
 * DS7's disabled-button check ("August has no budget to copy") — cheap
 * enough to run on every page render rather than only when the copy button
 * is clicked, so the UI never invites a click that can only ever no-op.
 */
export function hasAnyAllocations(db: Db, year: number, month: number): boolean {
  const row = db
    .select({ id: schema.budgetPeriods.id })
    .from(schema.budgetPeriods)
    .where(and(eq(schema.budgetPeriods.year, year), eq(schema.budgetPeriods.month, month)))
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * DS7/DS31 — the highest-leverage thing in PR1b for "budget a month in
 * three minutes": fill THIS month's blanks from last month's
 * `budget_periods`, never overwrite. Destructive-by-default with no undo
 * isn't worth the convenience — a row that already exists this month is
 * SKIPPED, not replaced, so "skipped 12 rows you already set" is a fine
 * message rather than a lost edit.
 *
 * DS12 — archived categories are excluded via the join. Without it, copy
 * would clone every prior-month row including archived ones — resurrecting
 * a category into the current month AND recreating the allocation that
 * archiving was supposed to stop, the two features silently undoing each
 * other. The join matches nothing until PR2b's `archiveCategoryAction`
 * exists to set `archived_at` — that is correct behavior for today, not a
 * stub standing in for one.
 *
 * D8A: one `invalidateForwardRolloverMany` call across every copied
 * category rather than one `invalidateForwardRollover` per category.
 *
 * Whole thing in one transaction — a crash mid-copy must not leave some
 * categories filled and others not, with no record of which.
 */
export function copyPreviousMonth(db: Db, targetYear: number, targetMonth: number): CopyPreviousMonthResult {
  const { year: priorYear, month: priorMonth } = previousMonth(targetYear, targetMonth);

  return db.transaction((tx) => {
    const priorRows = tx
      .select({
        categoryId: schema.budgetPeriods.categoryId,
        allocatedCents: schema.budgetPeriods.allocatedCents,
        archivedAt: schema.categories.archivedAt,
      })
      .from(schema.budgetPeriods)
      .innerJoin(schema.categories, eq(schema.categories.id, schema.budgetPeriods.categoryId))
      .where(and(eq(schema.budgetPeriods.year, priorYear), eq(schema.budgetPeriods.month, priorMonth)))
      .all();

    const targetRows = tx
      .select({ categoryId: schema.budgetPeriods.categoryId })
      .from(schema.budgetPeriods)
      .where(and(eq(schema.budgetPeriods.year, targetYear), eq(schema.budgetPeriods.month, targetMonth)))
      .all();
    const alreadySet = new Set(targetRows.map((r) => r.categoryId));

    let copied = 0;
    let skipped = 0;
    let skippedArchived = 0;
    const copiedCategoryIds: number[] = [];

    for (const row of priorRows) {
      if (row.archivedAt !== null) {
        skippedArchived += 1;
        continue;
      }
      if (alreadySet.has(row.categoryId)) {
        skipped += 1;
        continue;
      }
      tx.insert(schema.budgetPeriods)
        .values({
          categoryId: row.categoryId,
          year: targetYear,
          month: targetMonth,
          allocatedCents: row.allocatedCents,
        })
        .run();
      copied += 1;
      copiedCategoryIds.push(row.categoryId);
    }

    invalidateForwardRolloverMany(tx, copiedCategoryIds, targetYear, targetMonth);

    return { copied, skipped, skippedArchived };
  });
}
