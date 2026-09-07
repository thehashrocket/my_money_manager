import { describe, it, expect } from "vitest";
import { planBackfill } from "./backfill-merchants.src.mjs";

/**
 * The planner decides which trained rule survives a collision, which is the one
 * thing in the backfill that can move money between envelopes. These tests use a
 * stub normalizer so each case pins a decision rather than a regex.
 */

const rule = (over) => ({
  id: 1,
  category_id: 10,
  match_type: "exact",
  match_value: "OLD",
  priority: 50,
  updated_at: 1000,
  // Joined in by the CLI from categories.archived_at. Null = live, which is
  // the default here so every pre-existing case keeps meaning what it did.
  category_archived_at: null,
  ...over,
});

const txn = (over) => ({ id: 1, raw_memo: "raw", normalized_merchant: "OLD", ...over });

describe("planBackfill — row rewrite", () => {
  it("only rewrites rows whose key actually changes", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "STALE" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "FRESH" }),
      ],
      rules: [],
      dismissals: [],
      normalize: (s) => (s === "a" ? "FRESH" : "FRESH"),
    });

    expect(plan.changedRows).toEqual([{ id: 1, next: "FRESH" }]);
    expect(plan.groupsBefore).toBe(2);
    expect(plan.groupsAfter).toBe(1);
  });

  it("reports keys that are not fixed points instead of assuming idempotence", () => {
    const plan = planBackfill({
      txns: [txn({ raw_memo: "x", normalized_merchant: "OLD" })],
      rules: [],
      dismissals: [],
      // "DRIFT" normalizes to "SETTLED", so the new key is not a fixed point.
      normalize: (s) => (s === "DRIFT" ? "SETTLED" : "DRIFT"),
    });

    expect(plan.drifting).toEqual(["DRIFT"]);
  });
});

describe("planBackfill — rule rewrite", () => {
  it("derives the new match_value from the rows, not from the rule's own value", () => {
    // The rule's stored value is an OLD key. Renormalizing it directly could
    // land somewhere else; joining through raw_memo is exact.
    const plan = planBackfill({
      txns: [txn({ id: 1, raw_memo: "memo", normalized_merchant: "TST*OLD KEY" })],
      rules: [rule({ id: 7, match_value: "TST*OLD KEY" })],
      dismissals: [],
      normalize: (s) => (s === "memo" ? "NEW KEY" : "SOMETHING ELSE"),
    });

    expect(plan.changedRules).toHaveLength(1);
    expect(plan.changedRules[0].next).toBe("NEW KEY");
  });

  it("falls back to renormalizing the rule's value when no row carries the key", () => {
    const plan = planBackfill({
      txns: [],
      rules: [rule({ id: 7, match_value: "ORPHAN" })],
      dismissals: [],
      normalize: (s) => `N(${s})`,
    });

    expect(plan.changedRules[0].next).toBe("N(ORPHAN)");
  });

  it("follows the largest group when an old key splits, and reports it", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "one", normalized_merchant: "GOOGLE" }),
        txn({ id: 2, raw_memo: "two", normalized_merchant: "GOOGLE" }),
        txn({ id: 3, raw_memo: "three", normalized_merchant: "GOOGLE" }),
      ],
      rules: [rule({ id: 7, match_value: "GOOGLE" })],
      dismissals: [],
      normalize: (s) => (s === "three" ? "YOUTUBEPREM" : "GOOGLE ONE"),
    });

    expect(plan.changedRules[0].next).toBe("GOOGLE ONE");
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].ranked[0]).toEqual(["GOOGLE ONE", 2]);
  });

  it("leaves a rule alone when its value does not move", () => {
    const plan = planBackfill({
      txns: [txn({ raw_memo: "m", normalized_merchant: "SAME" })],
      rules: [rule({ match_value: "SAME" })],
      dismissals: [],
      normalize: () => "SAME",
    });

    expect(plan.changedRules).toHaveLength(0);
  });

  it("ignores contains and regex rules — their value is not a normalized key", () => {
    const plan = planBackfill({
      txns: [txn({ raw_memo: "m", normalized_merchant: "OLD" })],
      rules: [
        rule({ id: 1, match_type: "contains", match_value: "AMAZON PRIME" }),
        rule({ id: 2, match_type: "regex", match_value: "^AMZ" }),
      ],
      dismissals: [],
      normalize: () => "NEW",
    });

    expect(plan.exactRuleCount).toBe(0);
    expect(plan.changedRules).toHaveLength(0);
  });
});

