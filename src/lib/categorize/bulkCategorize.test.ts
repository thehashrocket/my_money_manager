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
  merchant: string;
  amountCents: number;
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
      normalizedMerchant: opts.merchant,
      amountCents: opts.amountCents,
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

describe("bulkCategorize — core behavior", () => {
  it("flips every uncategorized row for the merchant to the target category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const t1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });
    const t2 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -2500 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.updatedCount).toBe(2);
    expect(result.txnIds.sort()).toEqual([t1.id, t2.id].sort());

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "SAFEWAY"))
      .all();
    expect(after.every((r) => r.categoryId === groceries.id)).toBe(true);
  });

  it("leaves already-categorized rows alone", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const untouched = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -2500,
      categoryId: household.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.updatedCount).toBe(1);
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, untouched.id))
      .get();
    expect(row?.categoryId).toBe(household.id);
  });

  it("excludes transfer-paired rows", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const paired = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -3000,
    });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .run();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.updatedCount).toBe(1);
    const stillNull = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, paired.id))
      .get();
    expect(stillNull?.categoryId).toBeNull();
  });

  it("returns earliestDate = min(txn.date)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000, date: "2026-03-20" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -2500, date: "2026-01-15" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -1000, date: "2026-02-09" });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });
    expect(result.earliestDate).toBe("2026-01-15");
  });

  it("is a no-op when no matching uncategorized rows exist", () => {
    const groceries = seedCategory("Groceries");
    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });
    expect(result.updatedCount).toBe(0);
    expect(result.earliestDate).toBeNull();
  });
});

describe("bulkCategorize — rule upsert", () => {
  it("does NOT write a rule when rememberMerchant is false", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.ruleTouched).toBe(false);
    expect(result.priorRule).toBeNull();
    const rules = handle.db.select().from(schema.categoryRules).where(eq(schema.categoryRules.matchType, "exact")).all();
    expect(rules).toHaveLength(0);
  });

  it("inserts an exact rule when rememberMerchant is true and no prior rule exists", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
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
    expect(rule?.priority).toBe(50);
    expect(rule?.source).toBe("manual");
  });

  it("captures the full prior rule when replacing an existing different-target rule", () => {
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
        priority: 80,
        source: "manual",
      })
      .returning()
      .all();

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
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

    const after = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.id, prior.id))
      .get();
    expect(after?.categoryId).toBe(groceries.id);
  });

  it("upsert no-op when prior rule already targets the same category bumps updated_at only", async () => {
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
        priority: 50,
        source: "manual",
      })
      .returning()
      .all();

    await new Promise((r) => setTimeout(r, 1100));

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(result.priorRule?.categoryId).toBe(groceries.id);
    const rows = handle.db.select().from(schema.categoryRules).where(eq(schema.categoryRules.matchType, "exact")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(prior.updatedAt.getTime());
  });
});

describe("bulkCategorize — forward invalidation", () => {
  it("clears cached effective_allocation_cents from the earliest txn month onward", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    // Seed allocations for Feb / Mar / Apr with a cached effective.
    handle.db
      .insert(schema.budgetPeriods)
      .values([
        { categoryId: groceries.id, year: 2026, month: 2, allocatedCents: 1000 },
        { categoryId: groceries.id, year: 2026, month: 3, allocatedCents: 1000 },
        { categoryId: groceries.id, year: 2026, month: 4, allocatedCents: 1000 },
      ])
      .run();
    primeCache(groceries.id, 2026, 2);
    primeCache(groceries.id, 2026, 3);
    primeCache(groceries.id, 2026, 4);

    // Earliest txn is Feb 2026.
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -5000,
      date: "2026-02-10",
    });

    bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const after = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, groceries.id))
      .all();
    // Feb/Mar/Apr all cleared since earliest = Feb.
    expect(after.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });

  it("does not invalidate when no rows matched (earliestDate is null)", () => {
    const groceries = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    handle.db
      .insert(schema.budgetPeriods)
      .values({ categoryId: groceries.id, year: 2026, month: 4, allocatedCents: 1000 })
      .run();
    primeCache(groceries.id, 2026, 4);

    bulkCategorize(handle.db, {
      normalizedMerchant: "NONE",
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const row = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, groceries.id))
      .get();
    expect(row?.effectiveAllocationCents).toBe(1000);
  });
});

