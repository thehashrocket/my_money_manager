import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  computeEffectiveAllocationsForRollover,
  computeMtdReceived,
  computeMtdSpent,
  getEffectiveAllocation,
  periodKey,
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
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  return batch;
}

let categoryNameCounter = 0;
function seedCategory(
  name: string,
  carryoverPolicy: "none" | "rollover" | "reset" = "none",
  kind: "income" | "expense" | "fund" = "expense",
) {
  categoryNameCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-test-${categoryNameCounter}`, carryoverPolicy, kind })
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

describe("computeMtdReceived (TC3)", () => {
  it("returns 0 when no transactions exist", () => {
    const cat = seedCategory("Paycheck", "none", "income");
    expect(computeMtdReceived(handle.db, cat.id, 2026, 4)).toBe(0);
  });

  it("sums positive rows as received", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "none", "income");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: 200000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-20",
      amountCents: 200000,
    });
    expect(computeMtdReceived(handle.db, cat.id, 2026, 4)).toBe(400000);
  });

  it("a negative clawback nets the total down", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "none", "income");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: 200000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: -5000, // clawback
    });
    expect(computeMtdReceived(handle.db, cat.id, 2026, 4)).toBe(195000);
  });

  it("excludes transfer-paired rows", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "none", "income");
    const paired = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: 30000,
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
      amountCents: 15000,
    });

    expect(computeMtdReceived(handle.db, cat.id, 2026, 4)).toBe(15000);
  });
});

describe("pending rows: asymmetric by design (TC3b, TS2)", () => {
  it("a pending row in an income category does NOT count toward received", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "none", "income");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: 200000,
      isPending: true,
    });
    expect(computeMtdReceived(handle.db, cat.id, 2026, 4)).toBe(0);
  });

  it("a pending row in an expense category still counts toward spent", () => {
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

  it("(TC4) forces rolloverCents to 0 on an income category, even with carryover_policy='rollover'", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "rollover", "income");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 200000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-03-20",
      amountCents: 4000, // would roll 1000 if the guard didn't fire
    });

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result).toEqual({
      allocatedCents: 200000,
      rolloverCents: 0,
      effectiveCents: 200000,
    });
  });

  it("(round-5) a positive row on a rollover FUND does not inflate what carries forward", () => {
    // The set-based twin of this rule lives in `loadRolloverEffectiveByCategory`
    // and got the clamp first; this scalar spelling did not, so a fund's carried
    // balance was right on page load and grew the instant the user typed into
    // the Allocate cell (`commitAllocationAction` merges THIS triple into live
    // client state). Both now route through `spendIgnoresPositiveRows`.
    const account = seedAccount();
    const batch = seedBatch();
    const fund = seedCategory("Emergency", "rollover", "fund");
    seedAllocation(fund.id, 2026, 3, 40000);
    seedAllocation(fund.id, 2026, 4, 10000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: fund.id,
      date: "2026-03-15",
      amountCents: 5000, // an interest credit; without the clamp it ADDS 5000
    });

    const result = getEffectiveAllocation(handle.db, fund.id, 2026, 4);
    expect(result).toEqual({
      allocatedCents: 10000,
      rolloverCents: 40000,
      effectiveCents: 50000,
    });
  });

  it("(round-5) a fund's positive row is dropped, not netted against a same-month withdrawal", () => {
    // Why the clamp has to be inside the aggregate: $50 credit + $100
    // withdrawal nets to $50 of spend once summed, and no clamp applied
    // afterwards can recover the $100.
    const account = seedAccount();
    const batch = seedBatch();
    const fund = seedCategory("Emergency", "rollover", "fund");
    seedAllocation(fund.id, 2026, 3, 40000);
    seedAllocation(fund.id, 2026, 4, 10000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: fund.id,
      date: "2026-03-10",
      amountCents: 5000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: fund.id,
      date: "2026-03-20",
      amountCents: -10000,
    });

    const result = getEffectiveAllocation(handle.db, fund.id, 2026, 4);
    // 40000 carried − 10000 withdrawn = 30000. Netting would leave 35000.
    expect(result).toEqual({
      allocatedCents: 10000,
      rolloverCents: 30000,
      effectiveCents: 40000,
    });
  });

  it("(round-5) a refund on a rollover EXPENSE envelope still increases what carries forward", () => {
    // The guard above is fund-scoped on purpose. Rule 1's signed-spend
    // convention (v0.19.0) says a refund restores buying capacity on an
    // expense envelope, and this pins that the fund clamp did not quietly
    // reverse it.
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries", "rollover", "expense");
    seedAllocation(cat.id, 2026, 3, 40000);
    seedAllocation(cat.id, 2026, 4, 10000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-03-10",
      amountCents: 5000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-03-20",
      amountCents: -10000,
    });

    const result = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    // Spent nets to 5000, so 35000 carries — the refund gave back $50.
    expect(result).toEqual({
      allocatedCents: 10000,
      rolloverCents: 35000,
      effectiveCents: 45000,
    });
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

  /* These two were written against `invalidateForwardRollover`, asserting a
     cached `effective_allocation_cents` got cleared. That cache and its
     13-call-site contract are gone and `getEffectiveAllocation` always
     recomputes, so they now assert the thing the invalidation existed to
     protect: the CARRIED FIGURE ITSELF. Same fixtures, same arithmetic, one
     less mechanism — and they can no longer pass while the number is wrong. */
  it("moving a March txn between two rollover categories moves April's carried balance with it", () => {
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

    // Simulate the categorize action.
    handle.db
      .update(schema.transactions)
      .set({ categoryId: newCat.id })
      .where(eq(schema.transactions.id, txn.id))
      .run();

    const oldApril = getEffectiveAllocation(handle.db, oldCat.id, 2026, 4);
    const newApril = getEffectiveAllocation(handle.db, newCat.id, 2026, 4);
    // Old cat: March allocated 50, spent 0 → rollover 50; April = 10 + 50 = 60.
    expect(oldApril?.effectiveCents).toBe(6000);
    // New cat: March allocated 50, spent 20 → rollover 30; April = 10 + 30 = 40.
    expect(newApril?.effectiveCents).toBe(4000);
  });

  it("flipping carryover_policy rollover -> none drops the carried balance to zero", () => {
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);

    // Before the flip April carries March's unspent $50.
    expect(getEffectiveAllocation(handle.db, cat.id, 2026, 4)?.effectiveCents).toBe(6000);

    // Simulate the policy flip.
    handle.db
      .update(schema.categories)
      .set({ carryoverPolicy: "none" })
      .where(eq(schema.categories.id, cat.id))
      .run();

    const april = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    // Policy 'none' means no rollover; April effective = allocated only.
    expect(april?.effectiveCents).toBe(1000);
    expect(april?.rolloverCents).toBe(0);
  });
});

function spentMap(entries: [number, number, number][]): Map<string, number> {
  const map = new Map<string, number>();
  for (const [year, month, spent] of entries) map.set(periodKey(year, month), spent);
  return map;
}

describe("computeEffectiveAllocationsForRollover (TC30, P1 + E4, MANDATORY)", () => {
  it("matches getEffectiveAllocation: a basic 2-month chain", () => {
    const periods = [
      { year: 2026, month: 3, allocatedCents: 5000 },
      { year: 2026, month: 4, allocatedCents: 0 },
    ];
    const spent = spentMap([[2026, 3, 3000]]);
    const result = computeEffectiveAllocationsForRollover(periods, spent);
    expect(result.get(periodKey(2026, 3))).toBe(5000);
    expect(result.get(periodKey(2026, 4))).toBe(2000);

    // Cross-check against the DB-backed oracle for the same scenario.
    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 0);
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-03-20", amountCents: -3000 });
    const oracle = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result.get(periodKey(2026, 4))).toBe(oracle?.effectiveCents);
  });

  it("matches getEffectiveAllocation: floors rollover at zero when the prior month overspent", () => {
    const periods = [
      { year: 2026, month: 3, allocatedCents: 5000 },
      { year: 2026, month: 4, allocatedCents: 10000 },
    ];
    const spent = spentMap([[2026, 3, 8000]]);
    const result = computeEffectiveAllocationsForRollover(periods, spent);
    expect(result.get(periodKey(2026, 4))).toBe(10000);

    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 10000);
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-03-20", amountCents: -8000 });
    const oracle = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(result.get(periodKey(2026, 4))).toBe(oracle?.effectiveCents);
  });

  it("matches getEffectiveAllocation: contributes 0 rollover when no prior month row exists at all", () => {
    const periods = [{ year: 2026, month: 4, allocatedCents: 5000 }];
    const result = computeEffectiveAllocationsForRollover(periods, new Map());
    expect(result.get(periodKey(2026, 4))).toBe(5000);
  });

  it("matches getEffectiveAllocation: crosses the year boundary", () => {
    const periods = [
      { year: 2025, month: 12, allocatedCents: 4000 },
      { year: 2026, month: 1, allocatedCents: 1000 },
    ];
    const spent = spentMap([[2025, 12, 0]]);
    const result = computeEffectiveAllocationsForRollover(periods, spent);
    expect(result.get(periodKey(2026, 1))).toBe(5000);

    const cat = seedCategory("Gifts", "rollover");
    seedAllocation(cat.id, 2025, 12, 4000);
    seedAllocation(cat.id, 2026, 1, 1000);
    const oracle = getEffectiveAllocation(handle.db, cat.id, 2026, 1);
    expect(result.get(periodKey(2026, 1))).toBe(oracle?.effectiveCents);
  });

  it("a 6-month unspent chain accumulates fully", () => {
    const periods = Array.from({ length: 6 }, (_, i) => ({
      year: 2026,
      month: i + 1,
      allocatedCents: 20000,
    }));
    const result = computeEffectiveAllocationsForRollover(periods, new Map());
    expect(result.get(periodKey(2026, 1))).toBe(20000);
    expect(result.get(periodKey(2026, 2))).toBe(40000);
    expect(result.get(periodKey(2026, 3))).toBe(60000);
    expect(result.get(periodKey(2026, 4))).toBe(80000);
    expect(result.get(periodKey(2026, 5))).toBe(100000);
    expect(result.get(periodKey(2026, 6))).toBe(120000);
  });

  it("a mid-chain overspend clamps that month's rollover to zero without breaking the rest of the chain", () => {
    const periods = [
      { year: 2026, month: 1, allocatedCents: 10000 }, // effective 100
      { year: 2026, month: 2, allocatedCents: 10000 }, // spends 250 -> overspent
      { year: 2026, month: 3, allocatedCents: 10000 },
    ];
    const spent = spentMap([
      [2026, 1, 0],
      [2026, 2, 25000], // overspends Feb's effective (100+100=200) by 50
    ]);
    const result = computeEffectiveAllocationsForRollover(periods, spent);
    expect(result.get(periodKey(2026, 1))).toBe(10000);
    expect(result.get(periodKey(2026, 2))).toBe(20000); // 100 allocated + 100 rollover
    // Feb overspent (250 > 200) -> rollover into March clamps to 0.
    expect(result.get(periodKey(2026, 3))).toBe(10000);
  });

  it("(E4, MANDATORY) a gap month terminates the chain — Jan $200, Feb no row, Mar $200 -> effective(Mar) = 200, not 400", () => {
    const periods = [
      { year: 2026, month: 1, allocatedCents: 20000 },
      { year: 2026, month: 3, allocatedCents: 20000 }, // no Feb row
    ];
    const result = computeEffectiveAllocationsForRollover(periods, new Map());
    expect(result.get(periodKey(2026, 1))).toBe(20000);
    expect(result.get(periodKey(2026, 3))).toBe(20000); // NOT 40000
  });

  it("(E4) a scan that iterates in insertion order rather than checking adjacency would get this wrong — periods out of order still resolve correctly", () => {
    const periods = [
      { year: 2026, month: 3, allocatedCents: 20000 },
      { year: 2026, month: 1, allocatedCents: 20000 },
    ];
    const result = computeEffectiveAllocationsForRollover(periods, new Map());
    expect(result.get(periodKey(2026, 3))).toBe(20000);
  });

  it("resumes accumulating after a gap, starting fresh from the row after it", () => {
    // Jan $100 (unspent) · Feb GAP · Mar $100, Apr $100 (unspent) — the Mar->Apr
    // leg is a real contiguous pair and should roll, even though Jan is orphaned.
    const periods = [
      { year: 2026, month: 1, allocatedCents: 10000 },
      { year: 2026, month: 3, allocatedCents: 10000 },
      { year: 2026, month: 4, allocatedCents: 10000 },
    ];
    const spent = spentMap([[2026, 3, 0]]);
    const result = computeEffectiveAllocationsForRollover(periods, spent);
    expect(result.get(periodKey(2026, 1))).toBe(10000);
    expect(result.get(periodKey(2026, 3))).toBe(10000); // gap before it: no rollover
    expect(result.get(periodKey(2026, 4))).toBe(20000); // contiguous with March: rolls
  });
});
