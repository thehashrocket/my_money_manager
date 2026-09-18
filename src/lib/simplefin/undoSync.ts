import { and, desc, eq, ne } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";
import { resolveBatchLabel } from "@/lib/batchLabel";

type Db = typeof defaultDb;
type SyncTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type SyncBatchSummary = {
  batchId: number;
  label: string;
  importedAt: Date;
  /**
   * Rows this batch inserted PLUS rows it promoted (a pending row confirmed
   * as posted — see `sync_promotions`, schema.ts). A promoted row keeps its
   * ORIGINAL batch id, so it is never counted via `import_batch_id`; this
   * is a real fact about what the sync did, not just what it owns.
   */
  transactionCount: number;
  /**
   * Rows the user has since categorised, scoped to BATCH-OWNED (inserted)
   * rows only — undoing deletes those, throwing that work away. Deliberately
   * excludes a promoted row's categorization: undo REVERTS a promoted row
   * (puts it back to pending) rather than deleting it, so its category is
   * never at risk and folding it in here would overstate what undo
   * destroys.
   */
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
  | {
      status: "undone";
      batchId: number;
      deletedCount: number;
      /**
       * Rows put BACK to pending (and their pre-promotion memo/provenance/
       * transfer pairing) rather than deleted — see the `sync_promotions`
       * revert step below. Reported separately from `deletedCount` because
       * "removed 0 transactions" would be misleading for a promotion-only
       * undo: real state changed, nothing was removed.
       */
      revertedCount: number;
    };

/**
 * Puts one promoted row back exactly as it was before this batch promoted
 * it — including its transfer pairing, which is the part a blind "clear to
 * null" would get wrong. A pending row can ALREADY be legitimately
 * transfer-paired before ever being promoted (`linkTransfersByBucket`'s own
 * candidate query, and the manual pairing/rejection functions, have no
 * `isPending` guard), so undo must restore whatever pairing existed rather
 * than assume there was none.
 *
 * If this sync's OWN `linkTransfersByBucket` call paired the row AFTER
 * promoting it, that pairing is cleared on both legs directly (never through
 * `unlinkTransferPair`, which also records a `transfer_pair_rejections`
 * row — undoing a promotion is not a human saying "not a transfer," it is
 * taking back the promotion that made the pairing possible).
 *
 * `priorTransferPairId` is NOT restored blindly (Testing specialist finding,
 * `/ship`, confirmed by direct reading — an earlier version of this function
 * did exactly that). Time can pass between promotion and undo, and the PRIOR
 * partner's own pairing is not frozen in that window: a user can unlink the
 * pre-existing pair (`unlinkTransferPair`, reachable from `/sync`'s "Not a
 * transfer" button) before ever undoing the sync that promoted its other
 * leg. Restoring `priorTransferPairId` onto this row in that case would
 * resurrect a ONE-SIDED reference — this row points at a partner that no
 * longer points back — a dangling pair with no UI surface to detect or
 * repair it, since every existing review/unlink affordance assumes
 * `transfer_pair_id` is symmetric. So the prior partner is re-read fresh
 * here and the pairing is restored ONLY if it still points back at this
 * transaction; otherwise this row is left unpaired, which is a state a
 * human can act on (re-link manually) rather than a silently wrong one.
 *
 * Returns whether `promotion.transactionId` still existed to revert.
 * `tryPromoteCandidate`'s own docstring names deletion as one of the two
 * races this whole mechanism guards against, but nothing in this app can
 * delete a promoted (posted, non-`manual`) row through the UI today — see
 * `manualTransaction.ts`'s `import_source = 'manual'` guard — so this is
 * only reachable via direct DB manipulation (`pnpm db:studio`, a hand-run
 * migration). Still worth checking rather than assuming: without it, the
 * final UPDATE below silently affects 0 rows (better-sqlite3 doesn't throw
 * on that), and the caller would credit `revertedCount` for a row that was
 * never actually put back to pending — a durable fact reported to the user
 * that would be false (silent-failure-hunter finding, `/ship`).
 */
function revertPromotion(
  tx: SyncTx,
  promotion: typeof schema.syncPromotions.$inferSelect,
): boolean {
  const current = tx
    .select({ transferPairId: schema.transactions.transferPairId })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, promotion.transactionId))
    .get();

  if (!current) {
    console.error(
      `[undoSyncBatch] sync_promotions row ${promotion.id} names transaction ` +
        `${promotion.transactionId}, which no longer exists — nothing to revert`,
    );
    return false;
  }

  if (current.transferPairId !== promotion.priorTransferPairId) {
    if (current.transferPairId !== null) {
      tx.update(schema.transactions)
        .set({ transferPairId: null })
        .where(eq(schema.transactions.id, current.transferPairId))
        .run();
    }
    tx.update(schema.transactions)
      .set({ transferPairId: null })
      .where(eq(schema.transactions.id, promotion.transactionId))
      .run();
  }

  let restoredTransferPairId: number | null = null;
  if (promotion.priorTransferPairId !== null) {
    const priorPartner = tx
      .select({ transferPairId: schema.transactions.transferPairId })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, promotion.priorTransferPairId))
      .get();
    if (priorPartner && priorPartner.transferPairId === promotion.transactionId) {
      restoredTransferPairId = promotion.priorTransferPairId;
    }
  }

  tx.update(schema.transactions)
    .set({
      isPending: promotion.priorIsPending,
      rawMemo: promotion.priorRawMemo,
      normalizedMerchant: promotion.priorNormalizedMerchant,
      payee: promotion.priorPayee,
      cardLastFour: promotion.priorCardLastFour,
      importRowHash: promotion.priorImportRowHash,
      externalId: promotion.priorExternalId,
      simplefinSourceAccountId: promotion.priorSimplefinSourceAccountId,
      bankTransactionNumber: promotion.priorBankTransactionNumber,
      transferPairId: restoredTransferPairId,
    })
    .where(eq(schema.transactions.id, promotion.transactionId))
    .run();
  return true;
}

