import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type ExistingRule = {
  categoryId: number;
  categoryName: string;
};

/** Up to this many distinct bank memos are shown per group (D16). */
const MAX_SAMPLE_MEMOS = 3;

export type MerchantGroup = {
  normalizedMerchant: string;
  count: number;
  /** Signed sum of `amount_cents` for NULL-category rows in the group. */
  totalCents: number;
  /** Exact-match manual/auto rule currently targeting this merchant, if any. */
  existingRule: ExistingRule | null;
  /**
   * D16 — up to three distinct bank memos from this group's uncategorized
   * rows, so "AMAZON, 53 rows, −$2,411" can be answered in place instead of
   * only by navigating away.
   *
   * Memos identical to the key itself are excluded in SQL: on the real ledger
   * `TRIM(raw_memo) = normalized_merchant` on 151 of 1,540 rows (9.8%), and a
   * sample that repeats the line above it is noise, not evidence. An empty
   * array therefore means "nothing to disclose" and the row renders no
   * disclosure control at all — not a control that opens onto nothing.
   */
  sampleMemos: string[];
  /**
   * Every non-transfer row carrying this key, INCLUDING ones already filed.
   *
   * Differs from `count` on purpose (D3): the row's own figure is its
   * uncategorized backlog, but the drilldown deliberately shows the whole
   * history, because how a merchant was filed before is the decision support.
   * Naming the same number in both places would misstate what the link opens.
   */
  totalRowCount: number;
  /**
   * Distinct categories this key's already-filed, non-transfer rows carry.
   *
   * Feeds the Remember guard (`keyTrainability.ts`) on the client, where it is
   * unioned with the category the user has currently picked. Shipped as the
   * ids rather than as a finished verdict for exactly that reason: the verdict
   * depends on the pick, which only the row component knows, and computing it
   * here would disagree with the server the moment the user chooses a category
   * this key has never been filed to.
   *
   * Same predicate as `loadFiledCategoryIds` — a divergence between the two
   * would let the checkbox render enabled and then be refused on submit.
   */
  filedCategoryIds: number[];
};

/**
 * Group every uncategorized, non-transfer transaction by `normalized_merchant`
 * for the `/categorize` view. Transfer-paired rows are excluded from both the
 * read (here) and any future write (bulkCategorize) so the pair machinery
 * stays the single owner of those rows.
 *
 * Returns groups sorted by count DESC, then merchant name ASC — biggest wins
 * surface first per the upstream plan.
 *
 * Four lightweight follow-up queries fetch, for the set of merchants in
 * play: exact-match rules, up to three distinct sample memos each, each key's
 * total row count including already-filed rows, and the distinct categories
 * those filed rows carry. All four are `inArray()` over the group list rather
 * than per-group round trips, so the cost is five queries total regardless of
 * how many groups there are — which matters more than it did when this said "a
 * second query at 30–60 groups", since the real ledger currently carries
 * several times that many.
 */
export function loadMerchantGroups(db: Db): MerchantGroup[] {
  const rows = db
    .select({
      normalizedMerchant: schema.transactions.normalizedMerchant,
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .groupBy(schema.transactions.normalizedMerchant)
    .all();

  if (rows.length === 0) return [];

  const merchants = rows.map((r) => r.normalizedMerchant);
  const rules = db
    .select({
      merchant: schema.categoryRules.matchValue,
      categoryId: schema.categoryRules.categoryId,
      categoryName: schema.categories.name,
    })
    .from(schema.categoryRules)
    .innerJoin(
      schema.categories,
      eq(schema.categoryRules.categoryId, schema.categories.id),
    )
    .where(
      and(
        eq(schema.categoryRules.matchType, "exact"),
        inArray(schema.categoryRules.matchValue, merchants),
      ),
    )
    .all();

  const sampleMemosByMerchant = loadSampleMemos(db, merchants);
  const totalRowCountByMerchant = loadTotalRowCounts(db, merchants);
  const filedCategoriesByMerchant = loadFiledCategories(db, merchants);

  const ruleByMerchant = new Map<string, ExistingRule>();
  for (const rule of rules) {
    ruleByMerchant.set(rule.merchant, {
      categoryId: rule.categoryId,
      categoryName: rule.categoryName,
    });
  }

  const groups: MerchantGroup[] = rows.map((r) => ({
    normalizedMerchant: r.normalizedMerchant,
    count: Number(r.count),
    totalCents: Number(r.total),
    existingRule: ruleByMerchant.get(r.normalizedMerchant) ?? null,
    sampleMemos: sampleMemosByMerchant.get(r.normalizedMerchant) ?? [],
    // The `??` is unreachable, not a meaningful default: every merchant in
    // `rows` has at least one uncategorized non-transfer row, and
    // `loadTotalRowCounts` counts over the strictly weaker predicate (it
    // drops the `categoryId IS NULL` clause), so the map always has an entry.
    // Kept as a total-function guard rather than a `!`, but if it ever did
    // fire it would understate the number the drilldown link promises — "See
    // all 3 transactions" for a key with 50 — so it must not be read as a
    // sensible fallback.
    totalRowCount:
      totalRowCountByMerchant.get(r.normalizedMerchant) ?? Number(r.count),
    // Empty is the correct and common answer: a key nothing has been filed
    // under yet is trainable, so the absent-entry case is not a fallback.
    filedCategoryIds: filedCategoriesByMerchant.get(r.normalizedMerchant) ?? [],
  }));

  groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.normalizedMerchant.localeCompare(b.normalizedMerchant);
  });

  return groups;
}

