import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import {
  classifyKeyTrainability,
  type TrainabilityVerdict,
} from "./keyTrainability";

/**
 * The database half of the Remember guard. Kept apart from
 * `keyTrainability.ts` so the pure predicate stays importable from the client
 * graph — see the zero-imports note in that file.
 */

/**
 * Distinct non-null category ids already carried by non-transfer rows for this
 * key. Transfer-paired rows are excluded to match `loadMerchantGroups` and
 * `bulkCategorize`, which both scope to the same row set — a key whose only
 * "second category" came from a transfer-paired row would otherwise be refused
 * on evidence `/categorize` never shows.
 */
export function loadFiledCategoryIds(
  db: AnyDb,
  normalizedMerchant: string,
): number[] {
  const rows = db
    .selectDistinct({ categoryId: schema.transactions.categoryId })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.normalizedMerchant, normalizedMerchant),
        isNotNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all();
  return rows.map((r) => r.categoryId).filter((id): id is number => id !== null);
}

/**
 * The verdict for a key that is about to be filed to `pendingCategoryId`.
 *
 * Safe to call inside an open write transaction — it only reads — but it MUST
 * be called before the caller's own UPDATE, or the union below describes a
 * ledger that already contains this action's writes and counts them as prior
 * evidence. Both call sites hoist it for exactly that reason.
 */
export function resolveKeyTrainability(
  db: AnyDb,
  normalizedMerchant: string,
  pendingCategoryId: number,
): TrainabilityVerdict {
  const filed = loadFiledCategoryIds(db, normalizedMerchant);
  return classifyKeyTrainability(normalizedMerchant, [
    ...filed,
    pendingCategoryId,
  ]);
}
