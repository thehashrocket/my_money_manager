import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { getEffectiveAllocation } from "@/lib/budget";
import { bulkCategorize } from "./bulkCategorize";
import { undoBulkCategorize } from "./undoBulkCategorize";

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
  opts: { carryoverPolicy?: "none" | "rollover" | "reset" } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
    })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant: string;
  amountCents: number;
  date?: string;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant,
      amountCents: opts.amountCents,
      categoryId: null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: null,
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

describe("undoBulkCategorize — transactions", () => {
  it("resets txnIds back to NULL", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -2500 });

    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const result = undoBulkCategorize(handle.db, snap);
    expect(result.revertedCount).toBe(2);

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "SAFEWAY"))
      .all();
    expect(rows.every((r) => r.categoryId === null)).toBe(true);
  });

  it("leaves rows alone that the user re-categorized after the snapshot", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const t1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });
    const t2 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -2500 });

    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    // User moves one row to Household after the bulk.
    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    const result = undoBulkCategorize(handle.db, snap);
    expect(result.revertedCount).toBe(1);

    const afterT1 = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, t1.id))
      .get();
    const afterT2 = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, t2.id))
      .get();
    expect(afterT1?.categoryId).toBe(household.id);
    expect(afterT2?.categoryId).toBeNull();
  });

  it("is a no-op on transactions when snapshot.txnIds is empty", () => {
    const groceries = seedCategory("Groceries");
    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "NO MATCH",
      categoryId: groceries.id,
      rememberMerchant: false,
    });
    expect(snap.txnIds).toHaveLength(0);

    const result = undoBulkCategorize(handle.db, snap);
    expect(result.revertedCount).toBe(0);
  });
});

describe("undoBulkCategorize — rule rollback (3 cases)", () => {
  it("case 1: no prior rule → undo deletes the inserted rule", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
    });
    expect(handle.db.select().from(schema.categoryRules).all()).toHaveLength(1);

    const result = undoBulkCategorize(handle.db, snap);
    expect(result.ruleAction).toBe("deleted");
    expect(handle.db.select().from(schema.categoryRules).all()).toHaveLength(0);
  });

  it("case 2: same-target prior rule → undo restores priority + timestamps", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const [prior] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: groceries.id,
        matchType: "exact",
        matchValue: "SAFEWAY",
        priority: 77,
        source: "manual",
      })
      .returning()
      .all();

    // Wait a second so bulk upsert produces a measurably newer updated_at.
    // Prior-row timestamps get restored verbatim on undo.
    await new Promise((r) => setTimeout(r, 1100));

    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    const result = undoBulkCategorize(handle.db, snap);
    expect(result.ruleAction).toBe("restored");

    const restored = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.id, prior.id))
      .get();
    expect(restored?.categoryId).toBe(groceries.id);
    expect(restored?.priority).toBe(77);
    expect(restored?.updatedAt.getTime()).toBe(prior.updatedAt.getTime());
    expect(restored?.createdAt.getTime()).toBe(prior.createdAt.getTime());
  });

  it("case 3: different-target prior rule → undo restores the full prior row", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const [prior] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "exact",
        matchValue: "SAFEWAY",
        priority: 42,
        source: "auto",
      })
      .returning()
      .all();

    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
    });
    const duringBulk = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.id, prior.id))
      .get();
    expect(duringBulk?.categoryId).toBe(groceries.id);

    const result = undoBulkCategorize(handle.db, snap);
    expect(result.ruleAction).toBe("restored");

    const restored = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.id, prior.id))
      .get();
    expect(restored?.categoryId).toBe(dining.id);
    expect(restored?.priority).toBe(42);
    expect(restored?.source).toBe("auto");
  });

  it("ruleAction = 'none' when rememberMerchant was false on the bulk", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const result = undoBulkCategorize(handle.db, snap);
    expect(result.ruleAction).toBe("none");
  });
});

describe("undoBulkCategorize — invalidation", () => {
  it("clears cached effective_allocation_cents from the earliest month onward", () => {
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

    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -5000,
      date: "2026-02-10",
    });

    const snap = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    // Re-prime the cache so we can observe the invalidation from the undo.
    getEffectiveAllocation(handle.db, groceries.id, 2026, 4, { persist: true });
    const beforeApril = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, groceries.id),
          eq(schema.budgetPeriods.month, 4),
        ),
      )
      .get();
    expect(beforeApril?.effectiveAllocationCents).not.toBeNull();

    undoBulkCategorize(handle.db, snap);

    const after = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, groceries.id))
      .all();
    expect(after.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });
});
