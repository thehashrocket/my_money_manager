import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { getEffectiveAllocation } from "@/lib/budget";
import {
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";
import { categorizeTransaction } from "./categorizeTransaction";
import {
  TransactionNotFoundError,
  TransferPairedTransactionError,
} from "./categorizeTransactionErrors";

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
    .values({ source: "csv", filename: "seed.csv" })
    .returning()
    .all();
  return row;
}

function seedCategory(
  name: string,
  opts: {
    parentId?: number | null;
    isSavingsGoal?: boolean;
    carryoverPolicy?: "none" | "rollover" | "reset";
  } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: opts.parentId ?? null,
      isSavingsGoal: opts.isSavingsGoal ?? false,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
    })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant?: string;
  amountCents?: number;
  date?: string;
  categoryId?: number | null;
  transferPairId?: number | null;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant ?? "SAFEWAY",
      amountCents: opts.amountCents ?? -5000,
      categoryId: opts.categoryId ?? null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: opts.transferPairId ?? null,
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

describe("categorizeTransaction — core", () => {
  it("flips the target row from NULL to the new category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    expect(result.updatedCount).toBe(1);
    expect(result.targetPriorCategoryId).toBeNull();
    expect(result.categoryName).toBe(groceries.name);
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(row?.categoryId).toBe(groceries.id);
  });

  it("captures prior categoryId when re-categorizing a previously-categorized row", () => {
    const a = seedAccount();
    const b = seedBatch();
    const household = seedCategory("Household");
    const groceries = seedCategory("Groceries");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: household.id,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    expect(result.targetPriorCategoryId).toBe(household.id);
  });

  it("uses the target row's normalizedMerchant (server-trust), not any form value", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "TRUSTED",
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    expect(result.normalizedMerchant).toBe("TRUSTED");
  });
});

describe("categorizeTransaction — applyToPast", () => {
  it("flips sibling NULL-category rows for the same merchant when applyToPast=true", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s2 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });

    expect(result.updatedCount).toBe(3);
    expect(result.applyToPastTxnIds.sort()).toEqual([s1.id, s2.id].sort());

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "SAFEWAY"))
      .all();
    expect(rows.every((r) => r.categoryId === groceries.id)).toBe(true);
  });

  it("does not touch sibling rows that already have a category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const keepAs = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      categoryId: other.id,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });

    expect(result.applyToPastTxnIds).not.toContain(keepAs.id);
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, keepAs.id))
      .get();
    expect(row?.categoryId).toBe(other.id);
  });

  it("does not touch transfer-paired sibling rows", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const paired = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });

    expect(result.applyToPastTxnIds).not.toContain(paired.id);
  });

  it("records earliest applyToPast date", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      date: "2026-04-10",
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      date: "2026-02-05",
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      date: "2026-03-15",
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });
    expect(result.earliestApplyToPastDate).toBe("2026-02-05");
  });

  it("applyToPastTxnIds is empty when no siblings match", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });
    expect(result.applyToPastTxnIds).toEqual([]);
    expect(result.earliestApplyToPastDate).toBeNull();
    expect(result.updatedCount).toBe(1);
  });
});

describe("categorizeTransaction — rule upsert", () => {
  it("does NOT write a rule when rememberMerchant is false", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    expect(result.ruleTouched).toBe(false);
    expect(result.priorRule).toBeNull();
    expect(handle.db.select().from(schema.categoryRules).all()).toHaveLength(0);
  });

  it("inserts a new rule when rememberMerchant is true and none existed", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.ruleTouched).toBe(true);
    expect(result.priorRule).toBeNull();
    const rule = handle.db
      .select()
      .from(schema.categoryRules)
      .where(
        and(
          eq(schema.categoryRules.matchType, "exact"),
          eq(schema.categoryRules.matchValue, "SAFEWAY"),
        ),
      )
      .get();
    expect(rule?.categoryId).toBe(groceries.id);
    expect(rule?.source).toBe("manual");
  });

  it("captures priorRule snapshot when replacing an existing rule", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
    });
    const [prior] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "exact",
        matchValue: "SAFEWAY",
        priority: 80,
        source: "manual",
      })
      .returning()
      .all();

    const result = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.priorRule).toEqual({
      id: prior.id,
      categoryId: dining.id,
      matchType: "exact",
      matchValue: "SAFEWAY",
      priority: 80,
      source: "manual",
      createdAt: prior.createdAt,
      updatedAt: prior.updatedAt,
    });
  });
});

