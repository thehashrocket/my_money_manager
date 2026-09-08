import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { applyRuleWrite } from "./applyRuleWrite";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedAccount() {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: `Checking-${seq}`,
      type: "checking",
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
    })
    .returning()
    .all();
  return row;
}

function seedBatch() {
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  return row;
}

function seedCategory(name: string) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: null,
      isSavingsGoal: false,
      kind: "expense",
      carryoverPolicy: "none",
      archivedAt: null,
    })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant: string;
  categoryId?: number | null;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant,
      amountCents: -1200,
      categoryId: opts.categoryId ?? null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: null,
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

function seedRule(matchValue: string, categoryId: number) {
  const [row] = handle.db
    .insert(schema.categoryRules)
    .values({
      categoryId,
      matchType: "exact",
      matchValue,
      priority: 50,
      source: "manual",
    })
    .returning()
    .all();
  return row;
}

/**
 * EXACT rules only. `drizzle/0006_subscription_rules.sql` seeds `contains` rules
 * on real subscription keys (`NETFLIX` among them) into every migrated database,
 * so an unfiltered lookup here counts a row this code must never touch — and
 * `rulesFor("NETFLIX").toHaveLength(0)` failed for that reason before this
 * filter existed, which is a fair warning about the shape of the live data.
 */
function rulesFor(matchValue: string) {
  return handle.db
    .select()
    .from(schema.categoryRules)
    .where(
      and(
        eq(schema.categoryRules.matchType, "exact"),
        eq(schema.categoryRules.matchValue, matchValue),
      ),
    )
    .all();
}

/** Any rule for the value, whatever its match type. */
function allRulesFor(matchValue: string) {
  return handle.db
    .select()
    .from(schema.categoryRules)
    .where(eq(schema.categoryRules.matchValue, matchValue))
    .all();
}

describe("applyRuleWrite — the removal opt-in", () => {
  it("removes NOTHING by default, even on a refusal that contradicts the rule", () => {
    /* The default is the whole safety property. `/subscriptions` calls
       `bulkCategorize` with `rememberMerchant: true` and no per-merchant intent
       at all — "Categorize all" loops every detected subscription — and
       `loadSubscriptions` does not filter on `category_id`, so a merchant that
       is already filed under a working rule is still on that list. With removal
       on by default one click deleted a rule per such merchant, unrecoverably:
       that page has no undo and its actions used to return `void`. */
    const a = seedAccount();
    const b = seedBatch();
    const entertainment = seedCategory("Entertainment");
    const subscriptions = seedCategory("Subscriptions");
    const rule = seedRule("NETFLIX", entertainment.id);
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "NETFLIX",
      categoryId: entertainment.id,
    });

    const outcome = applyRuleWrite(handle.db, {
      normalizedMerchant: "NETFLIX",
      categoryId: subscriptions.id,
      rememberMerchant: true,
    });

    expect(outcome.ruleRefusal?.reason).toBe("multi-category");
    expect(outcome.ruleRefusal?.removedRule).toBeNull();
    expect(outcome.ruleTouched).toBe(false);
    expect(outcome.priorRule).toBeNull();
    // Still there, still pointing where it did.
    expect(rulesFor("NETFLIX")).toHaveLength(1);
    expect(rulesFor("NETFLIX")[0]?.id).toBe(rule.id);
    expect(rulesFor("NETFLIX")[0]?.categoryId).toBe(entertainment.id);
  });

  it("removes the rule when the caller opts in and the pick contradicts it", () => {
    const a = seedAccount();
    const b = seedBatch();
    const entertainment = seedCategory("Entertainment");
    const subscriptions = seedCategory("Subscriptions");
    seedRule("NETFLIX", entertainment.id);
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "NETFLIX",
      categoryId: entertainment.id,
    });

    const outcome = applyRuleWrite(handle.db, {
      normalizedMerchant: "NETFLIX",
      categoryId: subscriptions.id,
      rememberMerchant: true,
      allowRuleRemoval: true,
    });

    expect(outcome.ruleRefusal?.removedRule?.categoryId).toBe(entertainment.id);
    expect(outcome.priorRule?.categoryId).toBe(entertainment.id);
    expect(outcome.ruleTouched).toBe(true);
    expect(outcome.insertedRuleId).toBeNull();
    expect(rulesFor("NETFLIX")).toHaveLength(0);
    /* And the `contains` rule migration 0006 seeds on this same value is
       untouched. A refusal removes ONE exact rule, never everything keyed on the
       string — rule 10 calls a `contains` rule unrepairable by any backfill, so
       collateral damage here would be permanent. */
    const survivors = allRulesFor("NETFLIX");
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.matchType).toBe("contains");
  });
});