describe("planBackfill — collisions", () => {
  it("keeps the most recently updated rule, matching compareRules at runtime", () => {
    // The original plan said "highest priority, then LOWEST id", which resolves
    // to the OLDEST rule and silently reverts the user's latest training.
    // src/lib/rules.ts compareRules orders by priority DESC, updated_at DESC.
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "JACK 430" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "JACK 342" }),
      ],
      rules: [
        rule({ id: 41, match_value: "JACK 430", category_id: 10, updated_at: 1000 }),
        rule({ id: 77, match_value: "JACK 342", category_id: 20, updated_at: 9000 }),
      ],
      dismissals: [],
      normalize: () => "JACK IN THE BOX",
    });

    expect(plan.collisions).toHaveLength(1);
    const [collision] = plan.collisions;
    expect(collision.ranked[0].rule.id).toBe(77);
    expect(collision.ranked[0].rule.category_id).toBe(20);
    expect(plan.losingRuleIds).toEqual(new Set([41]));
  });

  it("prefers priority over recency", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "A" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "B" }),
      ],
      rules: [
        rule({ id: 1, match_value: "A", priority: 90, updated_at: 1 }),
        rule({ id: 2, match_value: "B", priority: 50, updated_at: 9999 }),
      ],
      dismissals: [],
      normalize: () => "MERGED",
    });

    expect(plan.collisions[0].ranked[0].rule.id).toBe(1);
  });

  it("flags a collision whose rules disagree about the category", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "A" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "B" }),
      ],
      rules: [
        rule({ id: 1, match_value: "A", category_id: 10 }),
        rule({ id: 2, match_value: "B", category_id: 20 }),
      ],
      dismissals: [],
      normalize: () => "MERGED",
    });

    expect(plan.collisions[0].conflicting).toBe(true);
  });

  it("does not flag a collision whose rules agree — nothing moves", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "A" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "B" }),
      ],
      rules: [
        rule({ id: 1, match_value: "A", category_id: 10 }),
        rule({ id: 2, match_value: "B", category_id: 10 }),
      ],
      dismissals: [],
      normalize: () => "MERGED",
    });

    expect(plan.collisions[0].conflicting).toBe(false);
  });

  it("never lists a losing rule as one to rewrite — it is deleted instead", () => {
    // Rewriting a loser would collide with the survivor on the unique index.
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "A" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "B" }),
      ],
      rules: [
        rule({ id: 1, match_value: "A", updated_at: 1 }),
        rule({ id: 2, match_value: "B", updated_at: 2 }),
      ],
      dismissals: [],
      normalize: () => "MERGED",
    });

    const rewrittenIds = plan.changedRules.map((r) => r.rule.id);
    expect(rewrittenIds).toEqual([2]);
    expect(plan.losingRuleIds.has(1)).toBe(true);
    for (const id of plan.losingRuleIds) expect(rewrittenIds).not.toContain(id);
  });
});

describe("planBackfill — subscription dismissals", () => {
  it("rewrites a dismissal so it does not resurrect as an active subscription", () => {
    const plan = planBackfill({
      txns: [txn({ id: 1, raw_memo: "m", normalized_merchant: "GOOGLE *GOOGLE ONE" })],
      rules: [],
      dismissals: [{ id: 1, normalized_merchant: "GOOGLE *GOOGLE ONE", dismissed_at: 5 }],
      normalize: () => "GOOGLE ONE",
    });

    expect(plan.dismissalPlan).toEqual([
      { id: 1, from: "GOOGLE *GOOGLE ONE", next: "GOOGLE ONE", action: "update" },
    ]);
  });

  it("keeps the oldest dismissal when two collapse onto one key", () => {
    // subscription_dismissals_merchant_unique makes this a constraint, not a
    // preference; the earliest deliberate dismissal is the one preserved.
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "A" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "B" }),
      ],
      rules: [],
      dismissals: [
        { id: 2, normalized_merchant: "B", dismissed_at: 900 },
        { id: 1, normalized_merchant: "A", dismissed_at: 100 },
      ],
      normalize: () => "MERGED",
    });

    const kept = plan.dismissalPlan.filter((d) => d.action !== "delete");
    const dropped = plan.dismissalPlan.filter((d) => d.action === "delete");
    expect(kept.map((d) => d.id)).toEqual([1]);
    expect(dropped.map((d) => d.id)).toEqual([2]);
  });

  it("leaves an already-correct dismissal untouched", () => {
    const plan = planBackfill({
      txns: [txn({ raw_memo: "m", normalized_merchant: "STABLE" })],
      rules: [],
      dismissals: [{ id: 1, normalized_merchant: "STABLE", dismissed_at: 1 }],
      normalize: () => "STABLE",
    });

    expect(plan.dismissalPlan[0].action).toBe("keep");
  });
});

