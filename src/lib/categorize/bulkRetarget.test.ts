import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { primeCache } from "@/lib/test/primeCache";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";
import { bulkCategorize } from "./bulkCategorize";
import { bulkRetarget } from "./bulkRetarget";
import {
  NoRowsToRetargetError,
  SameCategoryRetargetError,
} from "./bulkRetargetErrors";

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
    carryoverPolicy?: "none" | "rollover" | "reset";
    kind?: "income" | "expense" | "fund";
    archived?: boolean;
    parentId?: number;
  } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
      kind: opts.kind ?? "expense",
      archivedAt: opts.archived ? new Date() : null,
      parentId: opts.parentId ?? null,
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

describe("bulkRetarget — rows", () => {
  it("moves every non-transfer row for the key off the source category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const t1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    const t2 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -2500, categoryId: gas.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.updatedCount).toBe(2);
    expect(result.txnIds.sort()).toEqual([t1.id, t2.id].sort());
    expect(result.fromCategoryId).toBe(gas.id);
    expect(result.categoryId).toBe(groceries.id);

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "COSTCO"))
      .all();
    expect(rows.every((r) => r.categoryId === groceries.id)).toBe(true);
  });

  it("leaves rows filed under a DIFFERENT category alone", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const household = seedCategory("Household");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    const other = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -900, categoryId: household.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.updatedCount).toBe(1);
    const after = handle.db.select().from(schema.transactions).where(eq(schema.transactions.id, other.id)).get();
    expect(after?.categoryId).toBe(household.id);
  });

  it("leaves UNCATEGORIZED rows for the key alone — that is bulkCategorize's job", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    const backlog = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -900 });

    bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const after = handle.db.select().from(schema.transactions).where(eq(schema.transactions.id, backlog.id)).get();
    expect(after?.categoryId).toBeNull();
  });

  it("leaves other merchants alone", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    const shell = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL", amountCents: -4000, categoryId: gas.id });

    bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const after = handle.db.select().from(schema.transactions).where(eq(schema.transactions.id, shell.id)).get();
    expect(after?.categoryId).toBe(gas.id);
  });

  /* Rule 4: a paired row belongs to the transfer machinery and is not spending.
     Every other categorize predicate in the app excludes it, and this one is a
     silent filter rather than a throw because it operates on a SET the user
     never enumerated. */
  it("skips transfer-paired rows rather than moving them", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const plain = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    const partner = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: 5000, categoryId: gas.id });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: partner.id })
      .where(eq(schema.transactions.id, partner.id))
      .run();

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.txnIds).toEqual([plain.id]);
    const after = handle.db.select().from(schema.transactions).where(eq(schema.transactions.id, partner.id)).get();
    expect(after?.categoryId).toBe(gas.id);
  });

  it("reports the earliest moved date, not the first row it happened to read", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -1, categoryId: gas.id, date: "2026-06-01" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -2, categoryId: gas.id, date: "2026-02-14" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -3, categoryId: gas.id, date: "2026-04-30" });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.earliestDate).toBe("2026-02-14");
  });

  /* The empty key is a real stored value (a blank memo normalizes to it) and
     is the group with no other repair path — the same decision the three
     validators document. */
  it("handles the empty merchant key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "", amountCents: -5000, categoryId: gas.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.updatedCount).toBe(1);
  });
});

