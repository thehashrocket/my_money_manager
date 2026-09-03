import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { schema } from "@/db";
import type { CategoryRule } from "@/db/schema";

/**
 * Structural DB type — accepts both the singleton `better-sqlite3`
 * database and a transaction handle. Matches the pattern in
 * `src/lib/budget.ts`.
 */
type Db = BaseSQLiteDatabase<
  "sync",
  unknown,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Resolve a normalized merchant string to a category via the rules table.
 * Returns the winning rule's `category_id`, or `null` if no rule matches.
 *
 * Tie-breaker (plan Pass 7): ORDER BY priority DESC, updated_at DESC — the
 * most recently updated rule wins at equal priority.
 *
 * All match types resolve the same way: the rules table is read in full and
 * scanned in rank order (it stays small — dozens, maybe hundreds). There is no
 * SQL-equality fast path for exact matches.
 *
 * One-shot form. There are no production callers; both write paths use
 * `buildRuleMatcher` directly. Kept as the single-merchant convenience the
 * rule-matching tests are written against.
 */
export function applyRuleAtImport(
  db: Db,
  normalizedMerchant: string,
): number | null {
  return buildRuleMatcher(db)(normalizedMerchant);
}

/**
 * Read and rank the rules table once, then resolve many merchants against it.
 *
 * Use this over `applyRuleAtImport` inside an insert loop. The rules table is
 * small, but a 600-row backfill calling `applyRuleAtImport` per row would read
 * and re-sort all of it 600 times inside a single write transaction.
 *
 * The snapshot is taken when this is called, so a caller that trains a rule
 * mid-loop would not see it. Both current callers (`commitImport`,
 * `syncSimpleFin`) only insert, so there is nothing to invalidate.
 */
export function buildRuleMatcher(db: Db): (normalizedMerchant: string) => number | null {
  const sorted = db.select().from(schema.categoryRules).all().sort(compareRules);
  if (sorted.length === 0) return () => null;

  return (normalizedMerchant: string) => {
    for (const rule of sorted) {
      if (matches(rule, normalizedMerchant)) return rule.categoryId;
    }
    return null;
  };
}

/**
 * Upsert an exact-match rule for a given normalized merchant.
 *
 * Behavior:
 * - If no exact rule for this merchant exists, insert one.
 * - If one exists, update its `category_id` + `updated_at` (overwrite semantics
 *   per Pass 2 "Replace rule?" dialog).
 *
 * `priority` defaults to 50 (the explicit-intent tier used by the "Remember
 * for all [merchant]" checkbox). Auto-created rules from heuristics can pass
 * a lower value.
 */
export function createOrUpdateRule(
  db: Db,
  params: {
    normalizedMerchant: string;
    categoryId: number;
    source: "auto" | "manual";
    priority?: number;
  },
): CategoryRule {
  const { normalizedMerchant, categoryId, source, priority = 50 } = params;

  const [upserted] = db
    .insert(schema.categoryRules)
    .values({
      categoryId,
      matchType: "exact",
      matchValue: normalizedMerchant,
      priority,
      source,
    })
    .onConflictDoUpdate({
      target: [schema.categoryRules.matchType, schema.categoryRules.matchValue],
      set: { categoryId, priority, source, updatedAt: new Date() },
    })
    .returning()
    .all();
  return upserted;
}

function compareRules(a: CategoryRule, b: CategoryRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

function matches(rule: CategoryRule, merchant: string): boolean {
  switch (rule.matchType) {
    case "exact":
      return rule.matchValue === merchant;
    case "contains":
      return merchant.includes(rule.matchValue);
    case "regex":
      if (rule.matchValue.length > 200) return false;
      try {
        return new RegExp(rule.matchValue).test(merchant);
      } catch {
        return false;
      }
  }
}
