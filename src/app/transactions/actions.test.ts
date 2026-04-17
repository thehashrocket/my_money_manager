import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { categorizeTransaction } from "@/lib/categorize/categorizeTransaction";
import { undoCategorizeTransaction } from "@/lib/categorize/undoCategorizeTransaction";
import { validateCategorizeTransactionInput } from "@/lib/categorize/validateCategorizeTransactionInput";

/**
 * Mirrors `categorizeTransactionAction` + `undoCategorizeTransactionAction`
 * minus the Next.js shell (`revalidatePath` closes over the singleton DB
 * and can't run under `:memory:`). Exercises the exact pipeline:
 *
 *   FormData → validate → categorizeTransaction(db) → snapshot
 *   snapshot → undoCategorizeTransaction(db)
 */

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

function seedCategory(name: string) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-${seq}` })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant?: string;
  categoryId?: number | null;
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
      normalizedMerchant: opts.merchant ?? "SAFEWAY",
      amountCents: -1500,
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

describe("categorizeTransactionAction — end-to-end pipeline", () => {
  it("validates string FormData values and flips the target", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    // Simulates Object.fromEntries(formData) — all values are strings.
    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
      rememberMerchant: "false",
      applyToPast: "false",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);

    expect(result.updatedCount).toBe(1);
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(row?.categoryId).toBe(groceries.id);
  });

  it("rejects tampered transactionId (non-integer)", () => {
    const parsed = validateCategorizeTransactionInput({
      transactionId: "abc",
      categoryId: "1",
    });
    expect(parsed.success).toBe(false);
  });

  it("applyToPast fans out to NULL siblings for the target's merchant", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s2 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
      applyToPast: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);

    expect(result.updatedCount).toBe(3);
    expect(result.applyToPastTxnIds.sort()).toEqual([s1.id, s2.id].sort());
  });

  it("round-trip: categorize → snapshot → undo restores the prior state", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: household.id,
    });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
      rememberMerchant: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);
    const snapshot = {
      normalizedMerchant: result.normalizedMerchant,
      newCategoryId: result.newCategoryId,
      targetTxnId: result.targetTxnId,
      targetPriorCategoryId: result.targetPriorCategoryId,
      targetDate: result.targetDate,
      applyToPastTxnIds: result.applyToPastTxnIds,
      earliestApplyToPastDate: result.earliestApplyToPastDate,
      ruleTouched: result.ruleTouched,
      priorRule: result.priorRule,
    };

    undoCategorizeTransaction(handle.db, snapshot);

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(after?.categoryId).toBe(household.id);
    expect(handle.db.select().from(schema.categoryRules).all()).toHaveLength(0);
  });

  it("returns a snapshot shaped to survive JSON round-trip (Server Action return value)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);

    const json = JSON.parse(
      JSON.stringify({
        normalizedMerchant: result.normalizedMerchant,
        newCategoryId: result.newCategoryId,
        targetTxnId: result.targetTxnId,
        targetPriorCategoryId: result.targetPriorCategoryId,
        targetDate: result.targetDate,
        applyToPastTxnIds: result.applyToPastTxnIds,
        earliestApplyToPastDate: result.earliestApplyToPastDate,
        ruleTouched: result.ruleTouched,
        priorRule: result.priorRule,
      }),
    );
    expect(json.targetTxnId).toBe(target.id);
    expect(json.newCategoryId).toBe(groceries.id);
    expect(json.priorRule).toBeNull();
  });
});
