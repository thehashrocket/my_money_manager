import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { getEffectiveAllocation } from "@/lib/budget";
import { countRevertibleCategorizations, undoImportCategorization } from "./undoImportCategorization";

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
    .values({ source: "csv", label: "seed.csv" })
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

/** A rule-categorized row, as `commitImport`/`syncSimpleFin` write it: the
 * transaction gets `categoryId` at insert, and an
 * `import_batch_categorizations` row records what was applied. */
function seedCategorizedTxn(opts: {
  accountId: number;
  batchId: number;
  categoryId: number;
  merchant?: string;
  date?: string;
}) {
  seq += 1;
  const [txn] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant ?? "SAFEWAY",
      amountCents: -5000,
      categoryId: opts.categoryId,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: null,
      isPending: false,
    })
    .returning()
    .all();

  handle.db
    .insert(schema.importBatchCategorizations)
    .values({
      importBatchId: opts.batchId,
      transactionId: txn.id,
      categoryId: opts.categoryId,
    })
    .run();

  return txn;
}

describe("undoImportCategorization — transactions", () => {
  it("reverts every row the batch auto-categorized back to NULL", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    const result = undoImportCategorization(handle.db, b.id);
    expect(result).toEqual({ status: "reverted", revertedCount: 2, skippedCount: 0 });

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.importBatchId, b.id))
      .all();
    expect(rows.every((r) => r.categoryId === null)).toBe(true);
  });

  it("leaves a row alone that the user re-categorized since import (stale-row-safe)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const t1 = seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    const t2 = seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    const result = undoImportCategorization(handle.db, b.id);
    expect(result).toEqual({ status: "reverted", revertedCount: 1, skippedCount: 1 });

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

  // Codex structured review, /ship 2026-09-03: a categoryId-only stale check
  // would wrongly treat this as "untouched" and wipe a deliberate later choice
  // to NULL. Pinned so a future edit can't drop the updatedAt/createdAt
  // ordering check and regress silently.
  it("leaves a row alone even when it lands back on the SAME category the rule set (touched in between)", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const t1 = seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    // Force a measurably later `updatedAt` than the audit row's `createdAt`
    // (unixepoch() has 1-second resolution — see undoBulkCategorize.test.ts's
    // "same-target prior rule" case for the same precaution).
    await new Promise((r) => setTimeout(r, 1100));

    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id, updatedAt: new Date() })
      .where(eq(schema.transactions.id, t1.id))
      .run();
    handle.db
      .update(schema.transactions)
      .set({ categoryId: groceries.id, updatedAt: new Date() })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    const result = undoImportCategorization(handle.db, b.id);
    expect(result).toEqual({ status: "reverted", revertedCount: 0, skippedCount: 1 });

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, t1.id))
      .get();
    expect(after?.categoryId).toBe(groceries.id);
  });

  it("leaves a row alone that the user manually cleared back to NULL since import", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const t1 = seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    handle.db
      .update(schema.transactions)
      .set({ categoryId: null })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    const result = undoImportCategorization(handle.db, b.id);
    expect(result).toEqual({ status: "reverted", revertedCount: 0, skippedCount: 1 });
  });

  it("handles multiple categories in one batch, each with its own group", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const gas = seedCategory("Gas");
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id, merchant: "SAFEWAY" });
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id, merchant: "TRADER JOES" });
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: gas.id, merchant: "SHELL" });

    const result = undoImportCategorization(handle.db, b.id);
    expect(result).toEqual({ status: "reverted", revertedCount: 3, skippedCount: 0 });

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.importBatchId, b.id))
      .all();
    expect(rows.every((r) => r.categoryId === null)).toBe(true);
  });

  it("returns nothing-to-undo when the batch never auto-categorized anything", () => {
    const b = seedBatch();
    const result = undoImportCategorization(handle.db, b.id);
    expect(result).toEqual({ status: "nothing-to-undo" });
  });

  it("returns nothing-to-undo on a second call — the audit trail is consumed", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    undoImportCategorization(handle.db, b.id);
    const second = undoImportCategorization(handle.db, b.id);
    expect(second).toEqual({ status: "nothing-to-undo" });

    expect(
      handle.db
        .select()
        .from(schema.importBatchCategorizations)
        .where(eq(schema.importBatchCategorizations.importBatchId, b.id))
        .all(),
    ).toHaveLength(0);
  });

  it("does not touch a different batch's rows", () => {
    const a = seedAccount();
    const b1 = seedBatch();
    const b2 = seedBatch();
    const groceries = seedCategory("Groceries");
    seedCategorizedTxn({ accountId: a.id, batchId: b1.id, categoryId: groceries.id });
    const other = seedCategorizedTxn({ accountId: a.id, batchId: b2.id, categoryId: groceries.id });

    undoImportCategorization(handle.db, b1.id);

    const afterOther = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, other.id))
      .get();
    expect(afterOther?.categoryId).toBe(groceries.id);
  });
});

