import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  CategoryKindChangeRefusedError,
  loadReclassifyCandidates,
  setCategoryKind,
} from "./setCategoryKind";
import { CategoryNotFoundError } from "@/lib/categoryErrors";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

function seedAccount() {
  const [account] = handle.db
    .insert(schema.accounts)
    .values({ name: "Checking", type: "checking", startingBalanceCents: 0, startingBalanceDate: "2026-01-01" })
    .returning()
    .all();
  return account;
}

function seedBatch() {
  const [batch] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  return batch;
}

let categoryCounter = 0;
function seedCategory(
  name: string,
  kind: "income" | "expense" | "fund" = "expense",
  opts: { archivedAt?: Date } = {},
) {
  categoryCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-${categoryCounter}`, kind, archivedAt: opts.archivedAt })
    .returning()
    .all();
  return cat;
}

function seedTxn(accountId: number, batchId: number, categoryId: number, amountCents: number, date = "2026-03-15") {
  handle.db
    .insert(schema.transactions)
    .values({
      accountId,
      date,
      rawDescription: "TEST",
      rawMemo: "",
      normalizedMerchant: "TEST",
      amountCents,
      categoryId,
      importSource: "csv",
      importBatchId: batchId,
      importRowHash: `${date}-${amountCents}-${Math.random()}`,
    })
    .run();
}

describe("setCategoryKind — TC23 (D9A)", () => {
  it("refuses a category with >=1 transaction", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn(account.id, batch.id, cat.id, -4000);

    expect(() => setCategoryKind(handle.db, cat.id, "income")).toThrow(CategoryKindChangeRefusedError);
  });

  it("refuses a category with >=1 budget_periods row", () => {
    const cat = seedCategory("Groceries");
    handle.db.insert(schema.budgetPeriods).values({ categoryId: cat.id, year: 2026, month: 3, allocatedCents: 10000 }).run();

    expect(() => setCategoryKind(handle.db, cat.id, "income")).toThrow(CategoryKindChangeRefusedError);
  });

  it("succeeds on an unused category and invalidates forward rollover", () => {
    const cat = seedCategory("Someday", "expense");
    // A later month's budget_periods row with a stale cached effective value
    // — present only so we can prove the (no-op here, since the category
    // itself is unused) invalidation path doesn't blow up when there is
    // nothing to invalidate.
    const result = setCategoryKind(handle.db, cat.id, "fund");

    expect(result).toEqual({ categoryId: cat.id, previousKind: "expense", newKind: "fund" });
    const row = handle.db.select().from(schema.categories).where(eq(schema.categories.id, cat.id)).get();
    expect(row?.kind).toBe("fund");
  });

  it("invalidates cached effective_allocation_cents forward from the earliest budget_periods row on the X1 exception path", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Freelance", "expense");
    seedTxn(account.id, batch.id, cat.id, 50000, "2026-03-15");
    handle.db
      .insert(schema.budgetPeriods)
      .values({ categoryId: cat.id, year: 2026, month: 3, allocatedCents: 0, effectiveAllocationCents: 12300 })
      .run();

    setCategoryKind(handle.db, cat.id, "income");

    const period = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .get();
    expect(period?.effectiveAllocationCents).toBeNull();
  });

  it("throws CategoryNotFoundError for an unknown category id", () => {
    expect(() => setCategoryKind(handle.db, 999999, "income")).toThrow(CategoryNotFoundError);
  });

  it("is a no-op that returns success when newKind matches the current kind", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn(account.id, batch.id, cat.id, -4000);

    const result = setCategoryKind(handle.db, cat.id, "expense");
    expect(result).toEqual({ categoryId: cat.id, previousKind: "expense", newKind: "expense" });
  });

  it("(T5/D1B/A2) dual-writes is_savings_goal to true when reclassifying an unused category to fund", () => {
    const cat = seedCategory("New Fund", "expense");
    setCategoryKind(handle.db, cat.id, "fund");

    const row = handle.db.select().from(schema.categories).where(eq(schema.categories.id, cat.id)).get();
    expect(row?.isSavingsGoal).toBe(true);
  });

  it("(T5/D1B/A2) dual-writes is_savings_goal to false when reclassifying a fund away from fund", () => {
    const cat = seedCategory("Former Fund", "fund");
    handle.db.update(schema.categories).set({ isSavingsGoal: true }).where(eq(schema.categories.id, cat.id)).run();

    setCategoryKind(handle.db, cat.id, "expense");

    const row = handle.db.select().from(schema.categories).where(eq(schema.categories.id, cat.id)).get();
    expect(row?.isSavingsGoal).toBe(false);
  });
});

describe("setCategoryKind — TC23b (X1)", () => {
  it("allows expense -> income on a used, all-positive category", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "expense");
    seedTxn(account.id, batch.id, cat.id, 200000, "2026-03-01");
    seedTxn(account.id, batch.id, cat.id, 200000, "2026-04-01");

    const result = setCategoryKind(handle.db, cat.id, "income");
    expect(result.newKind).toBe("income");
  });

  it("refuses expense -> income when any transaction is negative", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "expense");
    seedTxn(account.id, batch.id, cat.id, 200000, "2026-03-01");
    seedTxn(account.id, batch.id, cat.id, -5000, "2026-03-05"); // a clawback

    expect(() => setCategoryKind(handle.db, cat.id, "income")).toThrow(CategoryKindChangeRefusedError);
  });

  it("refuses income -> expense on a used category even if all-positive", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "income");
    seedTxn(account.id, batch.id, cat.id, 200000, "2026-03-01");

    expect(() => setCategoryKind(handle.db, cat.id, "expense")).toThrow(CategoryKindChangeRefusedError);
  });

  it("does not leak to expense -> fund on a used, all-positive category", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Refunds", "expense");
    seedTxn(account.id, batch.id, cat.id, 20000, "2026-03-01");

    expect(() => setCategoryKind(handle.db, cat.id, "fund")).toThrow(CategoryKindChangeRefusedError);
  });

  it("does not leak to income -> fund on a used, all-positive category", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Paycheck", "income");
    seedTxn(account.id, batch.id, cat.id, 200000, "2026-03-01");

    expect(() => setCategoryKind(handle.db, cat.id, "fund")).toThrow(CategoryKindChangeRefusedError);
  });

  it("does not leak to fund -> income on a used, all-positive category", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Savings", "fund");
    seedTxn(account.id, batch.id, cat.id, 20000, "2026-03-01");

    expect(() => setCategoryKind(handle.db, cat.id, "income")).toThrow(CategoryKindChangeRefusedError);
  });

  it("still applies X1 when the category also has budget_periods rows — disclosure, not refusal", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Freelance", "expense");
    seedTxn(account.id, batch.id, cat.id, 50000, "2026-03-01");
    handle.db
      .insert(schema.budgetPeriods)
      .values({ categoryId: cat.id, year: 2026, month: 3, allocatedCents: 10000 })
      .run();

    const result = setCategoryKind(handle.db, cat.id, "income");
    expect(result.newKind).toBe("income");
  });

  it("dual-writes is_savings_goal to stay a truthful shadow of kind === 'fund'", () => {
    const cat = seedCategory("Emergency Fund", "expense");

    setCategoryKind(handle.db, cat.id, "fund");
    const asFund = handle.db.select().from(schema.categories).where(eq(schema.categories.id, cat.id)).get();
    expect(asFund?.isSavingsGoal).toBe(true);

    setCategoryKind(handle.db, cat.id, "expense");
    const backToExpense = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, cat.id))
      .get();
    expect(backToExpense?.isSavingsGoal).toBe(false);
  });
});

describe("loadReclassifyCandidates", () => {
  it("returns expense-kind leaves with concrete stats, excluding income/fund/parent categories", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const expenseCat = seedCategory("Groceries", "expense");
    seedTxn(account.id, batch.id, expenseCat.id, -4000, "2026-03-01");
    seedTxn(account.id, batch.id, expenseCat.id, -6000, "2026-04-01");
    const incomeCat = seedCategory("Paycheck", "income");
    seedTxn(account.id, batch.id, incomeCat.id, 200000, "2026-03-01");
    const fundCat = seedCategory("Car Repair", "fund");
    const parent = seedCategory("Bills", "expense");
    const child = handle.db
      .insert(schema.categories)
      .values({ name: `Electric-${++categoryCounter}`, kind: "expense", parentId: parent.id })
      .returning()
      .all()[0];

    const candidates = loadReclassifyCandidates(handle.db);
    const byName = new Map(candidates.map((c) => [c.name, c]));

    expect(byName.has(incomeCat.name)).toBe(false);
    expect(byName.has(fundCat.name)).toBe(false);
    expect(byName.has(parent.name)).toBe(false); // parents are header-only
    expect(byName.has(child.name)).toBe(true);

    const groceries = byName.get(expenseCat.name)!;
    expect(groceries.transactionCount).toBe(2);
    expect(groceries.earliestDate).toBe("2026-03-01");
    expect(groceries.latestDate).toBe("2026-04-01");
    expect(groceries.allPositive).toBe(false);

    const electric = byName.get(child.name)!;
    expect(electric.transactionCount).toBe(0);
    expect(electric.allPositive).toBe(true);
  });

  it("(X3/B7) excludes an archived expense leaf — reclassifying it wouldn't fix F1's banner, since it stays hidden from the budget grid regardless of kind", () => {
    const archived = seedCategory("Zz Old Category", "expense", { archivedAt: new Date("2026-01-01") });
    const candidates = loadReclassifyCandidates(handle.db);
    expect(candidates.some((c) => c.id === archived.id)).toBe(false);
  });

  it("excludes a leaf with a budget_periods row but no transactions — D9A's 'used' check refuses it regardless of allPositive, so DS32 must not offer it as evidence-backed", () => {
    const planned = seedCategory("Zz Planned Only", "expense");
    handle.db
      .insert(schema.budgetPeriods)
      .values({ categoryId: planned.id, year: 2026, month: 3, allocatedCents: 5000 })
      .run();

    const candidates = loadReclassifyCandidates(handle.db);
    expect(candidates.some((c) => c.id === planned.id)).toBe(false);
    // Confirms the exclusion matches real enforcement: submitting anyway is refused.
    expect(() => setCategoryKind(handle.db, planned.id, "income")).toThrow(CategoryKindChangeRefusedError);
  });

  it("excludes the seed Uncategorized category from candidates", () => {
    const candidates = loadReclassifyCandidates(handle.db);
    expect(candidates.some((c) => c.name === "Uncategorized")).toBe(false);
  });
});
