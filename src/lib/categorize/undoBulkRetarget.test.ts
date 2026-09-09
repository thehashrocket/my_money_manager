import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { bulkRetarget } from "./bulkRetarget";
import { undoBulkRetarget } from "./undoBulkRetarget";

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

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant: string;
  amountCents: number;
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
      normalizedMerchant: opts.merchant,
      amountCents: opts.amountCents,
      categoryId: opts.categoryId ?? null,
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

function exactRuleFor(matchValue: string) {
  return handle.db
    .select()
    .from(schema.categoryRules)
    .where(
      and(
        eq(schema.categoryRules.matchType, "exact"),
        eq(schema.categoryRules.matchValue, matchValue),
      ),
    )
    .get();
}

describe("undoBulkRetarget — transactions", () => {
  /* The one behavioural difference from `undoBulkCategorize`, which resets to
     a hardcoded NULL: rows go back to the category they came FROM. */
  it("puts the rows back under the source category, not NULL", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -2500, categoryId: gas.id });

    const snap = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const result = undoBulkRetarget(handle.db, snap);
    expect(result.revertedCount).toBe(2);

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "COSTCO"))
      .all();
    expect(rows.every((r) => r.categoryId === gas.id)).toBe(true);
  });

  it("leaves rows alone that the user re-categorized after the snapshot", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const t1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -2500, categoryId: gas.id });

    const snap = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    handle.db
      .update(schema.transactions)
      .set({ categoryId: household.id })
      .where(eq(schema.transactions.id, t1.id))
      .run();

    const result = undoBulkRetarget(handle.db, snap);
    expect(result.revertedCount).toBe(1);

    const afterT1 = handle.db.select().from(schema.transactions).where(eq(schema.transactions.id, t1.id)).get();
    expect(afterT1?.categoryId).toBe(household.id);
  });

  it("reverts nothing on a second run rather than moving rows twice", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    const snap = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(undoBulkRetarget(handle.db, snap).revertedCount).toBe(1);
    expect(undoBulkRetarget(handle.db, snap).revertedCount).toBe(0);

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "COSTCO"))
      .all();
    expect(rows.every((r) => r.categoryId === gas.id)).toBe(true);
  });
});

describe("undoBulkRetarget — rules", () => {
  it("deletes a rule the retarget inserted", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    const snap = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: true,
    });
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(groceries.id);

    const result = undoBulkRetarget(handle.db, snap);
    expect(result.ruleAction).toBe("deleted");
    expect(exactRuleFor("COSTCO")).toBeUndefined();
  });

  it("reports already-gone when someone else removed the inserted rule first", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    const snap = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    handle.db.delete(schema.categoryRules).where(eq(schema.categoryRules.id, snap.insertedRuleId!)).run();

    expect(undoBulkRetarget(handle.db, snap).ruleAction).toBe("already-gone");
  });

  it("restores a rule the retarget overwrote", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    handle.db
      .insert(schema.categoryRules)
      .values({ categoryId: gas.id, matchType: "exact", matchValue: "COSTCO", priority: 0, source: "manual" })
      .run();

    const snap = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: true,
    });
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(groceries.id);

    const result = undoBulkRetarget(handle.db, snap);
    expect(result.ruleAction).toBe("restored");
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(gas.id);
  });

  /* The case the refusal-deletion exists for, run in reverse: a refusal that
     REMOVED a rule must be undoable, or the removal is permanent and there is
     no rules surface to rebuild it from. */
  it("restores a rule a refusal removed", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const household = seedCategory("Household");
    const dining = seedCategory("Dining");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -900, categoryId: household.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -400, categoryId: dining.id });
    handle.db
      .insert(schema.categoryRules)
      .values({ categoryId: gas.id, matchType: "exact", matchValue: "COSTCO", priority: 0, source: "manual" })
      .run();

    const snap = bulkRetarget(
      handle.db,
      {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: groceries.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );
    expect(exactRuleFor("COSTCO")).toBeUndefined();

    const result = undoBulkRetarget(handle.db, snap);
    expect(result.ruleAction).toBe("restored");
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(gas.id);
  });

  it("leaves rules alone when the retarget never touched one", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    const snap = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(undoBulkRetarget(handle.db, snap).ruleAction).toBe("none");
  });
});