describe("undoImportCategorization — invalidation", () => {
  it("invalidates each category's rollover cache independently when a batch spans multiple categories", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    const gas = seedCategory("Gas", { carryoverPolicy: "rollover" });
    handle.db
      .insert(schema.budgetPeriods)
      .values([
        { categoryId: groceries.id, year: 2026, month: 4, allocatedCents: 1000 },
        { categoryId: gas.id, year: 2026, month: 4, allocatedCents: 1000 },
      ])
      .run();

    seedCategorizedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: groceries.id,
      merchant: "SAFEWAY",
      date: "2026-02-10",
    });
    seedCategorizedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: gas.id,
      merchant: "SHELL",
      date: "2026-03-10",
    });

    getEffectiveAllocation(handle.db, groceries.id, 2026, 4, { persist: true });
    getEffectiveAllocation(handle.db, gas.id, 2026, 4, { persist: true });

    undoImportCategorization(handle.db, b.id);

    const groceriesPeriod = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(eq(schema.budgetPeriods.categoryId, groceries.id), eq(schema.budgetPeriods.month, 4)),
      )
      .get();
    const gasPeriod = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(and(eq(schema.budgetPeriods.categoryId, gas.id), eq(schema.budgetPeriods.month, 4)))
      .get();
    expect(groceriesPeriod?.effectiveAllocationCents).toBeNull();
    expect(gasPeriod?.effectiveAllocationCents).toBeNull();
  });

  it("clears cached effective_allocation_cents from the earliest reverted month onward, per category", () => {
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

    seedCategorizedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: groceries.id,
      date: "2026-02-10",
    });

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

    undoImportCategorization(handle.db, b.id);

    const after = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, groceries.id))
      .all();
    expect(after.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });

  it("does not invalidate a category with no actually-reverted rows (all stale)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    const household = seedCategory("Household");
    handle.db
      .insert(schema.budgetPeriods)
      .values([{ categoryId: groceries.id, year: 2026, month: 4, allocatedCents: 1000 }])
      .run();

    const t1 = seedCategorizedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: groceries.id,
      date: "2026-02-10",
    });
    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    getEffectiveAllocation(handle.db, groceries.id, 2026, 4, { persist: true });
    const before = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, groceries.id),
          eq(schema.budgetPeriods.month, 4),
        ),
      )
      .get();
    expect(before?.effectiveAllocationCents).not.toBeNull();

    undoImportCategorization(handle.db, b.id);

    const after = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, groceries.id),
          eq(schema.budgetPeriods.month, 4),
        ),
      )
      .get();
    // The Groceries row was skipped as stale (now Household), so nothing
    // actually reverted for Groceries — its cache must stay intact.
    expect(after?.effectiveAllocationCents).not.toBeNull();
  });
});

describe("countRevertibleCategorizations", () => {
  it("counts every audit row when nothing has been re-categorized since import", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    expect(countRevertibleCategorizations(handle.db, b.id)).toBe(2);
  });

  // The bug this function exists to fix: a naive COUNT(*) over
  // import_batch_categorizations would still say 2, overstating what undo
  // can actually revert (Red Team, /ship 2026-09-03).
  it("excludes a row the user has since re-categorized, unlike a bare COUNT(*)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const t1 = seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    expect(countRevertibleCategorizations(handle.db, b.id)).toBe(1);

    const rawCount = handle.db
      .select()
      .from(schema.importBatchCategorizations)
      .where(eq(schema.importBatchCategorizations.importBatchId, b.id))
      .all().length;
    expect(rawCount).toBe(2);
  });

  it("returns 0 for a batch with no audit rows", () => {
    const b = seedBatch();
    expect(countRevertibleCategorizations(handle.db, b.id)).toBe(0);
  });

  it("matches undoImportCategorization's own revertedCount", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const t1 = seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    const before = countRevertibleCategorizations(handle.db, b.id);
    const result = undoImportCategorization(handle.db, b.id);
    expect(result).toEqual({ status: "reverted", revertedCount: before, skippedCount: 1 });
  });

  // Same scenario as undoImportCategorization's "touched in between" test —
  // pinned here too so the count and the actual revert can never drift apart.
  it("excludes a row touched and landed back on the same category (not just categoryId-different rows)", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const t1 = seedCategorizedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });

    await new Promise((r) => setTimeout(r, 1100));

    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id, updatedAt: new Date() })
      .where(eq(schema.transactions.id, t1.id))
      .run();
    handle.db
      .update(schema.transactions)
      .set({ categoryId: groceries.id, updatedAt: new Date() })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    expect(countRevertibleCategorizations(handle.db, b.id)).toBe(0);
  });
});
