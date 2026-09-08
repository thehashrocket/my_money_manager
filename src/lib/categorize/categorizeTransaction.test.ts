import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { primeCache as primeCacheOnDb } from "@/lib/test/primeCache";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";
import { categorizeTransaction } from "./categorizeTransaction";
import { undoCategorizeTransaction } from "./undoCategorizeTransaction";
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
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  return row;
}

function seedCategory(
  name: string,
  opts: {
    parentId?: number | null;
    isSavingsGoal?: boolean;
    kind?: "income" | "expense" | "fund";
    carryoverPolicy?: "none" | "rollover" | "reset";
    archivedAt?: Date | null;
  } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: opts.parentId ?? null,
      isSavingsGoal: opts.isSavingsGoal ?? false,
      kind: opts.kind ?? "expense",
      carryoverPolicy: opts.carryoverPolicy ?? "none",
      archivedAt: opts.archivedAt ?? null,
    })
    .returning()
    .all();
  return row;
}

function primeCache(categoryId: number, year: number, month: number) {
  return primeCacheOnDb(handle.db, categoryId, year, month);
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
    expect(handle.db.select().from(schema.categoryRules).where(eq(schema.categoryRules.matchType, "exact")).all()).toHaveLength(0);
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
    primeCache(groceries.id, 2026, 4);

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
    primeCache(household.id, 2026, 3);
    primeCache(household.id, 2026, 4);

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
    primeCache(other.id, 2026, 4);

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

    const goal = seedCategory("Emergency", { isSavingsGoal: true, kind: "fund" });
    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: target.id,
        categoryId: goal.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(SavingsGoalCategoryError);
  });

  it("(TC22, A2) throws for a kind='fund' category even when isSavingsGoal=0 (drift)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const target = seedTxn({ accountId: a.id, batchId: b.id });
    const goal = seedCategory("Drifted Fund", { isSavingsGoal: false, kind: "fund" });

    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: target.id,
        categoryId: goal.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(SavingsGoalCategoryError);
  });

  it("(X3) throws CategoryArchivedError for an archived category — the picker's exclusion is client-side only", () => {
    const a = seedAccount();
    const b = seedBatch();
    const target = seedTxn({ accountId: a.id, batchId: b.id });
    const archived = seedCategory("Old Gym", { archivedAt: new Date() });

    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: target.id,
        categoryId: archived.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).toThrow(CategoryArchivedError);
  });

  it("(TC22b, E6) does not throw for a kind='expense' category even when isSavingsGoal=1 (inverse drift)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const target = seedTxn({ accountId: a.id, batchId: b.id });
    const cat = seedCategory("Drifted Expense", { isSavingsGoal: true, kind: "expense" });

    expect(() =>
      categorizeTransaction(handle.db, {
        transactionId: target.id,
        categoryId: cat.id,
        rememberMerchant: false,
        applyToPast: false,
      }),
    ).not.toThrow();
  });
});

describe("categorizeTransaction — Remember guard", () => {
  it("files the row but writes no rule for a lossy key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "MOBILE",
      amountCents: -2500,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: gifts.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.updatedCount).toBe(1);
    expect(result.ruleTouched).toBe(false);
    expect(result.ruleRefusal?.reason).toBe("lossy-key");
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "MOBILE"))
        .all(),
    ).toHaveLength(0);
  });

  it("judges the key BEFORE its own UPDATE lands", () => {
    // This function files the target row first and reaches the rule block
    // last. Read at the rule site, the target's brand-new category would count
    // as prior evidence: a key with one prior filing under Amazon plus this
    // row now under Amazon would look like one category (fine), but a FIRST
    // ever row would look like one category too — hiding the real question.
    // Here history says Amazon and the pick says HomeGoods, so the union is
    // two and the rule must be refused. If the check ran after the UPDATE it
    // would still see two, so the sharper assertion is the next test.
    const a = seedAccount();
    const b = seedBatch();
    const amazon = seedCategory("Amazon");
    const homeGoods = seedCategory("HomeGoods");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: amazon.id,
    });
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -1500,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: homeGoods.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.ruleRefusal?.reason).toBe("multi-category");
    expect(result.ruleTouched).toBe(false);
  });

  it("re-filing a row from one category to the SAME one stays trainable", () => {
    // The order-dependence guard. The target already carries Groceries, and
    // the user re-files it to Groceries with Remember ticked. Union = {
    // Groceries } either way, so this must stay trainable — a check that
    // double-counted the row's before and after states would see two.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
      categoryId: groceries.id,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: groceries.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.ruleRefusal).toBeNull();
    expect(result.ruleTouched).toBe(true);
  });

  it("MOVING a row off its only category does not refuse on the category it left", () => {
    // The target is the key's ONLY filed row, under Groceries, and the user
    // moves it to Dining with Remember ticked. After the move the key is
    // unanimously Dining, so one rule IS right and the box must work. Reading
    // filings before the UPDATE means Groceries is still in the set, which is
    // the one case where the pre-check is more conservative than the truth —
    // pinned here so a future change that "fixes" it is a deliberate choice.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "JACK IN THE BOX",
      amountCents: -1200,
      categoryId: groceries.id,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: dining.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.ruleRefusal?.reason).toBe("multi-category");
    expect(result.ruleTouched).toBe(false);
  });

  it("still writes the rule for an ordinary key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: groceries.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.ruleRefusal).toBeNull();
    expect(result.ruleTouched).toBe(true);
  });

  it("does not refuse when Remember was never ticked", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "ONLINE",
      amountCents: -2500,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: gifts.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    expect(result.ruleRefusal).toBeNull();
  });
});