describe("planBackfill — collisions with an archived category", () => {
  /**
   * buildRuleMatcher is a sort AND a skip filter (src/lib/rules.ts): a rule
   * whose category is archived never fires, because rule 8 makes archiving
   * inert rather than deleting. Replicating only the sort meant an archived
   * rule could outrank the live one, win the collision, and get the live rule
   * DELETED -- leaving the merchant with no effective rule at all, which is
   * worse than either state the backfill started from.
   */
  it("ranks a live rule above an archived one that outranks it on every other key", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "JACK 430" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "JACK 342" }),
      ],
      rules: [
        // Higher priority AND more recently updated -- would win outright on
        // compareRules alone.
        rule({
          id: 41,
          match_value: "JACK 430",
          category_id: 10,
          priority: 99,
          updated_at: 9000,
          category_archived_at: 1700000000,
        }),
        rule({
          id: 77,
          match_value: "JACK 342",
          category_id: 20,
          priority: 0,
          updated_at: 1000,
          category_archived_at: null,
        }),
      ],
      dismissals: [],
      normalize: () => "JACK IN THE BOX",
    });

    const [collision] = plan.collisions;
    expect(collision.ranked[0].rule.id).toBe(77);
    expect(plan.losingRuleIds).toEqual(new Set([41]));
  });

  it("still uses compareRules order when both categories are archived", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "JACK 430" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "JACK 342" }),
      ],
      rules: [
        rule({ id: 41, match_value: "JACK 430", updated_at: 1000, category_archived_at: 1 }),
        rule({ id: 77, match_value: "JACK 342", updated_at: 9000, category_archived_at: 1 }),
      ],
      dismissals: [],
      normalize: () => "JACK IN THE BOX",
    });

    expect(plan.collisions[0].ranked[0].rule.id).toBe(77);
  });
});

describe("planBackfill — contains/regex rule reach", () => {
  /**
   * These rules can never be rewritten (a substring is not a key), so the only
   * thing the backfill can do about them is SAY what the normalizer change cost
   * them. Rule 10 calls a dead `contains` rule the one permanently unrepairable
   * damage class; AMAZON PRIME and GOOGLE ONE were each one edit from it.
   */
  it("reports a contains rule whose reach drops to zero", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "AMAZON PRIME" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "AMAZON PRIME" }),
      ],
      rules: [rule({ id: 5, match_type: "contains", match_value: "PRIME" })],
      dismissals: [],
      normalize: () => "AMAZON",
    });

    expect(plan.nonExactRuleCount).toBe(1);
    expect(plan.reachChanges).toHaveLength(1);
    expect(plan.reachChanges[0]).toMatchObject({ before: 2, after: 0 });
    // Never rewritten, and never a collision candidate.
    expect(plan.changedRules).toHaveLength(0);
    expect(plan.losingRuleIds).toEqual(new Set());
  });

  it("stays silent when a contains rule keeps its reach", () => {
    const plan = planBackfill({
      txns: [txn({ id: 1, raw_memo: "a", normalized_merchant: "AMAZON PRIME XYZ" })],
      rules: [rule({ id: 5, match_type: "contains", match_value: "PRIME" })],
      dismissals: [],
      normalize: () => "AMAZON PRIME",
    });

    expect(plan.reachChanges).toEqual([]);
  });

  it("reports a reach INCREASE too, since a merge can over-apply a rule", () => {
    const plan = planBackfill({
      txns: [
        txn({ id: 1, raw_memo: "a", normalized_merchant: "COSTCO" }),
        txn({ id: 2, raw_memo: "b", normalized_merchant: "SAFEWAY" }),
      ],
      rules: [rule({ id: 5, match_type: "contains", match_value: "GROCER" })],
      dismissals: [],
      normalize: () => "GROCERY RUN",
    });

    expect(plan.reachChanges[0]).toMatchObject({ before: 0, after: 2 });
  });

  it("treats an invalid regex as matching nothing rather than throwing", () => {
    const plan = planBackfill({
      txns: [txn({ id: 1, raw_memo: "a", normalized_merchant: "OLD" })],
      rules: [rule({ id: 5, match_type: "regex", match_value: "([unclosed" })],
      dismissals: [],
      normalize: () => "NEW",
    });

    expect(plan.reachChanges).toEqual([]);
  });
});