describe("bulkRetarget — refusals", () => {
  it("refuses when source and destination are the same category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    expect(() =>
      bulkRetarget(handle.db, {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: gas.id,
        rememberMerchant: false,
      }),
    ).toThrow(SameCategoryRetargetError);
  });

  it("refuses when nothing is filed under the source any more", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: groceries.id });

    expect(() =>
      bulkRetarget(handle.db, {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: groceries.id,
        rememberMerchant: false,
      }),
    ).toThrow(NoRowsToRetargetError);
  });

  /* The whole point of the empty-set refusal: `applyRuleWrite` keys off the
     MERCHANT, not off the rows, so a zero-row "move" would otherwise be a live
     path to retraining — or DELETING — a rule with nothing to show for it. */
  it("does not touch the rule when it refuses an empty row set", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: groceries.id });
    handle.db
      .insert(schema.categoryRules)
      .values({ categoryId: groceries.id, matchType: "exact", matchValue: "COSTCO", priority: 0, source: "manual" })
      .run();

    expect(() =>
      bulkRetarget(handle.db, {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: groceries.id,
        rememberMerchant: true,
      }),
    ).toThrow(NoRowsToRetargetError);

    expect(exactRuleFor("COSTCO")?.categoryId).toBe(groceries.id);
  });

  it("refuses an unknown source category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    expect(() =>
      bulkRetarget(handle.db, {
        normalizedMerchant: "COSTCO",
        fromCategoryId: 999_999,
        categoryId: groceries.id,
        rememberMerchant: false,
      }),
    ).toThrow(CategoryNotFoundError);
  });

  it.each([
    ["unknown", () => 999_999, CategoryNotFoundError],
    ["a fund", () => seedCategory("Roof", { kind: "fund" }).id, SavingsGoalCategoryError],
    ["archived", () => seedCategory("Old", { archived: true }).id, CategoryArchivedError],
  ])("refuses a destination that is %s", (_label, makeDestination, expected) => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    expect(() =>
      bulkRetarget(handle.db, {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: makeDestination(),
        rememberMerchant: false,
      }),
    ).toThrow(expected);
  });

  it("refuses a destination that is a parent category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const parent = seedCategory("Food");
    seedCategory("Groceries", { parentId: parent.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    expect(() =>
      bulkRetarget(handle.db, {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: parent.id,
        rememberMerchant: false,
      }),
    ).toThrow(ParentAllocationError);
  });

  /* Rows moving OFF an archived category is one of the better reasons to be
     here, so the source deliberately gets none of the destination's checks. */
  it("ALLOWS an archived source category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const retired = seedCategory("Retired", { archived: true });
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: retired.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: retired.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.updatedCount).toBe(1);
  });
});

describe("bulkRetarget — the rule follows the rows", () => {
  /* The `excludeTxnIds` case, and the reason this feature closes TODOS.md's
     "two-step the user could actually complete". The rows being moved are
     exactly the evidence that makes the key look multi-category, so without
     the exclusion the guard refuses to retrain a key THIS CALL makes
     unanimous. */
  it("retrains a key the move itself makes unanimous", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -2500, categoryId: gas.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -900, categoryId: groceries.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(result.ruleRefusal).toBeNull();
    expect(result.ruleTouched).toBe(true);
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(groceries.id);
  });

  /* Mutation check for the line above: drop `excludeTxnIds` from
     `bulkRetarget`'s `applyRuleWrite` call and this is the test that fails —
     the key reads as Gas+Groceries and the rule is refused. */
  it("still refuses when the move leaves the key genuinely split", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const household = seedCategory("Household");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -900, categoryId: household.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(result.ruleRefusal).not.toBeNull();
    expect(result.updatedCount).toBe(1);
  });

  it("withholds the rule but still moves the rows on a lossy key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE", amountCents: -5000, categoryId: gas.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "ONLINE",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(result.ruleRefusal?.reason).toBe("lossy-key");
    expect(result.updatedCount).toBe(1);
    expect(exactRuleFor("ONLINE")).toBeUndefined();
  });

  it("writes no rule at all when Remember is not ticked", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: gas.id });

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    expect(result.ruleTouched).toBe(false);
    expect(exactRuleFor("COSTCO")).toBeUndefined();
  });

  /* `allowRuleRemoval` is an ARGUMENT and defaults to false — the same
     discipline rule 6 applies everywhere else. The action layer opts in; a
     direct caller that does not must never lose a rule. Three rows under three
     different categories so the key stays split even after the move, which is
     what makes the refusal a REMOVAL candidate rather than an upsert. */
  function seedSplitKeyWithRule() {
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
    return { gas, groceries };
  }

  it("keeps a contradicted rule when the caller does not opt in", () => {
    const { gas, groceries } = seedSplitKeyWithRule();

    const result = bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: true,
    });

    expect(result.ruleRefusal).not.toBeNull();
    expect(result.ruleRefusal?.removedRule).toBeNull();
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(gas.id);
  });

  it("removes a contradicted rule when the caller opts in", () => {
    const { gas, groceries } = seedSplitKeyWithRule();

    const result = bulkRetarget(
      handle.db,
      {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: groceries.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );

    expect(result.ruleRefusal?.removedRule).not.toBeNull();
    expect(result.ruleTouched).toBe(true);
    expect(exactRuleFor("COSTCO")).toBeUndefined();
  });

  /* The narrowing `applyRuleWrite` documents: picking the category a rule
     already points at is CONFIRMING it, so a refusal there must not delete it
     — that would leave every future row for the key uncategorized for nothing.
     Reachable from this surface, because moving rows ONTO the rule's own
     target is an ordinary repair. */
  it("spares the rule when the destination is the category it already points at", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const household = seedCategory("Household");
    const dining = seedCategory("Dining");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000, categoryId: household.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -400, categoryId: dining.id });
    handle.db
      .insert(schema.categoryRules)
      .values({ categoryId: gas.id, matchType: "exact", matchValue: "COSTCO", priority: 0, source: "manual" })
      .run();

    const result = bulkRetarget(
      handle.db,
      {
        normalizedMerchant: "COSTCO",
        fromCategoryId: household.id,
        categoryId: gas.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );

    expect(result.ruleRefusal).not.toBeNull();
    expect(result.ruleRefusal?.removedRule).toBeNull();
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(gas.id);
  });
});

