import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type ExistingRule = {
  categoryId: number;
  categoryName: string;
};

export type MerchantGroup = {
  normalizedMerchant: string;
  count: number;
  /** Signed sum of `amount_cents` for NULL-category rows in the group. */
  totalCents: number;
  /** Exact-match manual/auto rule currently targeting this merchant, if any. */
  existingRule: ExistingRule | null;
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
  }));

  groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.normalizedMerchant.localeCompare(b.normalizedMerchant);
  });

  return groups;
}