describe("applyRuleWrite — a refusal that CONFIRMS the existing rule", () => {
  it("keeps the rule when the pick is where the rule already points", () => {
    /* The key really is split, so the refusal is right — but the rule pointed
       exactly where the user just pointed, and deleting it left every future
       row for the key uncategorized. Nothing about ticking Remember on the
       category a rule already targets asks for that rule to go. */
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    seedRule("COSTCO WHSE", groceries.id);
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO WHSE",
      categoryId: groceries.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO WHSE",
      categoryId: dining.id,
    });

    const outcome = applyRuleWrite(handle.db, {
      normalizedMerchant: "COSTCO WHSE",
      categoryId: groceries.id,
      rememberMerchant: true,
      allowRuleRemoval: true,
    });

    // The refusal still stands and is still reported — only the removal is off.
    expect(outcome.ruleRefusal?.reason).toBe("multi-category");
    expect(outcome.ruleRefusal?.removedRule).toBeNull();
    expect(outcome.ruleTouched).toBe(false);
    expect(rulesFor("COSTCO WHSE")).toHaveLength(1);
    expect(rulesFor("COSTCO WHSE")[0]?.categoryId).toBe(groceries.id);
  });

  it("removes a LOSSY key's rule even when the pick agrees with it", () => {
    // The asymmetry between the two refusal reasons. A lossy key cannot back a
    // correct rule pointing anywhere, so "it points where you picked" is not a
    // reason to keep it — unlike the multi-category case, where the rule may
    // still be the right answer for most of the key's rows.
    const misc = seedCategory("Misc");
    seedRule("ONLINE", misc.id);

    const outcome = applyRuleWrite(handle.db, {
      normalizedMerchant: "ONLINE",
      categoryId: misc.id,
      rememberMerchant: true,
      allowRuleRemoval: true,
    });

    expect(outcome.ruleRefusal?.reason).toBe("lossy-key");
    expect(outcome.ruleRefusal?.removedRule?.categoryId).toBe(misc.id);
    expect(rulesFor("ONLINE")).toHaveLength(0);
  });
});

describe("applyRuleWrite — the trainable path", () => {
  it("reports insertedRuleId when there was no prior rule", () => {
    const groceries = seedCategory("Groceries");
    const outcome = applyRuleWrite(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(outcome.ruleRefusal).toBeNull();
    expect(outcome.priorRule).toBeNull();
    expect(outcome.insertedRuleId).toBe(rulesFor("SAFEWAY")[0]?.id);
    expect(outcome.ruleTouched).toBe(true);
  });

  it("reports priorRule and NOT insertedRuleId when it overwrote one", () => {
    // The two are mutually exclusive by construction, and the undo branches on
    // exactly that: a prior row means restore it, no prior row means delete
    // what we inserted.
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const rule = seedRule("SAFEWAY", groceries.id);

    const outcome = applyRuleWrite(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: household.id,
      rememberMerchant: true,
    });

    expect(outcome.priorRule?.id).toBe(rule.id);
    expect(outcome.priorRule?.categoryId).toBe(groceries.id);
    expect(outcome.insertedRuleId).toBeNull();
    expect(rulesFor("SAFEWAY")[0]?.categoryId).toBe(household.id);
  });

  it("does nothing at all when Remember was not ticked", () => {
    const groceries = seedCategory("Groceries");
    const outcome = applyRuleWrite(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(outcome).toEqual({
      ruleTouched: false,
      priorRule: null,
      insertedRuleId: null,
      ruleRefusal: null,
    });
    expect(rulesFor("SAFEWAY")).toHaveLength(0);
  });
});

describe("applyRuleWrite — excludeTxnIds", () => {
  it("ignores the row the caller is about to retarget", () => {
    /* The key's ONLY filed row is the one being moved, so after the action the
       key is unanimously Dining and one rule IS right. Counting the row's
       current category refused on a category that will not exist for this key
       once the caller's UPDATE lands. */
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "JACK IN THE BOX",
      categoryId: groceries.id,
    });

    expect(
      applyRuleWrite(handle.db, {
        normalizedMerchant: "JACK IN THE BOX",
        categoryId: dining.id,
        rememberMerchant: true,
        excludeTxnIds: [target.id],
      }).ruleRefusal,
    ).toBeNull();

    // Without the exclusion the same call refuses — this is the whole delta.
    expect(
      applyRuleWrite(handle.db, {
        normalizedMerchant: "JACK IN THE BOX",
        categoryId: dining.id,
        rememberMerchant: true,
      }).ruleRefusal?.reason,
    ).toBe("multi-category");
  });

  it("does NOT swallow other rows' evidence along with the target", () => {
    // The exclusion has to be exactly the rows being written. A second filed
    // row genuinely disagrees with the pick, so the refusal must stand.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "JACK IN THE BOX",
      categoryId: groceries.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "JACK IN THE BOX",
      categoryId: groceries.id,
    });

    expect(
      applyRuleWrite(handle.db, {
        normalizedMerchant: "JACK IN THE BOX",
        categoryId: dining.id,
        rememberMerchant: true,
        excludeTxnIds: [target.id],
      }).ruleRefusal?.reason,
    ).toBe("multi-category");
  });
});
