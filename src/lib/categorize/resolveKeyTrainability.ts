import { and, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";
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
 * spelling, shared by `loadFiledCategoryIds` (below) and the batched
 * `loadFiledCategoryCountsByMerchant` (further below). `loadFiledCategoryIdsByMerchant`
 * reaches it only THROUGH that counts version (it is the counts dropped, for
 * `/categorize`) — never call it a third caller of this predicate.
 *
 * It takes the merchant condition rather than building it, because the two
 * DIRECT callers need different ones: `eq()` for a single key here, `inArray()`
 * for a page's worth of merchants there. Everything else has to be identical,
 * and it was previously hand-duplicated and held together by comments plus
 * one parity test. A divergence renders the checkbox enabled and then has the
 * server refuse the submit, which is precisely the surprise this guard exists
 * to prevent.
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

/** A merchant's filed evidence for one category, WITH how many rows carry it. */
export type FiledCategoryCount = { categoryId: number; count: number };

/**
 * How many of `merchants`' already-filed rows carry each category, batched
 * over the whole set in one query rather than one round trip per merchant.
 * Predicate per {@link filedCategoryEvidenceWhere}.
 *
 * The count is what lets `loadTransactions` emulate `excludeTxnIds=[row.id]`
 * for EACH row without a per-row query (ship review, Codex adversarial +
 * structured, cross-model agreement — P1/P2): a row's own current category
 * can be dropped from ITS OWN evidence set exactly when this row is the sole
 * contributor (`count === 1`), which is mathematically identical to what
 * `resolveKeyTrainability(db, merchant, categoryId, [row.id])` would compute,
 * for every row this app can reach through `/transactions`' categorize form —
 * a transfer-paired row is refused by `categorizeTransaction` before this
 * verdict would ever matter, and a row whose OWN category is archived is
 * already excluded from every count by `filedCategoryEvidenceWhere` itself,
 * so there is nothing to over-exclude in either case. This replaced an
 * earlier version that returned no counts at all and read every row's OWN
 * evidence as if it belonged to some other row — provably conservative-only
 * relative to a naive client read, but not to the single-row retarget case
 * this docstring now closes exactly.
 */
export function loadFiledCategoryCountsByMerchant(
  db: AnyDb,
  merchants: readonly string[],
): Map<string, FiledCategoryCount[]> {
  if (merchants.length === 0) return new Map();
  const rows = db
    .select({
      normalizedMerchant: schema.transactions.normalizedMerchant,
      categoryId: schema.transactions.categoryId,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(
      filedCategoryEvidenceWhere(
        inArray(schema.transactions.normalizedMerchant, [...merchants]),
      ),
    )
    .groupBy(schema.transactions.normalizedMerchant, schema.transactions.categoryId)
    .all();

  const byMerchant = new Map<string, FiledCategoryCount[]>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    const entry: FiledCategoryCount = { categoryId: row.categoryId, count: Number(row.count) };
    const existing = byMerchant.get(row.normalizedMerchant);
    if (existing === undefined) byMerchant.set(row.normalizedMerchant, [entry]);
    else existing.push(entry);
  }
  return byMerchant;
}

/**
 * Distinct category ids each of `merchants`' already-filed rows carries —
 * {@link loadFiledCategoryCountsByMerchant} with the counts dropped, for
 * `loadMerchantGroups`, which is already grouped by merchant and has no
 * single row to self-exclude (every row it groups is `categoryId IS NULL`,
 * which the shared predicate already skips as evidence).
 */
export function loadFiledCategoryIdsByMerchant(
  db: AnyDb,
  merchants: readonly string[],
): Map<string, number[]> {
  const counts = loadFiledCategoryCountsByMerchant(db, merchants);
  const byMerchant = new Map<string, number[]>();
  for (const [merchant, entries] of counts) {
    byMerchant.set(
      merchant,
      entries.map((e) => e.categoryId),
    );
  }
  return byMerchant;
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