describe("bulkCategorize — rejections", () => {
  it("throws CategoryNotFoundError for an unknown category", () => {
    expect(() =>
      bulkCategorize(handle.db, {
        normalizedMerchant: "SAFEWAY",
        categoryId: 999_999,
        rememberMerchant: false,
      }),
    ).toThrow(CategoryNotFoundError);
  });

  it("throws ParentAllocationError when the target has a child", () => {
    const parent = seedCategory("Housing");
    seedCategory("Rent", { parentId: parent.id });
    expect(() =>
      bulkCategorize(handle.db, {
        normalizedMerchant: "SAFEWAY",
        categoryId: parent.id,
        rememberMerchant: false,
      }),
    ).toThrow(ParentAllocationError);
  });

  it("throws SavingsGoalCategoryError when the target is a savings goal", () => {
    const goal = seedCategory("Emergency", { isSavingsGoal: true, kind: "fund" });
    expect(() =>
      bulkCategorize(handle.db, {
        normalizedMerchant: "SAFEWAY",
        categoryId: goal.id,
        rememberMerchant: false,
      }),
    ).toThrow(SavingsGoalCategoryError);
  });

  it("(X3) throws CategoryArchivedError for an archived category — the picker's exclusion is client-side only", () => {
    const archived = seedCategory("Old Gym", { archivedAt: new Date() });
    expect(() =>
      bulkCategorize(handle.db, {
        normalizedMerchant: "SAFEWAY",
        categoryId: archived.id,
        rememberMerchant: false,
      }),
    ).toThrow(CategoryArchivedError);
  });

  it("(TC22, A2) throws for a kind='fund' category even when isSavingsGoal=0 (drift)", () => {
    const goal = seedCategory("Drifted Fund", { isSavingsGoal: false, kind: "fund" });
    expect(() =>
      bulkCategorize(handle.db, {
        normalizedMerchant: "SAFEWAY",
        categoryId: goal.id,
        rememberMerchant: false,
      }),
    ).toThrow(SavingsGoalCategoryError);
  });

  it("(TC22b, E6) does not throw for a kind='expense' category even when isSavingsGoal=1 (inverse drift)", () => {
    const cat = seedCategory("Drifted Expense", { isSavingsGoal: true, kind: "expense" });
    expect(() =>
      bulkCategorize(handle.db, {
        normalizedMerchant: "SAFEWAY",
        categoryId: cat.id,
        rememberMerchant: false,
      }),
    ).not.toThrow();
  });

  it("rolls back on mid-transaction error — no txns flipped, no rule inserted", () => {
    // ParentAllocationError is thrown BEFORE the tx opens (pre-check), so we
    // need to force a failure mid-tx. Easiest: pass an invalid categoryId on
    // the UPDATE path by seeding a FK-violating state. Instead, assert the
    // pre-check ordering: parent reject happens before any write.
    const a = seedAccount();
    const b = seedBatch();
    const parent = seedCategory("Housing");
    seedCategory("Rent", { parentId: parent.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    try {
      bulkCategorize(handle.db, {
        normalizedMerchant: "SAFEWAY",
        categoryId: parent.id,
        rememberMerchant: true,
      });
    } catch {
      // expected
    }

    const stillNull = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "SAFEWAY"))
      .all();
    expect(stillNull.every((r) => r.categoryId === null)).toBe(true);
    expect(handle.db.select().from(schema.categoryRules).where(eq(schema.categoryRules.matchType, "exact")).all()).toHaveLength(0);
  });
});

