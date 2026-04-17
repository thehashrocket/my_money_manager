import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { getEffectiveAllocation } from "@/lib/budget";
import { categorizeTransaction } from "./categorizeTransaction";
import { undoCategorizeTransaction } from "./undoCategorizeTransaction";

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
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

describe("undoCategorizeTransaction — target row", () => {
  it("restores a NULL-prior target back to NULL", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    const undo = undoCategorizeTransaction(handle.db, snapshot);
    expect(undo.targetReverted).toBe(true);

    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(row?.categoryId).toBeNull();
  });

  it("restores target to the exact prior category (re-categorize case)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const household = seedCategory("Household");
    const groceries = seedCategory("Groceries");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: household.id,
    });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    undoCategorizeTransaction(handle.db, snapshot);

    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(row?.categoryId).toBe(household.id);
  });

  it("skips target row that the user re-categorized post-apply (targetReverted=false)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    // Simulate user re-cat before undo.
    handle.db
      .update(schema.transactions)
      .set({ categoryId: other.id })
      .where(eq(schema.transactions.id, target.id))
      .run();

    const undo = undoCategorizeTransaction(handle.db, snapshot);
    expect(undo.targetReverted).toBe(false);
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(row?.categoryId).toBe(other.id);
  });
});

describe("undoCategorizeTransaction — applyToPast", () => {
  it("resets applyToPast rows to NULL", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s2 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });

    const undo = undoCategorizeTransaction(handle.db, snapshot);
    expect(undo.revertedApplyToPastCount).toBe(2);

    for (const id of [s1.id, s2.id]) {
      const row = handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, id))
        .get();
      expect(row?.categoryId).toBeNull();
    }
  });

  it("skips applyToPast rows the user re-touched post-apply", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const target = seedTxn({ accountId: a.id, batchId: b.id });
    const sibling = seedTxn({ accountId: a.id, batchId: b.id });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });

    // User re-cats the sibling to Dining.
    handle.db
      .update(schema.transactions)
      .set({ categoryId: dining.id })
      .where(eq(schema.transactions.id, sibling.id))
      .run();

    const undo = undoCategorizeTransaction(handle.db, snapshot);
    expect(undo.revertedApplyToPastCount).toBe(0);

    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, sibling.id))
      .get();
    expect(row?.categoryId).toBe(dining.id);
  });
});

describe("undoCategorizeTransaction — rule", () => {
  it("deletes the rule when insert was undone (priorRule=null)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    const undo = undoCategorizeTransaction(handle.db, snapshot);
    expect(undo.ruleAction).toBe("deleted");
    expect(handle.db.select().from(schema.categoryRules).all()).toHaveLength(0);
  });

  it("restores the full prior rule verbatim when replace was undone", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
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

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    const undo = undoCategorizeTransaction(handle.db, snapshot);
    expect(undo.ruleAction).toBe("restored");

    const restored = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.id, prior.id))
      .get();
    expect(restored).toEqual({
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

  it("is a no-op on rules when ruleTouched=false", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    const undo = undoCategorizeTransaction(handle.db, snapshot);
    expect(undo.ruleAction).toBe("none");
  });
});

describe("undoCategorizeTransaction — invalidation", () => {
  it("invalidates new category on undo starting at earliest(target, applyToPast)", () => {
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

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: true,
    });

    // Re-persist to verify undo re-clears.
    getEffectiveAllocation(handle.db, groceries.id, 2026, 4, { persist: true });

    undoCategorizeTransaction(handle.db, snapshot);

    const rows = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, groceries.id))
      .all();
    // Feb/Mar/Apr all cleared on undo (floor = Feb).
    expect(rows.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });

  it("invalidates prior category on undo (spend moving back)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household", { carryoverPolicy: "rollover" });
    handle.db
      .insert(schema.budgetPeriods)
      .values({ categoryId: household.id, year: 2026, month: 4, allocatedCents: 1000 })
      .run();

    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: household.id,
      date: "2026-04-10",
    });

    const snapshot = categorizeTransaction(handle.db, {
      transactionId: target.id,
      categoryId: groceries.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    getEffectiveAllocation(handle.db, household.id, 2026, 4, { persist: true });

    undoCategorizeTransaction(handle.db, snapshot);

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
    expect(apr?.effectiveAllocationCents).toBeNull();
  });
});