/**
 * Whether `batchId` is still the most recently created import batch of any
 * source THAT COULD HAVE DEDUPED AGAINST IT. Undo is only safe while that
 * holds — see the `stale` UndoResult variant above.
 *
 * Takes `AnyDb`, not `Db`, so this can be re-checked from inside
 * `db.transaction((tx) => ...)` as well as against the singleton database.
 *
 * REGRESSION (T9/R2) — manual batches are ignored. The reason undo is
 * withheld at all is that a LATER IMPORT may already have content-deduped
 * against this batch's rows and skipped one, quietly relying on it being
 * there; deleting them would then lose a transaction with nothing to say so.
 * A hand-entered card charge dedups against nothing — it is typed, not
 * matched — so it cannot create that dependency.
 *
 * Without this filter, `findLastSyncBatch` returns null the moment any manual
 * row exists (E21 writes one batch per manual operation), so syncing and then
 * entering a single card charge would make the sync's undo button silently
 * disappear. Manual activity must never revoke a sync's undo.
 */
function isLatestBatch(batchId: number, db: AnyDb): boolean {
  const latest = db
    .select({ id: schema.importBatches.id })
    .from(schema.importBatches)
    .where(ne(schema.importBatches.source, "manual"))
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
  const promotionCount = db
    .select({ id: schema.syncPromotions.id })
    .from(schema.syncPromotions)
    .where(eq(schema.syncPromotions.batchId, batch.id))
    .all().length;

  return {
    batchId: batch.id,
    label: resolveBatchLabel(batch),
    importedAt: batch.importedAt,
    transactionCount: rows.length + promotionCount,
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

    // Revert every row this batch PROMOTED, before touching batch-owned
    // rows — a promoted row is never batch-owned (it keeps its original
    // batch id), so it would otherwise survive this undo untouched, still
    // marked posted under this sync's now-deleted batch's provenance.
    const promotions = tx
      .select()
      .from(schema.syncPromotions)
      .where(eq(schema.syncPromotions.batchId, batchId))
      .all();
    let revertedCount = 0;
    for (const promotion of promotions) {
      if (revertPromotion(tx, promotion)) revertedCount++;
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
    // its rows. `sync_promotions` rows for this batch cascade with it — the
    // revert above already applied their snapshot, so the cascade is just
    // cleanup, not the mechanism that puts the row back.
    tx.delete(schema.importBatches)
      .where(eq(schema.importBatches.id, batchId))
      .run();

    return {
      status: "undone" as const,
      batchId,
      deletedCount: doomed.length,
      revertedCount,
    };
  });
}

export function undoLastSync(db: Db = defaultDb): UndoResult {
  const last = findLastSyncBatch(db);
  if (!last) return { status: "nothing-to-undo" };
  return undoSyncBatch(last.batchId, db);
}
