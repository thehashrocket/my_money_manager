import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { computeMtdSpent, getEffectiveAllocation } from "@/lib/budget";
import { categorizeTransaction } from "./categorizeTransaction";
import { undoCategorizeTransaction } from "./undoCategorizeTransaction";

/**
 * Mandatory regression guard (Track B review):
 *
 *   categorize via Track B
 *     → `/budget` MTD for the new category reflects the new number
 *     → MAY's carried-forward rollover shrinks by the same amount
 *     → Undo reverts all three
 *
 * Spine: April + May budget_periods with carryoverPolicy = "rollover".
 * Seed a $50 uncategorized txn in April, categorize it into Groceries via
 * the single-row path, then undo.
 *
 * This used to assert that May's `effective_allocation_cents` CACHE was
 * cleared. That column and its invalidation contract are gone, and the
 * assertion is stronger without them: clearing a cache was only ever a proxy
 * for "May now carries less money forward", so the test asserts the carried
 * figure itself. April is allocated $100 and spends $50, so May opens at
 * $100 + $50 carried = $150; undo returns April's spend to $0 and May opens
 * at $200. A mechanism assertion became an outcome assertion.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

describe("Track B regression guard — budget ↔ categorize ↔ rollover", () => {
  it("categorize flows into /budget MTD and shrinks May's carried rollover; undo reverses both", () => {
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 100_000,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();

    const [batch] = handle.db
      .insert(schema.importBatches)
      .values({ source: "csv", label: "seed.csv" })
      .returning()
      .all();

    const [groceries] = handle.db
      .insert(schema.categories)
      .values({ name: "Groceries-Regression", carryoverPolicy: "rollover" })
      .returning()
      .all();

    handle.db
      .insert(schema.budgetPeriods)
      .values([
        { categoryId: groceries.id, year: 2026, month: 4, allocatedCents: 10_000 },
        { categoryId: groceries.id, year: 2026, month: 5, allocatedCents: 10_000 },
      ])
      .run();

    // Baseline: nothing spent in April, so May carries April's whole $100.
    expect(getEffectiveAllocation(handle.db, groceries.id, 2026, 5)).toEqual({
      allocatedCents: 10_000,
      rolloverCents: 10_000,
      effectiveCents: 20_000,
    });

    // Baseline: uncategorized April txn, no MTD yet.
    const [target] = handle.db
      .insert(schema.transactions)
      .values({
        accountId: account.id,
        date: "2026-04-15",
        rawDescription: "SAFEWAY #42",
        rawMemo: "",
        normalizedMerchant: "SAFEWAY",
        amountCents: -5_000,
        importSource: "csv",
        importBatchId: batch.id,
        importRowHash: "hash-target",
        isPending: false,
      })
      .returning()
      .all();
    expect(computeMtdSpent(handle.db, groceries.id, 2026, 4)).toBe(0);

    // Apply via Track B.
    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });
    expect(result.updatedCount).toBe(1);

    // (1) /budget MTD reflects the new number — $50 spent.
    expect(computeMtdSpent(handle.db, groceries.id, 2026, 4)).toBe(5_000);
    // (2) May carries $50 less forward, on the next read, with nothing
    //     needing to have been invalidated for it to be true.
    expect(getEffectiveAllocation(handle.db, groceries.id, 2026, 5)).toEqual({
      allocatedCents: 10_000,
      rolloverCents: 5_000,
      effectiveCents: 15_000,
    });

    // Undo.
    const undo = undoCategorizeTransaction(handle.db, result);
    expect(undo.targetReverted).toBe(true);

    // (3a) Spend reversed off Groceries.
    expect(computeMtdSpent(handle.db, groceries.id, 2026, 4)).toBe(0);
    // (3b) May carries the full $100 again.
    expect(getEffectiveAllocation(handle.db, groceries.id, 2026, 5)).toEqual({
      allocatedCents: 10_000,
      rolloverCents: 10_000,
      effectiveCents: 20_000,
    });
    // (3c) Target row back to NULL.
    const reverted = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(reverted?.categoryId).toBeNull();
  });
});
