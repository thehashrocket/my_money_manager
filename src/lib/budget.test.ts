import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  computeMtdSpent,
  getEffectiveAllocation,
  invalidateForwardRollover,
} from "./budget";
import { createTestDb, type TestDbHandle } from "./test/db";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

function seedAccount() {
  const [account] = handle.db
    .insert(schema.accounts)
    .values({
      name: "Checking",
      type: "checking",
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
    })
    .returning()
    .all();
  return account;
}

function seedBatch() {
  const [batch] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", filename: "seed.csv" })
    .returning()
    .all();
  return batch;
}

let categoryNameCounter = 0;
function seedCategory(
  name: string,
  carryoverPolicy: "none" | "rollover" | "reset" = "none",
) {
  categoryNameCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-test-${categoryNameCounter}`, carryoverPolicy })
    .returning()
    .all();
  return cat;
}

function seedAllocation(
  categoryId: number,
  year: number,
  month: number,
  allocatedCents: number,
) {
  const [row] = handle.db
    .insert(schema.budgetPeriods)
    .values({ categoryId, year, month, allocatedCents })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  categoryId: number | null;
  date: string;
  amountCents: number;
  hash?: string;
  transferPairId?: number | null;
  isPending?: boolean;
}) {
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "WITHDRAWAL",
      rawMemo: "test",
      normalizedMerchant: "TEST",
      amountCents: opts.amountCents,
      categoryId: opts.categoryId,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: opts.hash ?? `${opts.date}-${opts.amountCents}-${Math.random()}`,
      transferPairId: opts.transferPairId ?? null,
      isPending: opts.isPending ?? false,
    })
    .returning()
    .all();
  return row;
}

describe("computeMtdSpent", () => {
  it("returns 0 when no transactions exist", () => {
    const cat = seedCategory("Groceries");
    expect(computeMtdSpent(handle.db, cat.id, 2026, 4)).toBe(0);
  });

  it("sums debits (negative amounts) as positive spent", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: -5000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-20",
      amountCents: -2500,
    });
    expect(computeMtdSpent(handle.db, cat.id, 2026, 4)).toBe(7500);
  });

  it("nets refunds (positive amounts) against debits", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: -10000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-06",
      amountCents: 1000, // refund
    });
    expect(computeMtdSpent(handle.db, cat.id, 2026, 4)).toBe(9000);
  });

  it("excludes transfer-paired rows from spend", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    const paired = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: -3000,
    });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-11",
      amountCents: -1500,
    });

    expect(computeMtdSpent(handle.db, cat.id, 2026, 4)).toBe(1500);
  });

  it("includes pending rows", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: -2000,
      isPending: true,
    });
    expect(computeMtdSpent(handle.db, cat.id, 2026, 4)).toBe(2000);
  });

  it("respects month boundaries (first and last day)", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-01",
      amountCents: -100,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-30",
      amountCents: -200,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-03-31",
      amountCents: -9999,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-05-01",
      amountCents: -9999,
    });
    expect(computeMtdSpent(handle.db, cat.id, 2026, 4)).toBe(300);
  });

  it("handles December → next year crossover", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Gas");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-12-15",
      amountCents: -5000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2027-01-02",
      amountCents: -9999,
    });
    expect(computeMtdSpent(handle.db, cat.id, 2026, 12)).toBe(5000);
  });
});

describe("getEffectiveAllocation", () => {
  it("returns null when no budget_periods row exists", () => {
    const cat = seedCategory("Groceries");
    expect(getEffectiveAllocation(handle.db, cat.id, 2026, 4)).toBeNull();
  });

  it("returns allocated when carryover_policy=none (no rollover)", () => {
    const cat = seedCategory("Groceries", "none");
    seedAllocation(cat.id, 2026, 3, 20000);
    seedAllocation(cat.id, 2026, 4, 40000);

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result).toEqual({
      allocatedCents: 40000,
      rolloverCents: 0,
      effectiveCents: 40000,
    });
  });

  it("adds rollover from previous month for rollover categories", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 0);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-03-20",
      amountCents: -3000, // spent 30 of 50; 20 rolls
    });

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result).toEqual({
      allocatedCents: 0,
      rolloverCents: 2000,
      effectiveCents: 2000,
    });
  });

  it("floors rollover at zero when previous month overspent", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 10000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-03-20",
      amountCents: -8000, // overspent by 30
    });

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result?.rolloverCents).toBe(0);
    expect(result?.effectiveCents).toBe(10000);
  });

  it("contributes 0 rollover when no prior month row exists", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 4, 5000);

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result).toEqual({
      allocatedCents: 5000,
      rolloverCents: 0,
      effectiveCents: 5000,
    });
  });

  it("does NOT write cache by default (persist=false)", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result?.effectiveCents).toBe(6000);

    const rows = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .all();
    expect(rows.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });

  it("persists effective_allocation_cents for current and prior months when persist=true", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);

    getEffectiveAllocation(handle.db, cat.id, 2026, 4, { persist: true });

    const persisted = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .all();
    const april = persisted.find((r) => r.month === 4);
    const march = persisted.find((r) => r.month === 3);
    expect(april?.effectiveAllocationCents).toBe(6000);
    expect(march?.effectiveAllocationCents).toBe(5000);
  });

  it("read-only computation sees a previously persisted cache", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);

    getEffectiveAllocation(handle.db, cat.id, 2026, 4, { persist: true });
    const readOnly = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(readOnly?.effectiveCents).toBe(6000);
    expect(readOnly?.rolloverCents).toBe(5000);
  });

  it("walks backward across a cached month (no recompute past cached)", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 1, 100); // stale if ignored
    seedAllocation(cat.id, 2026, 2, 3000);
    seedAllocation(cat.id, 2026, 3, 0);

    // Pre-cache Feb without bringing in Jan.
    handle.db
      .update(schema.budgetPeriods)
      .set({ effectiveAllocationCents: 9999 })
      .where(
        eq(schema.budgetPeriods.categoryId, cat.id),
      )
      .run();
    handle.db
      .update(schema.budgetPeriods)
      .set({ effectiveAllocationCents: null })
      .where(eq(schema.budgetPeriods.month, 3))
      .run();

    const march = getEffectiveAllocation(handle.db, cat.id, 2026, 3);
    // March builds off Feb's cached 9999 (minus 0 spent).
    expect(march?.effectiveCents).toBe(9999);
  });

  it("read-only mode does not write even when traversing multiple uncached months", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 1, 1000);
    seedAllocation(cat.id, 2026, 2, 1000);
    seedAllocation(cat.id, 2026, 3, 1000);
    seedAllocation(cat.id, 2026, 4, 1000);

    getEffectiveAllocation(handle.db, cat.id, 2026, 4);

    const rows = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .all();
    expect(rows.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });

  it("crosses the year boundary (Jan reads prior Dec)", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2025, 12, 4000);
    seedAllocation(cat.id, 2026, 1, 1000);

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 1);
    expect(result).toEqual({
      allocatedCents: 1000,
      rolloverCents: 4000,
      effectiveCents: 5000,
    });
  });
});

describe("invalidateForwardRollover", () => {
  it("clears effective_allocation_cents for the edited month and all later months", () => {
    const cat = seedCategory("Gifts", "rollover");
    const mar = seedAllocation(cat.id, 2026, 3, 5000);
    const apr = seedAllocation(cat.id, 2026, 4, 1000);
    const may = seedAllocation(cat.id, 2026, 5, 1000);

    // Prime the cache via an explicit persist.
    getEffectiveAllocation(handle.db, cat.id, 2026, 5, { persist: true });
    const before = handle.db.select().from(schema.budgetPeriods).all();
    expect(before.every((r) => r.effectiveAllocationCents !== null)).toBe(true);

    invalidateForwardRollover(handle.db, cat.id, 2026, 4);

    const after = handle.db.select().from(schema.budgetPeriods).all();
    const byMonth = new Map(after.map((r) => [r.month, r]));
    expect(byMonth.get(3)?.effectiveAllocationCents).toBe(5000); // untouched
    expect(byMonth.get(4)?.effectiveAllocationCents).toBeNull();
    expect(byMonth.get(5)?.effectiveAllocationCents).toBeNull();
    // quiet unused-var warnings
    void mar;
    void apr;
    void may;
  });

  it("clears across the year boundary (from Dec 2026 invalidates Jan 2027)", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 12, 2000);
    seedAllocation(cat.id, 2027, 1, 1000);

    getEffectiveAllocation(handle.db, cat.id, 2027, 1, { persist: true });
    invalidateForwardRollover(handle.db, cat.id, 2026, 12);

    const rows = handle.db.select().from(schema.budgetPeriods).all();
    expect(rows.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });

  it("only affects the target category", () => {
    const a = seedCategory("Gifts", "rollover");
    const b = seedCategory("Travel", "rollover");
    seedAllocation(a.id, 2026, 4, 1000);
    seedAllocation(b.id, 2026, 4, 2000);
    getEffectiveAllocation(handle.db, a.id, 2026, 4, { persist: true });
    getEffectiveAllocation(handle.db, b.id, 2026, 4, { persist: true });

    invalidateForwardRollover(handle.db, a.id, 2026, 4);

    const rows = handle.db.select().from(schema.budgetPeriods).all();
    const aRow = rows.find((r) => r.categoryId === a.id)!;
    const bRow = rows.find((r) => r.categoryId === b.id)!;
    expect(aRow.effectiveAllocationCents).toBeNull();
    expect(bRow.effectiveAllocationCents).toBe(2000);
  });

  it("is a no-op when no rows match (doesn't throw)", () => {
    const cat = seedCategory("Gifts", "rollover");
    expect(() => invalidateForwardRollover(handle.db, cat.id, 2030, 1)).not.toThrow();
  });

  it("supports the categorize trigger: moving a March txn out of a category clears downstream cache", () => {
    // Contract: categorizeTransactionAction must call invalidateForwardRollover
    // for both the old and new category, starting from the txn's date month.
    const account = seedAccount();
    const batch = seedBatch();
    const oldCat = seedCategory("Gifts", "rollover");
    const newCat = seedCategory("Household", "rollover");
    seedAllocation(oldCat.id, 2026, 3, 5000);
    seedAllocation(oldCat.id, 2026, 4, 1000);
    seedAllocation(newCat.id, 2026, 3, 5000);
    seedAllocation(newCat.id, 2026, 4, 1000);

    const txn = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: oldCat.id,
      date: "2026-03-12",
      amountCents: -2000,
    });

    getEffectiveAllocation(handle.db, oldCat.id, 2026, 4, { persist: true });
    getEffectiveAllocation(handle.db, newCat.id, 2026, 4, { persist: true });

    // Simulate the categorize action.
    handle.db
      .update(schema.transactions)
      .set({ categoryId: newCat.id })
      .where(eq(schema.transactions.id, txn.id))
      .run();
    invalidateForwardRollover(handle.db, oldCat.id, 2026, 3);
    invalidateForwardRollover(handle.db, newCat.id, 2026, 3);

    const oldApril = getEffectiveAllocation(handle.db, oldCat.id, 2026, 4);
    const newApril = getEffectiveAllocation(handle.db, newCat.id, 2026, 4);
    // Old cat: March allocated 50, spent 0 → rollover 50; April = 10 + 50 = 60.
    expect(oldApril?.effectiveCents).toBe(6000);
    // New cat: March allocated 50, spent 20 → rollover 30; April = 10 + 30 = 40.
    expect(newApril?.effectiveCents).toBe(4000);
  });

  it("supports the carryover-policy-change trigger: flipping rollover → none clears all downstream", () => {
    // Contract: a policy change must call invalidateForwardRollover from the
    // earliest allocation month (or any month <= the earliest).
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);

    getEffectiveAllocation(handle.db, cat.id, 2026, 4, { persist: true });
    const beforeApril = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, cat.id),
          eq(schema.budgetPeriods.month, 4),
        ),
      )
      .get();
    expect(beforeApril?.effectiveAllocationCents).toBe(6000);

    // Simulate the policy flip.
    handle.db
      .update(schema.categories)
      .set({ carryoverPolicy: "none" })
      .where(eq(schema.categories.id, cat.id))
      .run();
    invalidateForwardRollover(handle.db, cat.id, 2026, 3);

    const april = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    // Policy 'none' means no rollover; April effective = allocated only.
    expect(april?.effectiveCents).toBe(1000);
    expect(april?.rolloverCents).toBe(0);
  });
});
