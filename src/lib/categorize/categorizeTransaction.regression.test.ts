import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  computeMtdSpent,
  getEffectiveAllocation,
} from "@/lib/budget";
import { categorizeTransaction } from "./categorizeTransaction";
import { undoCategorizeTransaction } from "./undoCategorizeTransaction";

/**
 * Mandatory regression guard (Track B review):
 *
 *   categorize via Track B
 *     → `/budget` MTD for the new category reflects the new number
 *     → forward rollover rows for future months are invalidated
 *     → Undo reverts all three
 *
 * Spine: April + May budget_periods with carryoverPolicy = "rollover".
 * Seed a $50 uncategorized txn in April. Categorize into Groceries via the
 * single-row path. Prime May's effective cache. Confirm April MTD = $50 and
 * May's cache is cleared. Undo. Confirm April MTD back to 0 and May is
 * cleared again (the only thing that matters is the cache re-clear).
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

describe("Track B regression guard — budget ↔ categorize ↔ rollover", () => {
  it("categorize flows into /budget MTD + invalidates May; undo reverses both", () => {
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
      .values({ source: "csv", filename: "seed.csv" })
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

    // Prime both months' caches so invalidation has something visible to clear.
    getEffectiveAllocation(handle.db, groceries.id, 2026, 5, { persist: true });
    expect(
      readBudget(groceries.id, 2026, 4)?.effectiveAllocationCents,
    ).not.toBeNull();
    expect(
      readBudget(groceries.id, 2026, 5)?.effectiveAllocationCents,
    ).not.toBeNull();

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
    // (2) May's rollover cache cleared.
    expect(
      readBudget(groceries.id, 2026, 5)?.effectiveAllocationCents,
    ).toBeNull();
    // April's cache cleared too (floor = April).
    expect(
      readBudget(groceries.id, 2026, 4)?.effectiveAllocationCents,
    ).toBeNull();

    // Re-prime May so we can observe undo re-clears it.
    getEffectiveAllocation(handle.db, groceries.id, 2026, 5, { persist: true });
    expect(
      readBudget(groceries.id, 2026, 5)?.effectiveAllocationCents,
    ).not.toBeNull();

    // Undo.
    const undo = undoCategorizeTransaction(handle.db, result);
    expect(undo.targetReverted).toBe(true);

    // (3a) Spend reversed off Groceries.
    expect(computeMtdSpent(handle.db, groceries.id, 2026, 4)).toBe(0);
    // (3b) May's re-primed cache cleared again.
    expect(
      readBudget(groceries.id, 2026, 5)?.effectiveAllocationCents,
    ).toBeNull();
    // (3c) Target row back to NULL.
    const reverted = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(reverted?.categoryId).toBeNull();
  });

  function readBudget(categoryId: number, year: number, month: number) {
    return handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, categoryId),
          eq(schema.budgetPeriods.year, year),
          eq(schema.budgetPeriods.month, month),
        ),
      )
      .get();
  }
});