describe("categorizeTransaction — Remember guard, boundary cases", () => {
  it("still applies to past rows when the rule is refused", () => {
    // The refusal withholds the RULE only. applyToPast is a second explicit
    // instruction about rows the user can see, so it must survive a verdict
    // about generalizing to rows they cannot.
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "ONLINE",
      amountCents: -2500,
    });
    const past1 = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "ONLINE",
      amountCents: -1000,
      date: "2026-03-01",
    });
    const past2 = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "ONLINE",
      amountCents: -700,
      date: "2026-02-01",
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: gifts.id,
      rememberMerchant: true,
      applyToPast: true,
    });

    expect(result.ruleRefusal?.reason).toBe("lossy-key");
    expect(result.ruleTouched).toBe(false);
    expect(result.updatedCount).toBe(3);
    expect(result.applyToPastTxnIds.sort()).toEqual([past1.id, past2.id].sort());
    expect(result.earliestApplyToPastDate).toBe("2026-02-01");

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "ONLINE"))
      .all();
    expect(rows.every((r) => r.categoryId === gifts.id)).toBe(true);
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "ONLINE"))
        .all(),
    ).toHaveLength(0);
  });

  it("DELETES an existing rule when it refuses, and the undo puts it back", () => {
    /* This row is the ONLY surface that could ever retarget an exact rule:
       `/categorize` never lists a merchant whose rule has already filed its
       rows. Refusing here while leaving the rule standing therefore made the
       rule permanent — and the refusal fires precisely because those filed
       rows disagree with the pick, so it fires on every retrain attempt. The
       rule goes, snapshotted for undo. */
    const a = seedAccount();
    const b = seedBatch();
    const amazon = seedCategory("Amazon");
    const homeGoods = seedCategory("HomeGoods");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: amazon.id,
        matchType: "exact",
        matchValue: "AMAZON",
        priority: 50,
        source: "manual",
      })
      .run();
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: amazon.id,
    });
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -1500,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: homeGoods.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.ruleRefusal).not.toBeNull();
    expect(result.refusalDeletedRule).toBe(true);
    expect(result.ruleTouched).toBe(true);
    expect(result.priorRule?.categoryId).toBe(amazon.id);
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "AMAZON"))
        .all(),
    ).toHaveLength(0);
    // The row was still filed — the refusal withholds the rule, not the work.
    expect(result.updatedCount).toBe(1);

    const undone = undoCategorizeTransaction(handle.db, {
      normalizedMerchant: result.normalizedMerchant,
      newCategoryId: result.newCategoryId,
      targetTxnId: result.targetTxnId,
      targetPriorCategoryId: result.targetPriorCategoryId,
      targetDate: result.targetDate,
      applyToPastTxnIds: result.applyToPastTxnIds,
      earliestApplyToPastDate: result.earliestApplyToPastDate,
      ruleTouched: result.ruleTouched,
      priorRule: result.priorRule,
    });
    expect(undone.ruleAction).toBe("restored");
    const restored = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.matchValue, "AMAZON"))
      .get();
    expect(restored?.categoryId).toBe(amazon.id);
    expect(restored?.priority).toBe(50);
  });

  it("does NOT delete a rule when Remember was not ticked", () => {
    /* The deletion is downstream of a refusal, and a refusal only exists when
       Remember was ticked. Filing a row on an untrainable key without asking
       to train it must leave the rules table alone. */
    const a = seedAccount();
    const b = seedBatch();
    const amazon = seedCategory("Amazon");
    const homeGoods = seedCategory("HomeGoods");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: amazon.id,
        matchType: "exact",
        matchValue: "AMAZON",
        priority: 50,
        source: "manual",
      })
      .run();
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: amazon.id,
    });
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -1500,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: homeGoods.id,
      rememberMerchant: false,
      applyToPast: false,
    });

    expect(result.ruleRefusal).toBeNull();
    expect(result.refusalDeletedRule).toBe(false);
    const rule = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.matchValue, "AMAZON"))
      .get();
    expect(rule?.categoryId).toBe(amazon.id);
  });

  it("refuses the EMPTY key with the blank-key wording", () => {
    const a = seedAccount();
    const b = seedBatch();
    const misc = seedCategory("Misc");
    const t = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "",
      amountCents: -1000,
    });

    const result = categorizeTransaction(handle.db, {
      transactionId: t.id,
      categoryId: misc.id,
      rememberMerchant: true,
      applyToPast: false,
    });

    expect(result.updatedCount).toBe(1);
    expect(result.ruleTouched).toBe(false);
    expect(result.ruleRefusal?.reason).toBe("lossy-key");
    expect(result.ruleRefusal?.message).toContain("no merchant name");
  });
});
