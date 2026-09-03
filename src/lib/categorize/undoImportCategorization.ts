import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { parseIsoMonth } from "@/lib/budget/monthOfIso";

type Db = typeof defaultDb;

export type UndoImportCategorizationResult =
  | { status: "nothing-to-undo" }
  | { status: "reverted"; revertedCount: number; skippedCount: number };

/**
 * Still-revertible join condition, shared by `countRevertibleCategorizations`
 * and `undoImportCategorization` so they can never drift apart: the
 * transaction's current category must match what the rule recorded, AND the
 * transaction must not have been touched since (`updatedAt <= createdAt` of
 * its own audit row). The categoryId check alone isn't enough — a row
 * recategorized away and then back to the SAME category before undo runs
 * would match on categoryId despite being a deliberate, later user choice
 * (Codex structured review, `/ship` 2026-09-03). `updatedAt` and the audit
 * row's `createdAt` are written in the same insert transaction at import
 * time, so they start equal; any later categorize/re-categorize moves
 * `updatedAt` strictly past it.
 */
function stillRevertible(categoryId?: number) {
  return and(
    eq(schema.importBatchCategorizations.transactionId, schema.transactions.id),
    categoryId === undefined
      ? eq(schema.importBatchCategorizations.categoryId, schema.transactions.categoryId)
      : and(
          eq(schema.transactions.categoryId, categoryId),
          eq(schema.importBatchCategorizations.categoryId, categoryId),
        ),
    lte(schema.transactions.updatedAt, schema.importBatchCategorizations.createdAt),
  );
}

/**
 * How many of a batch's audit rows would actually revert right now. NOT a
 * bare `COUNT(*)` over `import_batch_categorizations`: that would count rows
 * the user has since hand-categorized too, overstating what undo can do
 * (Red Team, /ship 2026-09-03 — the naive count made the pre-undo banner
 * claim more than the stale-row-safe revert would actually deliver). Single
 * source of truth for "still revertible," shared by every page that shows
 * this count, so it can't drift from `undoImportCategorization`'s own
 * stale-row check below.
 */
export function countRevertibleCategorizations(db: Db, batchId: number): number {
  const [row] = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.importBatchCategorizations)
    .innerJoin(schema.transactions, stillRevertible())
    .where(eq(schema.importBatchCategorizations.importBatchId, batchId))
    .all();
  return row?.count ?? 0;
}

/**
 * Reverse everything a batch's rule matching auto-categorized at import time
 * (`commitImport` / `syncSimpleFin`), using the audit trail
 * `import_batch_categorizations` writes at insert time.
 *
 * This is the import-time counterpart to `undoBulkCategorize` — the gap
 * CLAUDE.md rule 6 flags: import-time categorization had no undo at all,
 * only the full-DB pre-import snapshot (which reverts everything the batch
 * did, not just the categorization). One batch can auto-categorize hundreds
 * of rows across dozens of merchants/categories in one shot (e.g. a 4.5-month
 * backfill through migration 0006's broad `contains` rules), where a full
 * snapshot restore is a much bigger hammer than "undo the categorization."
 *
 * Stale-row-safe, per row: a row is only reset to NULL if its CURRENT
 * category still matches what the rule set — a row the user has since
 * hand-categorized (via `/categorize` or `/transactions`) is left alone.
 * Rows are grouped by their recorded category so each group reverts in one
 * bulk UPDATE (mirrors `undoBulkCategorize`, generalized to the many
 * categories a single import batch can touch, vs. bulkCategorize's one).
 *
 * Consumes the audit trail: rows in `import_batch_categorizations` for this
 * batch are deleted whether reverted or skipped, so a second call reports
 * `nothing-to-undo` rather than re-attempting a stale comparison.
 */
export function undoImportCategorization(
  db: Db,
  batchId: number,
): UndoImportCategorizationResult {
  return db.transaction((tx) => {
    const records = tx
      .select({
        transactionId: schema.importBatchCategorizations.transactionId,
        categoryId: schema.importBatchCategorizations.categoryId,
      })
      .from(schema.importBatchCategorizations)
      .where(eq(schema.importBatchCategorizations.importBatchId, batchId))
      .all();

    if (records.length === 0) {
      return { status: "nothing-to-undo" as const };
    }

    const categoryIds = [...new Set(records.map((r) => r.categoryId))];

    let revertedCount = 0;

    for (const categoryId of categoryIds) {
      const stillMatching = tx
        .select({ id: schema.transactions.id, date: schema.transactions.date })
        .from(schema.transactions)
        .innerJoin(schema.importBatchCategorizations, stillRevertible(categoryId))
        .where(eq(schema.importBatchCategorizations.importBatchId, batchId))
        .all();
      if (stillMatching.length === 0) continue;

      tx.update(schema.transactions)
        .set({ categoryId: null, updatedAt: new Date() })
        .where(inArray(schema.transactions.id, stillMatching.map((r) => r.id)))
        .run();
      revertedCount += stillMatching.length;

      const earliestDate = stillMatching.reduce<string | null>(
        (acc, r) => (!acc || r.date < acc ? r.date : acc),
        null,
      );
      if (earliestDate) {
        const { year, month } = parseIsoMonth(earliestDate);
        invalidateForwardRollover(tx, categoryId, year, month);
      }
    }

    tx.delete(schema.importBatchCategorizations)
      .where(eq(schema.importBatchCategorizations.importBatchId, batchId))
      .run();

    return {
      status: "reverted" as const,
      revertedCount,
      skippedCount: records.length - revertedCount,
    };
  });
}