describe("bulkRetarget — invalidation", () => {
  /* BOTH categories, and this is the difference from `bulkCategorize`, whose
     rows came from NULL. Spend LEFT the source and ARRIVED on the destination
     in the same month; invalidating one chain would leave the other still
     claiming the rows. */
  it("clears the cached rollover chain on BOTH categories from the earliest month", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas", { carryoverPolicy: "rollover" });
    const groceries = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    for (const category of [gas, groceries]) {
      handle.db
        .insert(schema.budgetPeriods)
        .values([
          { categoryId: category.id, year: 2026, month: 2, allocatedCents: 1000 },
          { categoryId: category.id, year: 2026, month: 3, allocatedCents: 1000 },
          { categoryId: category.id, year: 2026, month: 4, allocatedCents: 1000 },
        ])
        .run();
    }

    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO",
      amountCents: -5000,
      date: "2026-02-10",
      categoryId: gas.id,
    });

    primeCache(handle.db, gas.id, 2026, 4);
    primeCache(handle.db, groceries.id, 2026, 4);
    const primed = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.month, 4))
      .all();
    expect(primed.every((r) => r.effectiveAllocationCents !== null)).toBe(true);

    bulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      rememberMerchant: false,
    });

    const after = handle.db.select().from(schema.budgetPeriods).all();
    expect(after.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });
});

describe("bulkRetarget — completes the repair bulkCategorize could not", () => {
  /* The whole scenario TODOS.md's P2 describes, end to end: file a merchant
     group to the wrong category, watch the 10s toast expire, and repair it. */
  it("repairs a merchant group filed to the wrong category", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -5000 });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -2500 });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", amountCents: -900 });

    // The mistake: the whole group filed as Gas.
    const filed = bulkCategorize(handle.db, {
      normalizedMerchant: "COSTCO",
      categoryId: gas.id,
      rememberMerchant: true,
    });
    expect(filed.updatedCount).toBe(3);
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(gas.id);

    // The repair, after the undo window has gone.
    const repair = bulkRetarget(
      handle.db,
      {
        normalizedMerchant: "COSTCO",
        fromCategoryId: gas.id,
        categoryId: groceries.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );

    expect(repair.updatedCount).toBe(3);
    expect(repair.ruleRefusal).toBeNull();
    // The rule followed the rows rather than being deleted: after the move the
    // key is unanimously Groceries, which is only true because `excludeTxnIds`
    // let the verdict read the ledger the action leaves behind.
    expect(exactRuleFor("COSTCO")?.categoryId).toBe(groceries.id);

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, "COSTCO"))
      .all();
    expect(rows.every((r) => r.categoryId === groceries.id)).toBe(true);
  });
});
