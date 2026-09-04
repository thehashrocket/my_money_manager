import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { listLeafCategories } from "./categories";

/**
 * `listLeafCategories` had no test file at all before A2 repointed its
 * `is_savings_goal = false` filter to `kind != 'fund'` (T5) — same gap
 * TC34a/TC34b closed for loadGoals/loadMonthlyTrends, just not named in the
 * plan's own audit. Pins the pre-existing behavior, then the drift cases.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
  handle.db.delete(schema.categories).where(ne(schema.categories.name, "Uncategorized")).run();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedCategory(
  name: string,
  opts: { parentId?: number | null; isSavingsGoal?: boolean; kind?: "income" | "expense" | "fund" } = {},
) {
  seq += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: opts.parentId ?? null,
      isSavingsGoal: opts.isSavingsGoal ?? false,
      kind: opts.kind ?? "expense",
    })
    .returning()
    .all();
  return cat;
}

describe("listLeafCategories", () => {
  it("returns leaves sorted by name, excluding parents", () => {
    const housing = seedCategory("Housing");
    seedCategory("Rent", { parentId: housing.id });
    seedCategory("Zebra");

    const leaves = listLeafCategories(handle.db);
    const names = leaves.map((l) => l.name);
    expect(names.some((n) => n.startsWith("Housing-"))).toBe(false);
    expect(names.some((n) => n.startsWith("Rent-"))).toBe(true);
    expect(names.some((n) => n.startsWith("Zebra-"))).toBe(true);
  });

  it("excludes a kind='fund' category from the leaf list", () => {
    seedCategory("Groceries");
    seedCategory("Emergency Fund", { isSavingsGoal: true, kind: "fund" });

    const names = listLeafCategories(handle.db).map((l) => l.name);
    expect(names.some((n) => n.startsWith("Groceries-"))).toBe(true);
    expect(names.some((n) => n.startsWith("Emergency Fund-"))).toBe(false);
  });
});

describe("listLeafCategories — kind is authoritative, not is_savings_goal (E6 drift)", () => {
  it("(TC22) excludes a kind='fund' category even when isSavingsGoal=0", () => {
    seedCategory("Drifted Fund", { isSavingsGoal: false, kind: "fund" });
    const names = listLeafCategories(handle.db).map((l) => l.name);
    expect(names.some((n) => n.startsWith("Drifted Fund-"))).toBe(false);
  });

  it("(TC22b) includes a kind='expense' category even when isSavingsGoal=1", () => {
    seedCategory("Drifted Expense", { isSavingsGoal: true, kind: "expense" });
    const names = listLeafCategories(handle.db).map((l) => l.name);
    expect(names.some((n) => n.startsWith("Drifted Expense-"))).toBe(true);
  });
});