describe("categorizeTransaction — forward invalidation", () => {
  it("invalidates new category from earliest(target, applyToPast) month onward", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    handle.db
      .insert(schema.budgetPeriods)
      .values([
        { categoryId: groceries.id, year: 2026, month: 2, allocatedCents: 1000 },
        { categoryId: groceries.id, year: 2026, month: 3, allocatedCents: 1000 },
        { categoryId: groceries.id, year: 2026, month: 4, allocatedCents: 1000 },
      ])
      .run();
    getEffectiveAllocation(handle.db, groceries.id, 2026, 4, { persist: true });

    // target is Apr; applyToPast sibling is Feb → earliest = Feb.
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      date: "2026-04-10",
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      date: "2026-02-05",
    });

    categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });

    const rows = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, groceries.id))
      .all();
    expect(rows.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });

  it("invalidates prior category at the target's own month (spend moved off it)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household", { carryoverPolicy: "rollover" });
    handle.db
      .insert(schema.budgetPeriods)
      .values([
        { categoryId: household.id, year: 2026, month: 3, allocatedCents: 1000 },
        { categoryId: household.id, year: 2026, month: 4, allocatedCents: 1000 },
      ])
      .run();
    getEffectiveAllocation(handle.db, household.id, 2026, 4, { persist: true });

    // target had household; re-cat to groceries; only Apr (target.date) onward.
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: household.id,
      date: "2026-04-10",
    });

    categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    const mar = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, household.id),
          eq(schema.budgetPeriods.month, 3),
        ),
      )
      .get();
    const apr = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, household.id),
          eq(schema.budgetPeriods.month, 4),
        ),
      )
      .get();
    // Invalidation floor is target.date month (Apr). Mar stays cached.
    expect(mar?.effectiveAllocationCents).toBe(1000);
    expect(apr?.effectiveAllocationCents).toBeNull();
  });

  it("does NOT invalidate prior category when target was uncategorized (no prior attribution)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other", { carryoverPolicy: "rollover" });
    handle.db
      .insert(schema.budgetPeriods)
      .values({ categoryId: other.id, year: 2026, month: 4, allocatedCents: 1000 })
      .run();
    getEffectiveAllocation(handle.db, other.id, 2026, 4, { persist: true });

    const target = seedTxn({ accountId: a.id, batchId: b.id });

    categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    const row = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, other.id))
      .get();
    expect(row?.effectiveAllocationCents).toBe(1000);
  });
});

describe("categorizeTransaction — rejections", () => {
  it("throws TransactionNotFoundError when the txn id doesn't exist", () => {
    const groceries = seedCategory("Groceries");
    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: 999_999,
        categoryId: groceries.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(TransactionNotFoundError);
  });

  it("throws TransferPairedTransactionError when the target is half of a transfer pair", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const paired = seedTxn({ accountId: a.id, batchId: b.id });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: paired.id,
        categoryId: groceries.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(TransferPairedTransactionError);
  });

  it("throws CategoryNotFoundError / Parent / SavingsGoal before opening the transaction", () => {
    const a = seedAccount();
    const b = seedBatch();
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: target.id,
        categoryId: 999_999,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(CategoryNotFoundError);

    const parent = seedCategory("Housing");
    seedCategory("Rent", { parentId: parent.id });
    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: target.id,
        categoryId: parent.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(ParentAllocationError);

    const goal = seedCategory("Emergency", { isSavingsGoal: true });
    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: target.id,
        categoryId: goal.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(SavingsGoalCategoryError);
  });
});
