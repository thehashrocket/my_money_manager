import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadGoals } from "./loadGoals";

/**
 * TC34a (mandatory regression, TS3): `loadGoals` had NO test file at all
 * before A2 repointed its `is_savings_goal = true` filter to `kind = 'fund'`
 * (T5). Pins the pre-existing behavior first, then the drift cases E6 added.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
  // The real seed (migrations 0001/0002/0005/0017) has zero fund categories;
  // clear it so each test's fixture is exact rather than additive.
  handle.db.delete(schema.categories).where(ne(schema.categories.name, "Uncategorized")).run();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedFundCategory(
  name: string,
  opts: {
    targetCents?: number;
    carryoverPolicy?: "none" | "rollover" | "reset";
    isSavingsGoal?: boolean;
    kind?: "income" | "expense" | "fund";
  } = {},
) {
  seq += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      isSavingsGoal: opts.isSavingsGoal ?? true,
      kind: opts.kind ?? "fund",
      targetCents: opts.targetCents ?? 100000,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
    })
    .returning()
    .all();
  return cat;
}

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
  seq += 1;
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: `seed-${seq}.csv` })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  categoryId: number;
  date: string;
  amountCents: number;
  transferPairId?: number | null;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "TEST",
      rawMemo: "",
      normalizedMerchant: "TEST",
      amountCents: opts.amountCents,
      categoryId: opts.categoryId,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: opts.transferPairId ?? null,
    })
    .returning()
    .all();
  return row;
}

function seedAllocation(categoryId: number, year: number, month: number, allocatedCents: number) {
  handle.db
    .insert(schema.budgetPeriods)
    .values({ categoryId, year, month, allocatedCents })
    .run();
}

describe("loadGoals (TC34a)", () => {
  it("returns an empty view when there are no fund categories", () => {
    const view = loadGoals(handle.db);
    expect(view).toEqual({ goals: [], totalProgressCents: 0, totalTargetCents: 0 });
  });

  it("computes contributed (from allocations), withdrawn (from negative txns), and progress", () => {
    const cat = seedFundCategory("Car Repair", { targetCents: 100000 });
    seedAllocation(cat.id, 2026, 3, 20000);
    seedAllocation(cat.id, 2026, 4, 20000);

    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: -5000, // withdrawal
    });

    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(1);
    const goal = view.goals[0];
    expect(goal.totalContributedCents).toBe(40000);
    expect(goal.totalWithdrawnCents).toBe(5000);
    expect(goal.progressCents).toBe(35000);
    expect(goal.progressPct).toBeCloseTo(35, 5);
    expect(goal.monthlyBreakdown).toEqual([
      { year: 2026, month: 3, allocatedCents: 20000 },
      { year: 2026, month: 4, allocatedCents: 20000 },
    ]);
  });

  it("excludes transfer-paired rows from withdrawals", () => {
    const cat = seedFundCategory("Vacation");
    const account = seedAccount();
    const batch = seedBatch();
    const paired = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: -30000,
    });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    const view = loadGoals(handle.db);
    expect(view.goals[0]?.totalWithdrawnCents).toBe(0);
  });

  it("sorts goals by name ascending", () => {
    seedFundCategory("Zebra");
    seedFundCategory("Alpha");
    const view = loadGoals(handle.db);
    expect(view.goals.map((g) => g.name.replace(/-\d+$/, ""))).toEqual(["Alpha", "Zebra"]);
  });

  it("totalProgressCents/totalTargetCents sum across all goals", () => {
    const a = seedFundCategory("A", { targetCents: 10000 });
    const b = seedFundCategory("B", { targetCents: 20000 });
    seedAllocation(a.id, 2026, 4, 5000);
    seedAllocation(b.id, 2026, 4, 8000);

    const view = loadGoals(handle.db);
    expect(view.totalTargetCents).toBe(30000);
    expect(view.totalProgressCents).toBe(13000);
  });
});

describe("loadGoals — kind is authoritative, not is_savings_goal (E6 drift)", () => {
  it("includes a kind='fund' category even when isSavingsGoal=0 (TC22 direction)", () => {
    seedFundCategory("Drifted Fund", { isSavingsGoal: false, kind: "fund" });
    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(1);
  });

  it("excludes a kind='expense' category even when isSavingsGoal=1 (TC22b inverse direction)", () => {
    seedFundCategory("Drifted Expense", { isSavingsGoal: true, kind: "expense" });
    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(0);
  });
});
