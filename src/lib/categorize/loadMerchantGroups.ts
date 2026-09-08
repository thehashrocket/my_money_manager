import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
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
 * A second lightweight query fetches exact-match rules for the set of
 * merchants in play; at 30–60 groups this is negligible and keeps the grouping
 * query simple. See test plan — pre-fetch optimization is W5 scope.
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
    totalRowCount:
      totalRowCountByMerchant.get(r.normalizedMerchant) ?? Number(r.count),
  }));

  groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.normalizedMerchant.localeCompare(b.normalizedMerchant);
  });

  return groups;
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
