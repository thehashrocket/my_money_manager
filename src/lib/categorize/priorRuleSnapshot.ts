import type { CategoryRule } from "@/db/schema";

/**
 * Exact snapshot of the `category_rules` row that existed BEFORE a categorize
 * call touched it. All user-owned columns are captured, so an undo can put the
 * row back verbatim — see `restorePriorRule`, which is the only consumer that
 * writes it back.
 *
 * Lives here rather than in `bulkCategorize.ts` (its original home) because
 * `categorizeTransaction`, `restorePriorRule` and both snapshot validators all
 * need it: the undo path was type-depending on a write path to get it.
 */
export type PriorRuleSnapshot = {
  id: number;
  /**
   * Always `"exact"`, and narrowed rather than merely commented.
   *
   * The only producers are `readExactRule`/`deleteExactRule`, both filtered on
   * it. The width mattered because this snapshot crosses to the client and
   * comes back for Undo, and `restorePriorRule` INSERTs it verbatim — a wide
   * enum let a crafted payload restore `{matchType: "regex", matchValue: ".*"}`
   * as a catch-all rule at an arbitrary id. Narrowing costs nothing and states
   * the truth; both zod schemas mirror it with `z.literal`.
   */
  matchType: "exact";
  categoryId: number;
  matchValue: string;
  priority: number;
  source: "auto" | "manual";
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Narrow a `category_rules` row to the columns an undo restores. Both write
 * paths and the refusal deletion build the same shape; spelling it out three
 * times is how one of them ends up missing a column.
 *
 * Throws on a non-exact row rather than widening the type. Nothing can reach
 * that — the callers only ever hand over a row from `readExactRule` or
 * `deleteExactRule` — so this is the invariant asserting itself at the one
 * place it could ever be broken, not a case to handle.
 */
export function toPriorRuleSnapshot(rule: CategoryRule): PriorRuleSnapshot {
  if (rule.matchType !== "exact") {
    throw new Error(
      `toPriorRuleSnapshot: expected an exact rule, got ${rule.matchType} (rule ${rule.id})`,
    );
  }
  return {
    id: rule.id,
    matchType: rule.matchType,
    categoryId: rule.categoryId,
    matchValue: rule.matchValue,
    priority: rule.priority,
    source: rule.source,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}