/*
 * Snapshot shapes the SCHEMA admits but `bulkRetarget` cannot produce.
 *
 * `validateBulkRetargetSnapshot` types `txnIds`, `priorRule` and
 * `insertedRuleId` independently — no `.min(1)`, both nullables free — so a
 * crafted or hand-edited Undo post can reach `undoBulkRetarget` in states no
 * real call ever returns. `applyRuleWrite` proves the second one is
 * unreachable honestly: it sets `ruleTouched: true` only alongside a non-null
 * `priorRule` (refusal path) or a non-null `insertedRuleId` (upsert path).
 * Both branches are therefore defensive, and defensive branches are exactly
 * the ones nothing in ordinary use would reveal had broken.
 */
describe("undoBulkRetarget — snapshot shapes only a crafted post can produce", () => {
  it("reverts nothing, and touches nothing, for an empty txnIds", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO",
      amountCents: -5000,
      categoryId: groceries.id,
    });

    const result = undoBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      txnIds: [],
      ruleTouched: false,
      priorRule: null,
      insertedRuleId: null,
      earliestDate: "2026-04-05",
    });

    expect(result).toEqual({ revertedCount: 0, ruleAction: "none" });
    // The guard matters: an unguarded `inArray(id, [])` compiles to a WHERE
    // that must match nothing, and a row filed at `categoryId` sitting right
    // there is what would notice if it ever stopped.
    expect(
      handle.db
        .select({ categoryId: schema.transactions.categoryId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, txn.id))
        .get()?.categoryId,
    ).toBe(groceries.id);
  });

  it("reports 'none' when ruleTouched is set but neither rule field is", () => {
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: groceries.id,
        matchType: "exact",
        matchValue: "COSTCO",
        priority: 0,
        source: "manual",
      })
      .run();

    const result = undoBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      txnIds: [],
      ruleTouched: true,
      priorRule: null,
      insertedRuleId: null,
      earliestDate: "2026-04-05",
    });

    expect(result.ruleAction).toBe("none");
    // And critically: it does not fall through to deleting SOMETHING. An
    // unrelated rule on the same key survives an undo that names no rule.
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(groceries.id);
  });
});

describe("undoBulkRetarget — a crafted snapshot is bounded by its merchant", () => {
  /* The forward path guards its destination with `assertAssignableCategory`;
     this one deliberately cannot, because `bulkRetarget` allows an archived,
     fund or parent SOURCE and a legitimate undo has to restore into one. The
     merchant condition is what stops a hand-edited payload — every field
     round-trips through the browser — from becoming "move these ids into that
     category" against the whole ledger. */
  it("refuses to move rows belonging to a different merchant", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");

    // A row under the same category, but a DIFFERENT merchant key — the shape
    // a crafted snapshot uses to reach rows the retarget never touched.
    const other = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      merchant: "SAFEWAY",
      amountCents: -2500,
      categoryId: groceries.id,
    });

    const result = undoBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      txnIds: [other.id],
      ruleTouched: false,
      priorRule: null,
      insertedRuleId: null,
      earliestDate: "2026-04-05",
    });

    expect(result.revertedCount).toBe(0);
    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, other.id))
      .get();
    expect(after?.categoryId).toBe(groceries.id);
  });

  it("still reverts the honest case, where the merchant matches", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      merchant: "COSTCO",
      amountCents: -5000,
      categoryId: gas.id,
    });

    bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const result = undoBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      txnIds: [txn.id],
      ruleTouched: false,
      priorRule: null,
      insertedRuleId: null,
      earliestDate: "2026-04-05",
    });

    expect(result.revertedCount).toBe(1);
    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(after?.categoryId).toBe(gas.id);
  });

  /* The empty key is a real stored value (a blank Memo cell normalizes to
     ""), and all three validators accept it on purpose. The new condition
     must not turn that group into one that cannot be undone. */
  it("round-trips the empty merchant key", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      merchant: "",
      amountCents: -1200,
      categoryId: gas.id,
    });

    bulkRetarget(handle.db, {
      normalizedMerchant: "",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const result = undoBulkRetarget(handle.db, {
      normalizedMerchant: "",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      txnIds: [txn.id],
      ruleTouched: false,
      priorRule: null,
      insertedRuleId: null,
      earliestDate: "2026-04-05",
    });

    expect(result.revertedCount).toBe(1);
    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(after?.categoryId).toBe(gas.id);
  });
});
