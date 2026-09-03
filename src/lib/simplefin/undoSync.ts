import { and, desc, eq } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { db as defaultDb, schema } from "@/db";
import { resolveBatchLabel } from "@/lib/batchLabel";

type Db = typeof defaultDb;

// Structural type, unlike `Db` above — accepts both the singleton database
// and a transaction handle, so `isLatestBatch` can be re-checked from inside
// `db.transaction((tx) => ...)`. Matches the pattern in `src/lib/rules.ts`.
type AnyDb = BaseSQLiteDatabase<
  "sync",
  unknown,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type SyncBatchSummary = {
  batchId: number;
  label: string;
  importedAt: Date;
  transactionCount: number;
  /** Rows the user has since categorised — undoing throws that work away. */
  categorizedCount: number;
};

export type UndoResult =
  | { status: "nothing-to-undo" }
  | {
      /**
       * A later import (CSV or another sync) landed after this batch. CSV
       * content-dedup (buildPreview, scoped to date range only — not
       * source) can have matched a CSV row against one of THIS batch's
       * rows and skipped inserting it, so this batch may now be the ONLY
       * copy of a transaction. Deleting it would be silent, permanent data
       * loss, not a safe reversal.
       */
      status: "stale";
      reason: string;
    }
  | { status: "undone"; batchId: number; deletedCount: number };

/**
 * Whether `batchId` is still the most recently created import batch of ANY
 * source. Undo is only safe while that holds — see the `stale` UndoResult
 * variant above.
 */
function isLatestBatch(batchId: number, db: AnyDb): boolean {
  const latest = db
    .select({ id: schema.importBatches.id })
    .from(schema.importBatches)
    .orderBy(desc(schema.importBatches.id))
    .limit(1)
    .get();
  return latest?.id === batchId;
}

export function findLastSyncBatch(db: Db = defaultDb): SyncBatchSummary | null {
  const batch = db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.source, "simplefin"))
    .orderBy(desc(schema.importBatches.id))
    .limit(1)
    .get();

  if (!batch) return null;
  // A later CSV import may have already deduped against this batch's rows.
  // Don't offer undo at all once that's possible — see `isLatestBatch`.
  if (!isLatestBatch(batch.id, db)) return null;

  const rows = db
    .select({ categoryId: schema.transactions.categoryId })
    .from(schema.transactions)
    .where(eq(schema.transactions.importBatchId, batch.id))
    .all();

  return {
    batchId: batch.id,
    label: resolveBatchLabel(batch),
    importedAt: batch.importedAt,
    transactionCount: rows.length,
    categorizedCount: rows.filter((r) => r.categoryId !== null).length,
  };
}

/**
 * Reverses a sync by deleting its rows, rather than by restoring the snapshot.
 * A file swap would also discard everything done since the sync — and cannot
 * run while the dev server holds the database open. The snapshot stays as the
 * escape hatch for anything this cannot fix.
 *
 * Rows outside the batch that were transfer-paired to a deleted row are
 * unlinked automatically: transfer_pair_id is ON DELETE SET NULL.
 */
export function undoSyncBatch(batchId: number, db: Db = defaultDb): UndoResult {
  const batch = db
    .select()
    .from(schema.importBatches)
    .where(
      and(
        eq(schema.importBatches.id, batchId),
        eq(schema.importBatches.source, "simplefin"),
      ),
    )
    .get();

  if (!batch) return { status: "nothing-to-undo" };

  return db.transaction((tx) => {
    // Re-checked inside the transaction, not just by the page that offered
    // the button: a second tab (or the same tab re-submitting a stale form)
    // can import a CSV file between page load and this call. Content-dedup
    // has no source filter, so that CSV import may have already matched
    // against this batch's rows and skipped inserting its own — making this
    // batch the only copy. Deleting it here would be silent, permanent loss.
    if (!isLatestBatch(batchId, tx)) {
      return {
        status: "stale" as const,
        reason:
          "A newer import landed after this sync. Undoing now could delete transactions that only exist in this batch — reload the page and check before retrying.",
      };
    }

    const doomed = tx
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.importBatchId, batchId))
      .all();

    tx.delete(schema.transactions)
      .where(eq(schema.transactions.importBatchId, batchId))
      .run();

    // import_batch_id is ON DELETE RESTRICT, so the batch can only go after
    // its rows.
    tx.delete(schema.importBatches)
      .where(eq(schema.importBatches.id, batchId))
      .run();

    return { status: "undone" as const, batchId, deletedCount: doomed.length };
  });
}

export function undoLastSync(db: Db = defaultDb): UndoResult {
  const last = findLastSyncBatch(db);
  if (!last) return { status: "nothing-to-undo" };
  return undoSyncBatch(last.batchId, db);
}
