import { eq } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import type { CategoryRule } from "@/db/schema";

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
  db: AnyDb,
  normalizedMerchant: string,
  amountCents: number,
): number | null {
  return buildRuleMatcher(db)(normalizedMerchant, amountCents)?.categoryId ?? null;
}

export type RuleMatch = { categoryId: number; ruleId: number };

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
 *
 * Returns the winning rule's id alongside its category, not just the
 * category: both write paths record it onto `import_batch_categorizations` so
 * the batch's auto-categorization can be undone later.
 *
 * The returned matcher also takes the row's `amountCents` (X2 + E8): a rule
 * must not file a negative row into a `kind='income'` category, or a
 * positive row into a `kind='fund'` category — either one "poisons" that
 * category's numbers for every future occurrence of the merchant (B8). The
 * guard joins `categories` in the same query this function already reads
 * once per batch, rather than adding a second `categories` read at each call
 * site. A rejected candidate is skipped, not fatal to the whole match:
 * matching continues to the next-ranked rule.
 *
 * X3 (PR2b): the same join now also carries `archivedAt`, and an archived
 * category's rules are skipped the same way a sign-mismatched one is —
 * without this, an archived category kept silently absorbing every newly
 * imported transaction that matched its trained rules (B6), which is the
 * opposite of what archiving is supposed to do.
 */
export function buildRuleMatcher(
  db: AnyDb,
): (normalizedMerchant: string, amountCents: number) => RuleMatch | null {
  const sorted = db
    .select({
      rule: schema.categoryRules,
      categoryKind: schema.categories.kind,
      categoryArchivedAt: schema.categories.archivedAt,
    })
    .from(schema.categoryRules)
    .innerJoin(schema.categories, eq(schema.categoryRules.categoryId, schema.categories.id))
    .all()
    .sort((a, b) => compareRules(a.rule, b.rule));
  if (sorted.length === 0) return () => null;

  return (normalizedMerchant: string, amountCents: number) => {
    for (const { rule, categoryKind, categoryArchivedAt } of sorted) {
      if (!matches(rule, normalizedMerchant)) continue;
      if (categoryArchivedAt !== null) continue;
      if (categoryKind === "income" && amountCents < 0) continue;
      if (categoryKind === "fund" && amountCents > 0) continue;
      return { categoryId: rule.categoryId, ruleId: rule.id };
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
  db: AnyDb,
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
