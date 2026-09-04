import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { applyRuleAtImport, buildRuleMatcher, createOrUpdateRule } from "./rules";
import { createTestDb, type TestDbHandle } from "./test/db";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let categoryNameCounter = 0;
function seedCategory(name: string, kind: "income" | "expense" | "fund" = "expense") {
  categoryNameCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-test-${categoryNameCounter}`, kind })
    .returning()
    .all();
  return cat;
}

describe("applyRuleAtImport", () => {
  it("returns null when no rules exist", () => {
    expect(applyRuleAtImport(handle.db, "SAFEWAY", -1000)).toBeNull();
  });

  it("matches an exact rule", () => {
    const groceries = seedCategory("Groceries");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });
    expect(applyRuleAtImport(handle.db, "SAFEWAY", -1000)).toBe(groceries.id);
    expect(applyRuleAtImport(handle.db, "TRADER JOES", -1000)).toBeNull();
  });

  it("matches a contains rule", () => {
    const gas = seedCategory("Gas");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: gas.id,
        matchType: "contains",
        matchValue: "SHELL",
        priority: 50,
        source: "manual",
      })
      .run();
    expect(applyRuleAtImport(handle.db, "SHELL OIL 1234", -1000)).toBe(gas.id);
    expect(applyRuleAtImport(handle.db, "CHEVRON", -1000)).toBeNull();
  });

  it("matches a regex rule", () => {
    const dining = seedCategory("Dining");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "regex",
        matchValue: "^DOORDASH|UBEREATS$",
        priority: 50,
        source: "auto",
      })
      .run();
    expect(applyRuleAtImport(handle.db, "DOORDASH CHIPOTLE", -1000)).toBe(dining.id);
    expect(applyRuleAtImport(handle.db, "UBEREATS", -1000)).toBe(dining.id);
    expect(applyRuleAtImport(handle.db, "UBER", -1000)).toBeNull();
  });

  it("regex patterns over 200 characters are treated as non-matching without throwing", () => {
    const misc = seedCategory("Misc");
    const longPattern = "a".repeat(201);
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: misc.id,
        matchType: "regex",
        matchValue: longPattern,
        priority: 99,
        source: "auto",
      })
      .run();
    expect(() => applyRuleAtImport(handle.db, "aaaaaaa", -1000)).not.toThrow();
    expect(applyRuleAtImport(handle.db, "aaaaaaa", -1000)).toBeNull();
  });

  it("invalid regex patterns do not throw — they just never match", () => {
    const misc = seedCategory("Misc");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: misc.id,
        matchType: "regex",
        matchValue: "[unterminated",
        priority: 99,
        source: "auto",
      })
      .run();
    expect(() => applyRuleAtImport(handle.db, "anything", -1000)).not.toThrow();
    expect(applyRuleAtImport(handle.db, "anything", -1000)).toBeNull();
  });

  it("higher priority wins over lower priority", () => {
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    handle.db
      .insert(schema.categoryRules)
      .values([
        {
          categoryId: groceries.id,
          matchType: "contains",
          matchValue: "SAFE",
          priority: 10,
          source: "auto",
        },
        {
          categoryId: household.id,
          matchType: "contains",
          matchValue: "SAFEWAY",
          priority: 99,
          source: "manual",
        },
      ])
      .run();
    expect(applyRuleAtImport(handle.db, "SAFEWAY", -1000)).toBe(household.id);
  });

  it("most recently updated wins at equal priority", async () => {
    const a = seedCategory("A");
    const b = seedCategory("B");

    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: a.id,
        matchType: "contains",
        matchValue: "SAFE",
        priority: 50,
        source: "auto",
      })
      .run();

    // Ensure updatedAt differs by at least one second (unixepoch resolution).
    await new Promise((r) => setTimeout(r, 1100));

    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: b.id,
        matchType: "contains",
        matchValue: "SAFEWAY",
        priority: 50,
        source: "manual",
      })
      .run();

    // Both "SAFE" and "SAFEWAY" match via contains; equal priority → newer wins.
    expect(applyRuleAtImport(handle.db, "SAFEWAY", -1000)).toBe(b.id);
  });

  it("exact match wins over contains when priority is higher", () => {
    const exactCat = seedCategory("Exact");
    const containsCat = seedCategory("Contains");
    handle.db
      .insert(schema.categoryRules)
      .values([
        {
          categoryId: containsCat.id,
          matchType: "contains",
          matchValue: "SAFE",
          priority: 10,
          source: "auto",
        },
        {
          categoryId: exactCat.id,
          matchType: "exact",
          matchValue: "SAFEWAY",
          priority: 50,
          source: "manual",
        },
      ])
      .run();
    expect(applyRuleAtImport(handle.db, "SAFEWAY", -1000)).toBe(exactCat.id);
  });
});

describe("createOrUpdateRule", () => {
  it("inserts a new rule when none exists", () => {
    const cat = seedCategory("Groceries");
    const rule = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: cat.id,
      source: "manual",
    });
    expect(rule.matchType).toBe("exact");
    expect(rule.matchValue).toBe("SAFEWAY");
    expect(rule.categoryId).toBe(cat.id);
    expect(rule.priority).toBe(50);
    expect(rule.source).toBe("manual");

    const count = handle.db.select().from(schema.categoryRules).where(eq(schema.categoryRules.matchType, "exact")).all().length;
    expect(count).toBe(1);
  });

  it("defaults priority to 50 (explicit-intent tier)", () => {
    const cat = seedCategory("Groceries");
    const rule = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: cat.id,
      source: "manual",
    });
    expect(rule.priority).toBe(50);
  });

  it("respects an explicit priority override", () => {
    const cat = seedCategory("Groceries");
    const rule = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: cat.id,
      source: "auto",
      priority: 10,
    });
    expect(rule.priority).toBe(10);
  });

  it("overwrites the existing exact rule instead of duplicating", () => {
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");

    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });
    const updated = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: household.id,
      source: "manual",
    });

    const rows = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.matchValue, "SAFEWAY"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].categoryId).toBe(household.id);
    expect(updated.id).toBe(rows[0].id);
  });

  it("does not collide with contains/regex rules on the same match_value", () => {
    const exactCat = seedCategory("Exact");
    const containsCat = seedCategory("Contains");

    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: containsCat.id,
        matchType: "contains",
        matchValue: "SAFEWAY",
        priority: 10,
        source: "auto",
      })
      .run();

    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: exactCat.id,
      source: "manual",
    });

    const rows = handle.db.select().from(schema.categoryRules).where(eq(schema.categoryRules.matchValue, "SAFEWAY")).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.matchType === "exact")).toBe(true);
    expect(rows.some((r) => r.matchType === "contains")).toBe(true);
  });
});

// `buildRuleMatcher` is the form both write paths actually call (commitImport
// and syncSimpleFin); `applyRuleAtImport` is now a one-shot wrapper around it.
// Its whole reason to exist is reading and ranking the rules table once per
// batch instead of once per row, so that — and the snapshot semantics it
// implies — is what these pin.
describe("buildRuleMatcher", () => {
  it("returns a matcher that resolves null when the rules table is empty", () => {
    const match = buildRuleMatcher(handle.db);
    expect(match("SAFEWAY", -1000)).toBeNull();
    expect(match("", -1000)).toBeNull();
  });

  it("reads the rules table once no matter how many merchants it resolves", () => {
    const groceries = seedCategory("Groceries");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });

    const selectSpy = vi.spyOn(handle.db, "select");
    const match = buildRuleMatcher(handle.db);
    expect(selectSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 50; i++) match(i % 2 === 0 ? "SAFEWAY" : "TRADER JOES", -1000);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    selectSpy.mockRestore();
  });

  // The snapshot is taken when the matcher is built. Documented as safe only
  // because both callers exclusively insert — pinned so a caller that later
  // trains a rule mid-batch fails here rather than silently mis-categorizing.
  it("does not see a rule trained after the matcher was built", () => {
    const groceries = seedCategory("Groceries");
    const match = buildRuleMatcher(handle.db);

    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });

    expect(match("SAFEWAY", -1000)).toBeNull();
    expect(applyRuleAtImport(handle.db, "SAFEWAY", -1000)).toBe(groceries.id);
  });

  // Ranking must be identical to the wrapper's — a batch import and a one-off
  // categorize resolving the same merchant to different categories would be
  // invisible until the numbers stopped adding up.
  it("ranks by priority then recency, identically to applyRuleAtImport", () => {
    const low = seedCategory("Low");
    const high = seedCategory("High");
    handle.db
      .insert(schema.categoryRules)
      .values([
        {
          categoryId: low.id,
          matchType: "contains",
          matchValue: "SAFE",
          priority: 10,
          source: "auto",
        },
        {
          categoryId: high.id,
          matchType: "exact",
          matchValue: "SAFEWAY",
          priority: 90,
          source: "manual",
        },
      ])
      .run();

    const match = buildRuleMatcher(handle.db);
    expect(match("SAFEWAY", -1000)?.categoryId).toBe(high.id);
    expect(match("SAFEWAY", -1000)?.categoryId).toBe(applyRuleAtImport(handle.db, "SAFEWAY", -1000));
    // Only the lower-priority `contains` rule reaches this one.
    expect(match("SAFEHOUSE", -1000)?.categoryId).toBe(low.id);
  });

  // `import_batch_categorizations` records this alongside `categoryId` so a
  // batch's auto-categorization can be undone later (undoImportCategorization).
  it("returns the matched rule's id alongside its category", () => {
    const groceries = seedCategory("Groceries");
    const rule = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("SAFEWAY", -1000)).toEqual({ categoryId: groceries.id, ruleId: rule.id });
  });
});

// TC32 (X2 + E8): a rule must not file a sign-mismatched row into income or
// a fund. Moved here from wherever it would otherwise have lived, because
// this is the only module whose matcher actually sees a sign.
describe("buildRuleMatcher — sign guard (TC32, X2 + E8)", () => {
  it("skips a match into a kind='income' category for a negative row", () => {
    const paycheck = seedCategory("Paycheck", "income");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "EMPLOYER",
      categoryId: paycheck.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("EMPLOYER", -5000)).toBeNull(); // a charge, not a paycheck
  });

  it("allows a match into a kind='income' category for a positive row", () => {
    const paycheck = seedCategory("Paycheck", "income");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "EMPLOYER",
      categoryId: paycheck.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("EMPLOYER", 200000)?.categoryId).toBe(paycheck.id);
  });

  it("skips a match into a kind='fund' category for a positive row", () => {
    const fund = seedCategory("Car Repair", "fund");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "TRANSFER",
      categoryId: fund.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("TRANSFER", 10000)).toBeNull();
  });

  it("allows a match into a kind='fund' category for a negative row (a withdrawal)", () => {
    const fund = seedCategory("Car Repair", "fund");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "MECHANIC",
      categoryId: fund.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("MECHANIC", -30000)?.categoryId).toBe(fund.id);
  });

  it("a zero-amount row is not blocked by either sign guard (both use strict < / >)", () => {
    const paycheck = seedCategory("Paycheck", "income");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "EMPLOYER",
      categoryId: paycheck.id,
      source: "manual",
    });
    const fund = seedCategory("Car Repair", "fund");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "TRANSFER",
      categoryId: fund.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("EMPLOYER", 0)?.categoryId).toBe(paycheck.id);
    expect(match("TRANSFER", 0)?.categoryId).toBe(fund.id);
  });

  it("never blocks a match into an ordinary expense category, either sign", () => {
    const groceries = seedCategory("Groceries", "expense");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("SAFEWAY", -5000)?.categoryId).toBe(groceries.id);
    expect(match("SAFEWAY", 1000)?.categoryId).toBe(groceries.id); // a refund
  });

  it("a rejected candidate falls through to the next-ranked rule rather than aborting the whole match", () => {
    const paycheck = seedCategory("Paycheck", "income");
    const groceries = seedCategory("Groceries", "expense");
    handle.db
      .insert(schema.categoryRules)
      .values([
        {
          categoryId: paycheck.id,
          matchType: "contains",
          matchValue: "GROCERY",
          priority: 90, // higher priority, but wrong sign for income
          source: "auto",
        },
        {
          categoryId: groceries.id,
          matchType: "contains",
          matchValue: "STORE",
          priority: 10,
          source: "auto",
        },
      ])
      .run();

    const match = buildRuleMatcher(handle.db);
    expect(match("GROCERY STORE", -2000)?.categoryId).toBe(groceries.id);
  });

  it("a $0.00 row matches an income rule — the guard only rejects a negative sign, not a missing one", () => {
    const paycheck = seedCategory("Paycheck", "income");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "EMPLOYER",
      categoryId: paycheck.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("EMPLOYER", 0)?.categoryId).toBe(paycheck.id);
  });

  it("a $0.00 row matches a fund rule too, for the same reason", () => {
    const fund = seedCategory("Car Repair", "fund");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "TRANSFER",
      categoryId: fund.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("TRANSFER", 0)?.categoryId).toBe(fund.id);
  });
});

// TC31b (X3, PR2b): an archived category's rules must stop firing — the
// same `categories` join E8/X2 already added, extended with one more clause.
describe("buildRuleMatcher — archived-category guard (TC31b, X3)", () => {
  it("skips a match into an archived category", () => {
    const groceries = seedCategory("Groceries");
    handle.db.update(schema.categories).set({ archivedAt: new Date() }).where(eq(schema.categories.id, groceries.id)).run();
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("SAFEWAY", -1000)).toBeNull();
  });

  it("still matches a non-archived category", () => {
    const groceries = seedCategory("Groceries");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });

    const match = buildRuleMatcher(handle.db);
    expect(match("SAFEWAY", -1000)?.categoryId).toBe(groceries.id);
  });

  it("falls through to the next-ranked rule when the top match is archived", () => {
    const archived = seedCategory("Old Groceries");
    handle.db.update(schema.categories).set({ archivedAt: new Date() }).where(eq(schema.categories.id, archived.id)).run();
    const active = seedCategory("Groceries");

    handle.db
      .insert(schema.categoryRules)
      .values([
        { categoryId: archived.id, matchType: "contains", matchValue: "GROCERY", priority: 90, source: "auto" },
        { categoryId: active.id, matchType: "contains", matchValue: "STORE", priority: 10, source: "auto" },
      ])
      .run();

    const match = buildRuleMatcher(handle.db);
    expect(match("GROCERY STORE", -2000)?.categoryId).toBe(active.id);
  });
});