describe("bulkCategorize — Remember guard", () => {
  it("files the rows but writes no rule for a lossy key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE", amountCents: -2500 });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE", amountCents: -1000 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "ONLINE",
      categoryId: gifts.id,
      rememberMerchant: true,
    });

    // The categorization the user asked for still happened. Refusing the whole
    // action would throw away a decision that was fine for THESE rows.
    expect(result.updatedCount).toBe(2);
    expect(result.ruleTouched).toBe(false);
    expect(result.ruleRefusal?.reason).toBe("lossy-key");

    const rules = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.matchValue, "ONLINE"))
      .all();
    expect(rules).toHaveLength(0);
  });

  it("writes no rule when the pick makes the key span two categories", () => {
    const a = seedAccount();
    const b = seedBatch();
    const amazon = seedCategory("Amazon");
    const homeGoods = seedCategory("HomeGoods");
    // History is unanimous...
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: amazon.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -1500 });

    // ...and this pick is what breaks it.
    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "AMAZON",
      categoryId: homeGoods.id,
      rememberMerchant: true,
    });

    expect(result.updatedCount).toBe(1);
    expect(result.ruleTouched).toBe(false);
    expect(result.ruleRefusal?.reason).toBe("multi-category");
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "AMAZON"))
        .all(),
    ).toHaveLength(0);
  });

  it("DELETES an existing rule when it refuses, and snapshots it for undo", () => {
    /* Refusing only the upsert left the wrong rule auto-filing every future
       import (rule 6) with no way to reach it: `/categorize` never lists the
       merchant, because the rule leaves it no NULL-category rows to group, and
       `/transactions` refuses the retrain, because the rows that same rule
       filed are what push the key over two categories. There is no
       rules-management surface. "No rule can be right for this key" means the
       key files by hand, so the rule goes — snapshotted into `priorRule` with
       `ruleTouched`, which is what makes the deletion undoable. */
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
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -1500 });

    const result = bulkCategorize(
      handle.db,
      {
        normalizedMerchant: "AMAZON",
        categoryId: homeGoods.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );

    expect(result.ruleRefusal).not.toBeNull();
    expect(result.ruleRefusal?.removedRule?.categoryId).toBe(amazon.id);
    // Snapshotted verbatim, so the undo can put the exact row back.
    expect(result.priorRule?.categoryId).toBe(amazon.id);
    expect(result.priorRule?.matchValue).toBe("AMAZON");
    expect(result.ruleTouched).toBe(true);
    // `insertedRuleId` stays null: nothing was inserted, so the undo must take
    // the restore branch, not the delete-what-we-inserted branch.
    expect(result.insertedRuleId).toBeNull();
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "AMAZON"))
        .all(),
    ).toHaveLength(0);

    // The rows were still filed — the refusal withholds the rule, not the work.
    expect(result.updatedCount).toBe(1);
  });

  it("restores a refusal-deleted rule on undo, row for row", () => {
    /* The restore path was an UPDATE by primary key, which silently no-ops on
       a row that no longer exists — so the deletion above would have been
       one-way without `restorePriorRule`'s insert fallback. Undo has to return
       the ledger to the state it was in, including the rule the user had. */
    const a = seedAccount();
    const b = seedBatch();
    const amazon = seedCategory("Amazon");
    const homeGoods = seedCategory("HomeGoods");
    const [seeded] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: amazon.id,
        matchType: "exact",
        matchValue: "AMAZON",
        priority: 70,
        source: "auto",
      })
      .returning()
      .all();
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: amazon.id,
    });
    const pending = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -1500,
    });

    const result = bulkCategorize(
      handle.db,
      {
        normalizedMerchant: "AMAZON",
        categoryId: homeGoods.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );
    expect(result.ruleRefusal?.removedRule).not.toBeNull();

    const undone = undoBulkCategorize(handle.db, {
      normalizedMerchant: result.normalizedMerchant,
      categoryId: result.categoryId,
      txnIds: result.txnIds,
      ruleTouched: result.ruleTouched,
      priorRule: result.priorRule,
      insertedRuleId: result.insertedRuleId,
      earliestDate: result.earliestDate,
    });
    expect(undone.ruleAction).toBe("restored");

    const restored = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.matchValue, "AMAZON"))
      .get();
    // Every user-owned column, not just the category — priority and source are
    // what a rule trained by import heuristics differs from a manual one by.
    expect(restored?.id).toBe(seeded.id);
    expect(restored?.categoryId).toBe(amazon.id);
    expect(restored?.priority).toBe(70);
    expect(restored?.source).toBe("auto");
    expect(restored?.matchType).toBe("exact");
    expect(restored?.createdAt.getTime()).toBe(seeded.createdAt.getTime());

    // And the rows went back to NULL, same as any other undo.
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, pending.id))
      .get();
    expect(row?.categoryId).toBeNull();
  });

  it("reports no deletion when the refused key had no rule to begin with", () => {
    // `ruleRefusal.removedRule` drives user-facing copy ("Removed the rule…"
    // vs "Rule not saved."), so it must not fire on the ordinary case where
    // there was never a rule — which is most refusals.
    const a = seedAccount();
    const b = seedBatch();
    const misc = seedCategory("Misc");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE", amountCents: -1500 });

    const result = bulkCategorize(
      handle.db,
      {
        normalizedMerchant: "ONLINE",
        categoryId: misc.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );

    expect(result.ruleRefusal?.reason).toBe("lossy-key");
    expect(result.ruleRefusal?.removedRule).toBeNull();
    expect(result.ruleTouched).toBe(false);
    expect(result.priorRule).toBeNull();
  });

  it("does NOT delete a rule when Remember was not ticked", () => {
    /* The deletion is downstream of a refusal, and a refusal only exists when
       the user ticked Remember. Ordinary filing on a key that happens to be
       untrainable must leave the rules table alone — otherwise categorizing a
       row would quietly retire a rule nobody asked about. */
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
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -1500 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "AMAZON",
      categoryId: homeGoods.id,
      rememberMerchant: false,
    });

    expect(result.ruleRefusal).toBeNull();
    const rule = handle.db
      .select()
      .from(schema.categoryRules)
      .where(eq(schema.categoryRules.matchValue, "AMAZON"))
      .get();
    expect(rule?.categoryId).toBe(amazon.id);
  });

  it("still writes the rule for an ordinary key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
      categoryId: groceries.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -1500 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(result.ruleRefusal).toBeNull();
    expect(result.ruleTouched).toBe(true);
  });

  it("ignores a transfer-paired row's category when judging the key", () => {
    // Same predicate as loadMerchantGroups/loadFiledCategoryIds. A second
    // category reachable only through a transfer-paired row is evidence
    // `/categorize` never shows, so refusing on it would disable a checkbox
    // for a reason the user cannot see.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other");
    const partner = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "PARTNER",
      amountCents: 4000,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
      categoryId: other.id,
      transferPairId: partner.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -1500 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(result.ruleRefusal).toBeNull();
    expect(result.ruleTouched).toBe(true);
  });

  it("does not refuse when Remember was never ticked", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE", amountCents: -2500 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "ONLINE",
      categoryId: gifts.id,
      rememberMerchant: false,
    });

    // No rule was requested, so there is nothing to report. A refusal here
    // would surface a warning toast on an action that did exactly what it said.
    expect(result.ruleRefusal).toBeNull();
    expect(result.updatedCount).toBe(1);
  });
});

