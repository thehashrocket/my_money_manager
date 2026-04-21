import { eq } from "drizzle-orm";
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
 * Exact matches take the fast path via SQL equality; `contains` and `regex`
 * rules fall back to an in-memory scan (the rules table stays small — dozens,
 * maybe hundreds — and this only runs at import + explicit categorize time).
 */
export function applyRuleAtImport(
  db: Db,
  normalizedMerchant: string,
): number | null {
  const all = db
    .select()
    .from(schema.categoryRules)
    .all();
  if (all.length === 0) return null;

  const sorted = [...all].sort(compareRules);

  for (const rule of sorted) {
    if (matches(rule, normalizedMerchant)) return rule.categoryId;
  }
  return null;
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
