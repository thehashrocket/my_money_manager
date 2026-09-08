import { and, eq, isNotNull, isNull, notInArray, type SQL } from "drizzle-orm";
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
 * "Which already-made filings count as evidence about this key" — the ONE
 * spelling, shared with `loadMerchantGroups`' batched `loadFiledCategories`.
 *
 * It takes the merchant condition rather than building it, because the two
 * callers need different ones: `eq()` for a single key here, `inArray()` for a
 * page's worth of groups there. Everything else has to be identical, and it was
 * previously hand-duplicated and held together by comments plus one parity test.
 * A divergence renders the checkbox enabled and then has the server refuse the
 * submit, which is precisely the surprise this guard exists to prevent.
 *
 * Three clauses, each for its own reason:
 *
 *   categoryId IS NOT NULL   an unfiled row says nothing about the key. This is
 *                            the inverse of every other query in
 *                            `loadMerchantGroups`, which reads the backlog.
 *   transferPairId IS NULL   a transfer-paired row is not spending and
 *                            `/categorize` never shows it, so refusing a key on
 *                            evidence the user cannot see is indefensible.
 *   archivedAt IS NULL       an ARCHIVED category's rules never fire
 *                            (`buildRuleMatcher` skips them, rule 8), so a
 *                            filing under one cannot contradict a live rule.
 *                            Counting it refused a key whose only category that
 *                            still matters is unanimous.
 */
export function filedCategoryEvidenceWhere(
  merchantCondition: SQL | undefined,
  excludeTxnIds: readonly number[] = [],
): SQL | undefined {
  return and(
    merchantCondition,
    isNotNull(schema.transactions.categoryId),
    isNull(schema.transactions.transferPairId),
    isNull(schema.categories.archivedAt),
    excludeTxnIds.length > 0
      ? notInArray(schema.transactions.id, [...excludeTxnIds])
      : undefined,
  );
}

/**
 * Distinct category ids this key's already-filed rows carry, ignoring
 * `excludeTxnIds`. Predicate per {@link filedCategoryEvidenceWhere}.
 *
 * `excludeTxnIds` is how a caller says "these rows are about to move, so do not
 * count where they are now". It is expected to hold a HANDFUL of ids — the one
 * row `categorizeTransaction` is retargeting — not a whole batch. Rows that are
 * currently `categoryId IS NULL` never need excluding, because the predicate
 * already skips them, so `bulkCategorize` (which only ever touches NULL rows)
 * passes nothing and avoids an `IN` list the length of its backlog.
 */
export function loadFiledCategoryIds(
  db: AnyDb,
  normalizedMerchant: string,
  excludeTxnIds: readonly number[] = [],
): number[] {
  const rows = db
    .selectDistinct({ categoryId: schema.transactions.categoryId })
    .from(schema.transactions)
    .innerJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(
      filedCategoryEvidenceWhere(
        eq(schema.transactions.normalizedMerchant, normalizedMerchant),
        excludeTxnIds,
      ),
    )
    .all();
  return rows.map((r) => r.categoryId).filter((id): id is number => id !== null);
}

/**
 * The verdict for a key whose `excludeTxnIds` rows are about to be filed to
 * `pendingCategoryId`.
 *
 * Excluding the rows this action writes is what makes the verdict describe the
 * ledger AS IT WILL BE rather than as it was, and that distinction is not
 * cosmetic. Retargeting a key's only filed row — pick a new category on a
 * `/transactions` row, tick Remember — used to be refused on the category the
 * row was LEAVING, which no longer exists for that key once the action
 * commits. One rule genuinely is right afterwards, so the box has to work.
 *
 * It also removes an ordering trap rather than documenting one. This used to
 * carry a "MUST be called before your own UPDATE" warning, because reading
 * afterwards counted the action's own writes as prior evidence. With the
 * written rows excluded the answer is the same on both sides of the UPDATE, so
 * the invariant holds by construction instead of by comment in three places.
 * Callers still hoist it, which is now a readability choice.
 *
 * Safe inside an open write transaction — it only reads.
 */
export function resolveKeyTrainability(
  db: AnyDb,
  normalizedMerchant: string,
  pendingCategoryId: number,
  excludeTxnIds: readonly number[] = [],
): TrainabilityVerdict {
  const filed = loadFiledCategoryIds(db, normalizedMerchant, excludeTxnIds);
  return classifyKeyTrainability(normalizedMerchant, filed, pendingCategoryId);
}
