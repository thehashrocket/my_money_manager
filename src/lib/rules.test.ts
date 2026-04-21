import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { applyRuleAtImport, createOrUpdateRule } from "./rules";
import { createTestDb, type TestDbHandle } from "./test/db";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let categoryNameCounter = 0;
function seedCategory(name: string) {
  categoryNameCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-test-${categoryNameCounter}` })
    .returning()
    .all();
  return cat;
}

describe("applyRuleAtImport", () => {
  it("returns null when no rules exist", () => {
    expect(applyRuleAtImport(handle.db, "SAFEWAY")).toBeNull();
  });

  it("matches an exact rule", () => {
    const groceries = seedCategory("Groceries");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });
    expect(applyRuleAtImport(handle.db, "SAFEWAY")).toBe(groceries.id);
    expect(applyRuleAtImport(handle.db, "TRADER JOES")).toBeNull();
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
    expect(applyRuleAtImport(handle.db, "SHELL OIL 1234")).toBe(gas.id);
    expect(applyRuleAtImport(handle.db, "CHEVRON")).toBeNull();
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
    expect(applyRuleAtImport(handle.db, "DOORDASH CHIPOTLE")).toBe(dining.id);
    expect(applyRuleAtImport(handle.db, "UBEREATS")).toBe(dining.id);
    expect(applyRuleAtImport(handle.db, "UBER")).toBeNull();
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
    expect(() => applyRuleAtImport(handle.db, "aaaaaaa")).not.toThrow();
    expect(applyRuleAtImport(handle.db, "aaaaaaa")).toBeNull();
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
    expect(() => applyRuleAtImport(handle.db, "anything")).not.toThrow();
    expect(applyRuleAtImport(handle.db, "anything")).toBeNull();
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
    expect(applyRuleAtImport(handle.db, "SAFEWAY")).toBe(household.id);
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
    expect(applyRuleAtImport(handle.db, "SAFEWAY")).toBe(b.id);
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
    expect(applyRuleAtImport(handle.db, "SAFEWAY")).toBe(exactCat.id);
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

    const count = handle.db.select().from(schema.categoryRules).all().length;
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

    const rows = handle.db.select().from(schema.categoryRules).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.matchType === "exact")).toBe(true);
    expect(rows.some((r) => r.matchType === "contains")).toBe(true);
  });
});
