import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type SyncBatchSummary = {
  batchId: number;
  filename: string;
  importedAt: Date;
  transactionCount: number;
  /** Rows the user has since categorised — undoing throws that work away. */
  categorizedCount: number;
};

export type UndoResult =
  | { status: "nothing-to-undo" }
  | { status: "undone"; batchId: number; deletedCount: number };

export function findLastSyncBatch(db: Db = defaultDb): SyncBatchSummary | null {
  const batch = db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.source, "simplefin"))
    .orderBy(desc(schema.importBatches.id))
    .limit(1)
    .get();

  if (!batch) return null;

  const rows = db
    .select({ categoryId: schema.transactions.categoryId })
    .from(schema.transactions)
    .where(eq(schema.transactions.importBatchId, batch.id))
    .all();

  return {
    batchId: batch.id,
    filename: batch.filename,
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