/**
 * Distinct categories each merchant's ALREADY-FILED rows carry.
 *
 * Note the inverted category predicate: every other follow-up query here reads
 * the uncategorized backlog, and this one deliberately reads its complement —
 * the decisions already made are what say whether one rule can cover the key.
 * Transfer-paired rows stay excluded, matching `loadFiledCategoryIds`.
 */
function loadFiledCategories(db: Db, merchants: string[]): Map<string, number[]> {
  const rows = db
    .selectDistinct({
      normalizedMerchant: schema.transactions.normalizedMerchant,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(
      and(
        isNotNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
        inArray(schema.transactions.normalizedMerchant, merchants),
      ),
    )
    .all();

  const byMerchant = new Map<string, number[]>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    const existing = byMerchant.get(row.normalizedMerchant);
    if (existing === undefined) byMerchant.set(row.normalizedMerchant, [row.categoryId]);
    else existing.push(row.categoryId);
  }
  return byMerchant;
}

/**
 * Distinct, trimmed bank memos per merchant, capped at `MAX_SAMPLE_MEMOS`.
 *
 * The cap is applied in JS rather than SQL: this reads only the *distinct*
 * (merchant, memo) pairs among uncategorized rows — a few hundred short
 * strings on a real ledger, since the whole reason `/categorize` groups is
 * that these repeat — so a window function to push the cap into SQLite would
 * buy nothing and cost readability.
 *
 * `TRIM` matches the whitespace normalisation on the memo everywhere else it
 * is compared (rule 3): `parseCsv` preserves Star One's leading padding
 * verbatim because `import_row_hash` depends on the exact bytes, while the
 * SimpleFIN feed sends the same row already trimmed.
 */
function loadSampleMemos(db: Db, merchants: string[]): Map<string, string[]> {
  const rows = db
    .selectDistinct({
      normalizedMerchant: schema.transactions.normalizedMerchant,
      memo: sql<string>`TRIM(${schema.transactions.rawMemo})`.as("memo"),
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
        inArray(schema.transactions.normalizedMerchant, merchants),
        ne(sql`TRIM(${schema.transactions.rawMemo})`, ""),
        // The 9.8% of rows whose memo IS the key — see `sampleMemos`.
        sql`TRIM(${schema.transactions.rawMemo}) <> ${schema.transactions.normalizedMerchant}`,
      ),
    )
    .orderBy(schema.transactions.normalizedMerchant, sql`memo`)
    .all();

  const byMerchant = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byMerchant.get(row.normalizedMerchant);
    if (existing === undefined) {
      byMerchant.set(row.normalizedMerchant, [row.memo]);
    } else if (existing.length < MAX_SAMPLE_MEMOS) {
      existing.push(row.memo);
    }
  }
  return byMerchant;
}

/**
 * All non-transfer rows per merchant, filed or not — the number the drilldown
 * link promises. Excludes transfer-paired rows because `/transactions` does
 * too by default; counting them here would advertise a row count the
 * destination then does not show.
 */
function loadTotalRowCounts(db: Db, merchants: string[]): Map<string, number> {
  const rows = db
    .select({
      normalizedMerchant: schema.transactions.normalizedMerchant,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.transferPairId),
        inArray(schema.transactions.normalizedMerchant, merchants),
      ),
    )
    .groupBy(schema.transactions.normalizedMerchant)
    .all();
  return new Map(rows.map((r) => [r.normalizedMerchant, Number(r.count)]));
}