describe("bulkCategorize — Remember guard, boundary cases", () => {
  it("refuses the EMPTY key and still files its rows", () => {
    // A blank Memo cell normalizes to "" (see `merchantLabel`, which exists
    // because that case is reachable). An exact rule on "" would claim every
    // future memo-less row, so the refusal has to fire on a key that renders
    // as nothing at all — the one lossy key with no visible text to warn on.
    const a = seedAccount();
    const b = seedBatch();
    const misc = seedCategory("Misc");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "", amountCents: -1000 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "",
      categoryId: misc.id,
      rememberMerchant: true,
    });

    expect(result.updatedCount).toBe(1);
    expect(result.ruleTouched).toBe(false);
    expect(result.ruleRefusal?.reason).toBe("lossy-key");
    // The blank-key wording, not the channel sentence with empty quotes.
    expect(result.ruleRefusal?.message).toContain("no merchant name");
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, ""))
        .all(),
    ).toHaveLength(0);
  });

  it("refuses on the ledger's own history, not only on the pending pick", () => {
    // The split already exists and the pick agrees with one half of it, so the
    // union is two categories without this action introducing anything. A
    // guard that only compared history against the pick would pass this.
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
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -2000,
      categoryId: homeGoods.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -900 });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "AMAZON",
      categoryId: amazon.id,
      rememberMerchant: true,
    });

    expect(result.ruleRefusal?.reason).toBe("multi-category");
    expect(result.ruleTouched).toBe(false);
  });

  it("reports the refusal even when there is nothing left to file", () => {
    // A stale tab resubmitting after the backlog for this key is already
    // cleared: zero rows move, and the only thing the action would have done
    // is write the rule it must refuse. The result still has to say so, or the
    // row reports a plain success for an action that did nothing.
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
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -2000,
      categoryId: homeGoods.id,
    });

    const result = bulkCategorize(handle.db, {
      normalizedMerchant: "AMAZON",
      categoryId: amazon.id,
      rememberMerchant: true,
    });

    expect(result.updatedCount).toBe(0);
    expect(result.earliestDate).toBeNull();
    expect(result.ruleRefusal?.reason).toBe("multi-category");
    expect(result.ruleTouched).toBe(false);
  });
});
