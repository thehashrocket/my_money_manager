import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { groupIntoSections, loadMonthView } from "./loadMonthView";
import { upsertAllocation } from "./upsertAllocation";

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
    .values({
      name: "Checking",
      type: "checking",
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
    })
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
  opts: {
    parentId?: number | null;
    carryoverPolicy?: "none" | "rollover" | "reset";
    isSavingsGoal?: boolean;
    kind?: "income" | "expense" | "fund";
    sortOrder?: number;
    archivedAt?: Date | null;
  } = {},
) {
  categoryCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${categoryCounter}`,
      parentId: opts.parentId ?? null,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
      isSavingsGoal: opts.isSavingsGoal ?? false,
      kind: opts.kind ?? "expense",
      sortOrder: opts.sortOrder ?? 0,
      archivedAt: opts.archivedAt ?? null,
    })
    .returning()
    .all();
  return cat;
}

function seedAllocation(
  categoryId: number,
  year: number,
  month: number,
  allocatedCents: number,
) {
  handle.db
    .insert(schema.budgetPeriods)
    .values({ categoryId, year, month, allocatedCents })
    .run();
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  categoryId: number | null;
  date: string;
  amountCents: number;
  isPending?: boolean;
  transferPairId?: number | null;
}) {
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "TEST",
      rawMemo: "",
      normalizedMerchant: "TEST",
      amountCents: opts.amountCents,
      categoryId: opts.categoryId,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `${opts.date}-${opts.amountCents}-${Math.random()}`,
      transferPairId: opts.transferPairId ?? null,
      isPending: opts.isPending ?? false,
    })
    .returning()
    .all();
  return row;
}

/**
 * The :memory: migrator seeds all 50 real categories (migrations 0001/0002/
 * 0005), plus migration 0017's 10 group parents. Tests that want to assert
 * exact structure delete every one of them first so they start clean —
 * naming a fixed subset (the pre-0017 shape) drifted silently once 0017 gave
 * most of the rest real parents instead of leaving them all in one bucket.
 */
function clearSeedCategories() {
  handle.db.delete(schema.categories).where(ne(schema.categories.name, "Uncategorized")).run();
  // Uncategorized has a BEFORE DELETE trigger — leave it; callers can filter.
}

describe("loadMonthView — structure & grouping", () => {
  it("renders a single synthetic 'Ungrouped' section when all leaves have parent_id = NULL", () => {
    clearSeedCategories();
    seedCategory("Groceries");
    seedCategory("Gas");

    const view = loadMonthView(handle.db, 2026, 4);

    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].parentId).toBeNull();
    expect(view.sections[0].parentName).toBeNull();
    const names = view.sections[0].categories.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/^Groceries-/), expect.stringMatching(/^Gas-/)]));
  });

  it("renders named parent sections sorted by name ASC, with 'Ungrouped' on top for mixed state", () => {
    clearSeedCategories();
    const housing = seedCategory("Housing");
    const transport = seedCategory("Transportation");
    seedCategory("Rent", { parentId: housing.id });
    seedCategory("Gas", { parentId: transport.id });
    seedCategory("Mystery"); // orphan → Ungrouped

    const view = loadMonthView(handle.db, 2026, 4);
    const names = view.sections.map((s) => s.parentName);
    // Ungrouped first (null), then named ascending. Uncategorized seed is an orphan too.
    expect(names[0]).toBeNull();
    expect(names.slice(1)).toEqual([
      expect.stringMatching(/^Housing-/),
      expect.stringMatching(/^Transportation-/),
    ]);
  });

  it("excludes parent categories from leaf rows", () => {
    clearSeedCategories();
    const housing = seedCategory("Housing");
    seedCategory("Rent", { parentId: housing.id });

    const view = loadMonthView(handle.db, 2026, 4);
    const housingSection = view.sections.find((s) =>
      s.parentName?.startsWith("Housing-"),
    );
    expect(housingSection?.categories.map((c) => c.name)).toEqual([
      expect.stringMatching(/^Rent-/),
    ]);
    // Housing itself is not rendered as a leaf anywhere.
    const flat = view.sections.flatMap((s) => s.categories.map((c) => c.name));
    expect(flat).not.toContain(housing.name);
  });

  it("excludes fund (kind='fund') categories from the view entirely", () => {
    clearSeedCategories();
    seedCategory("Groceries");
    seedCategory("Emergency Fund", { isSavingsGoal: true, kind: "fund" });

    const view = loadMonthView(handle.db, 2026, 4);
    const flat = view.sections.flatMap((s) => s.categories.map((c) => c.name));
    expect(flat).toEqual(expect.arrayContaining([expect.stringMatching(/^Groceries-/)]));
    expect(flat.some((n) => n.startsWith("Emergency Fund-"))).toBe(false);
  });

  it("(TC22) excludes a kind='fund' category even when isSavingsGoal=0 (drift)", () => {
    clearSeedCategories();
    seedCategory("Drifted Fund", { isSavingsGoal: false, kind: "fund" });

    const view = loadMonthView(handle.db, 2026, 4);
    const flat = view.sections.flatMap((s) => s.categories.map((c) => c.name));
    expect(flat.some((n) => n.startsWith("Drifted Fund-"))).toBe(false);
  });

  it("(TC22b, E6) includes a kind='expense' category as an ordinary row even when isSavingsGoal=1 (inverse drift)", () => {
    clearSeedCategories();
    seedCategory("Drifted Expense", { isSavingsGoal: true, kind: "expense" });

    const view = loadMonthView(handle.db, 2026, 4);
    const flat = view.sections.flatMap((s) => s.categories.map((c) => c.name));
    expect(flat.some((n) => n.startsWith("Drifted Expense-"))).toBe(true);
  });

  it("(DS29) sorts leaves within a section by sort_order ASC, then name ASC — not by spend", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    // Deliberately spend the MOST on the category with the HIGHEST sort_order,
    // and the LEAST on the one with the lowest — proves the order comes from
    // sort_order, not spentCents (B4: rows must not reshuffle as you spend).
    const a = seedCategory("AAA", { sortOrder: 3 });
    const b = seedCategory("BBB", { sortOrder: 1 });
    const c = seedCategory("CCC", { sortOrder: 2 });

    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: a.id, date: "2026-04-05", amountCents: -5000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: b.id, date: "2026-04-05", amountCents: -1000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: c.id, date: "2026-04-05", amountCents: -1000 });

    const view = loadMonthView(handle.db, 2026, 4);
    const section = view.sections.find((s) => s.parentId === null)!;
    const ours = section.categories.filter((cat) => /^(AAA|BBB|CCC)-/.test(cat.name));
    expect(ours.map((cat) => cat.name)).toEqual([
      expect.stringMatching(/^BBB-/), // sort_order 1
      expect.stringMatching(/^CCC-/), // sort_order 2
      expect.stringMatching(/^AAA-/), // sort_order 3, biggest spend, sorts last
    ]);
  });

  it("(TC10) row order is stable across two runs with different spend", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    seedCategory("AAA", { sortOrder: 1 });
    const b = seedCategory("BBB", { sortOrder: 2 });

    const before = loadMonthView(handle.db, 2026, 4);
    const beforeOrder = before.sections
      .find((s) => s.parentId === null)!
      .categories.filter((c) => /^(AAA|BBB)-/.test(c.name))
      .map((c) => c.name);

    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: b.id, date: "2026-04-05", amountCents: -50000 });

    const after = loadMonthView(handle.db, 2026, 4);
    const afterOrder = after.sections
      .find((s) => s.parentId === null)!
      .categories.filter((c) => /^(AAA|BBB)-/.test(c.name))
      .map((c) => c.name);

    expect(afterOrder).toEqual(beforeOrder);
    expect(beforeOrder).toEqual([
      expect.stringMatching(/^AAA-/),
      expect.stringMatching(/^BBB-/),
    ]);
  });
});

describe("loadMonthView — per-leaf numbers", () => {
  it("reports allocation, rollover, effective, spent, pending, remaining", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);
    // March spent $30 → rollover $20. April effective = 10 + 20 = $30.
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-03-15", amountCents: -3000 });
    // April spent: $12 posted + $5 pending = $17 total.
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: -1200 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-10", amountCents: -500, isPending: true });

    const view = loadMonthView(handle.db, 2026, 4);
    const row = view.sections
      .flatMap((s) => s.categories)
      .find((c) => c.name.startsWith("Gifts-"))!;

    expect(row.allocation).toEqual({
      allocatedCents: 1000,
      rolloverCents: 2000,
      effectiveCents: 3000,
    });
    expect(row.spentCents).toBe(1700);
    expect(row.pendingCents).toBe(500);
    expect(row.remainingCents).toBe(1300);
    expect(row.isOverspent).toBe(false);
  });

  it("returns allocation=null and remaining=-spent when no budget_periods row exists", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Mystery");
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: -2500 });

    const view = loadMonthView(handle.db, 2026, 4);
    const row = view.sections
      .flatMap((s) => s.categories)
      .find((c) => c.name.startsWith("Mystery-"))!;

    expect(row.allocation).toBeNull();
    expect(row.spentCents).toBe(2500);
    expect(row.remainingCents).toBe(-2500);
    expect(row.isOverspent).toBe(true);
  });

  it("marks isOverspent when effective < spent (negative remaining)", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Dining");
    seedAllocation(cat.id, 2026, 4, 2000);
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: -3200 });

    const view = loadMonthView(handle.db, 2026, 4);
    const row = view.sections
      .flatMap((s) => s.categories)
      .find((c) => c.name.startsWith("Dining-"))!;
    expect(row.remainingCents).toBe(-1200);
    expect(row.isOverspent).toBe(true);
  });

  it("excludes transfer-paired rows from spent and pending", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 4, 10000);

    const paired = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: -4000,
    });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-06", amountCents: -1500 });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-07",
      amountCents: -500,
      isPending: true,
      transferPairId: paired.id,
    });

    const view = loadMonthView(handle.db, 2026, 4);
    const row = view.sections
      .flatMap((s) => s.categories)
      .find((c) => c.name.startsWith("Groceries-"))!;
    expect(row.spentCents).toBe(1500);
    expect(row.pendingCents).toBe(0);
  });
});

describe("loadMonthView — summary strip", () => {
  it("sums allocated, effective, spent across all leaves; remaining = effective - spent", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const groc = seedCategory("Groceries");
    const gas = seedCategory("Gas", { carryoverPolicy: "rollover" });
    seedAllocation(groc.id, 2026, 4, 40000);
    seedAllocation(gas.id, 2026, 3, 5000);
    seedAllocation(gas.id, 2026, 4, 10000);
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: gas.id, date: "2026-03-10", amountCents: -2000 }); // 30 rolls
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: groc.id, date: "2026-04-02", amountCents: -15000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: gas.id, date: "2026-04-15", amountCents: -4000 });

    const view = loadMonthView(handle.db, 2026, 4);
    // allocated = 400 + 100 = 500
    // effective = 400 + (100 + 30) = 530
    // spent (April only) = 150 + 40 = 190
    // remaining = 530 - 190 = 340
    expect(view.summary).toEqual({
      allocatedCents: 50000,
      effectiveCents: 53000,
      spentCents: 19000,
      remainingCents: 34000,
      plannedIncomeCents: 0,
      receivedIncomeCents: 0,
      plannedFundCents: 0,
      leftToBudgetCents: -50000,
      fundCount: 0,
    });
  });

  it("remaining goes negative when aggregate overspent", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const groc = seedCategory("Groceries");
    seedAllocation(groc.id, 2026, 4, 1000);
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: groc.id, date: "2026-04-02", amountCents: -3000 });

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.summary.remainingCents).toBe(-2000);
  });
});

describe("loadMonthView — uncategorized backlog tile", () => {
  it("(X4) is scoped to the viewed month, excluding transfer pairs — not all-time", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    // March row: outside the scope of a 2026-04 view.
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: null, date: "2026-03-10", amountCents: -1200 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: null, date: "2026-04-01", amountCents: -2500 });
    const paired = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: null,
      date: "2026-04-02",
      amountCents: -9999,
    });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.uncategorizedBacklog.count).toBe(1);
    expect(view.uncategorizedBacklog.totalCents).toBe(-2500);
  });

  it("returns zeros when there are no uncategorized rows", () => {
    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.uncategorizedBacklog).toEqual({ count: 0, totalCents: 0 });
  });
});

describe("loadMonthView — read-only contract (no prefetch-write hazard)", () => {
  it("does not persist effective_allocation_cents (render-only path)", () => {
    clearSeedCategories();
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);

    loadMonthView(handle.db, 2026, 4);

    const rows = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .all();
    expect(rows.every((r) => r.effectiveAllocationCents === null)).toBe(true);
  });
});

describe("loadMonthView — month boundaries", () => {
  it("isolates spend and pending to the requested month", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 4, 10000);
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-03-31", amountCents: -9999 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-01", amountCents: -100 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-30", amountCents: -200, isPending: true });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-05-01", amountCents: -9999 });

    const view = loadMonthView(handle.db, 2026, 4);
    const row = view.sections
      .flatMap((s) => s.categories)
      .find((c) => c.name.startsWith("Groceries-"))!;
    expect(row.spentCents).toBe(300);
    expect(row.pendingCents).toBe(200);
  });

  it("handles December → next-year boundary", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Gas");
    seedAllocation(cat.id, 2026, 12, 5000);
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-12-20", amountCents: -1500 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2027-01-02", amountCents: -9999 });

    const view = loadMonthView(handle.db, 2026, 12);
    const row = view.sections
      .flatMap((s) => s.categories)
      .find((c) => c.name.startsWith("Gas-"))!;
    expect(row.spentCents).toBe(1500);
  });
});

describe("loadMonthView — TC2b (E1 regression): PR1a's structural consequences on the real post-0017 seed", () => {
  it("has exactly 10 expense sections, none unparented, none named 'Ungrouped', no income category present", () => {
    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.sections).toHaveLength(10);
    for (const section of view.sections) {
      expect(section.parentId).not.toBeNull();
      expect(section.parentName).not.toBeNull();
      expect(section.parentName).not.toBe("Ungrouped");
    }
    const expenseNames = view.sections.flatMap((s) => s.categories.map((c) => c.name));
    expect(expenseNames.some((n) => n.startsWith("Paycheck"))).toBe(false);
    expect(expenseNames.some((n) => n.startsWith("Interest"))).toBe(false);
    expect(expenseNames.some((n) => n.startsWith("Reimbursement"))).toBe(false);
  });

  it("section order and each section's leaf order are stable across two runs with different spend", () => {
    const first = loadMonthView(handle.db, 2026, 4);
    const shapeOf = (view: typeof first) =>
      view.sections.map((s) => ({ parentName: s.parentName, names: s.categories.map((c) => c.name) }));
    const firstShape = shapeOf(first);

    const account = seedAccount();
    const batch = seedBatch();
    const someLeaf = first.sections[0].categories[0];
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: someLeaf.categoryId,
      date: "2026-04-05",
      amountCents: -50000,
    });

    const second = loadMonthView(handle.db, 2026, 4);
    expect(shapeOf(second)).toEqual(firstShape);
  });
});

describe("loadMonthView — income band (TC6, TC7)", () => {
  it("(TC6) populates incomeSections; variance = received - planned, negative when short", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const paycheck = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(paycheck.id, 2026, 4, 200000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: paycheck.id,
      date: "2026-04-05",
      amountCents: 150000,
    });

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.incomeSections).toHaveLength(1);
    const row = view.incomeSections[0].categories.find((c) => c.name.startsWith("Paycheck-"))!;
    expect(row.plannedCents).toBe(200000);
    expect(row.receivedCents).toBe(150000);
    expect(row.varianceCents).toBe(-50000);
  });

  it("(TC7, REGRESSION B1) a positive income row does not leak into summary.spentCents or render as an expense row", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const paycheck = seedCategory("Paycheck", { kind: "income" });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: paycheck.id,
      date: "2026-04-05",
      amountCents: 200000,
    });

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.summary.spentCents).toBe(0);
    const leaksIntoExpense = view.sections
      .flatMap((s) => s.categories)
      .some((c) => c.name.startsWith("Paycheck-"));
    expect(leaksIntoExpense).toBe(false);
  });

  it("(IncomeLeafRow.pendingCents) reflects a pending deposit's amount, unnegated, excluded from receivedCents", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const paycheck = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(paycheck.id, 2026, 4, 200000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: paycheck.id,
      date: "2026-04-05",
      amountCents: 200000,
      isPending: true,
    });

    const view = loadMonthView(handle.db, 2026, 4);
    const row = view.incomeSections[0].categories.find((c) => c.name.startsWith("Paycheck-"))!;
    // TS2: pending is excluded from receivedCents, and pendingCents itself
    // carries the deposit's own (positive) sign — the opposite convention
    // from an expense row's pendingCents, which is negated.
    expect(row.pendingCents).toBe(200000);
    expect(row.receivedCents).toBe(0);
  });

  it("(IncomeLeafRow.hasAllocation) is true only when a budget_periods row exists this month", () => {
    clearSeedCategories();
    const paycheck = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(paycheck.id, 2026, 4, 200000);
    const unbudgeted = seedCategory("Side gig", { kind: "income" });

    const view = loadMonthView(handle.db, 2026, 4);
    const rows = view.incomeSections.flatMap((s) => s.categories);
    expect(rows.find((c) => c.categoryId === paycheck.id)?.hasAllocation).toBe(true);
    expect(rows.find((c) => c.categoryId === unbudgeted.id)?.hasAllocation).toBe(false);
  });
});

describe("loadMonthView — leftToBudgetCents (TC9)", () => {
  it("uses allocated_cents, not effective_allocation_cents, for the expense side", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 100000);

    const groceries = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    seedAllocation(groceries.id, 2026, 3, 5000);
    seedAllocation(groceries.id, 2026, 4, 10000);
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: groceries.id,
      date: "2026-03-10",
      amountCents: -1000, // 40 rolls into April
    });

    const view = loadMonthView(handle.db, 2026, 4);
    const leaf = view.sections.flatMap((s) => s.categories).find((c) => c.name.startsWith("Groceries-"))!;
    expect(leaf.allocation?.effectiveCents).toBe(14000); // proves rollover is real
    // leftToBudget must use allocated (100_00), not effective (140_00):
    expect(view.summary.leftToBudgetCents).toBe(90000);
  });

  it("is zero when planned income exactly equals allocated spending", () => {
    clearSeedCategories();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 50000);
    const groceries = seedCategory("Groceries");
    seedAllocation(groceries.id, 2026, 4, 50000);

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.summary.leftToBudgetCents).toBe(0);
  });

  it("goes negative when over-allocated relative to planned income", () => {
    clearSeedCategories();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 10000);
    const groceries = seedCategory("Groceries");
    seedAllocation(groceries.id, 2026, 4, 50000);

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.summary.leftToBudgetCents).toBe(-40000);
  });
});

describe("loadMonthView — FUNDS band (TC17, TC17b)", () => {
  it("(TC17) a fund allocation reduces leftToBudgetCents and sets plannedFundCents", () => {
    clearSeedCategories();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 100000);
    const fund = seedCategory("Car Repair", { kind: "fund" });
    seedAllocation(fund.id, 2026, 4, 20000);

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.summary.plannedFundCents).toBe(20000);
    expect(view.summary.leftToBudgetCents).toBe(80000);
    expect(view.fundRows).toEqual([
      expect.objectContaining({ name: fund.name, plannedCents: 20000 }),
    ]);
  });

  it("(TC17b) with zero fund categories: fundCount is 0, fundRows is empty, reconciliation still holds", () => {
    clearSeedCategories();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 50000);

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.summary.fundCount).toBe(0);
    expect(view.fundRows).toEqual([]);
    expect(view.summary.leftToBudgetCents).toBe(
      view.summary.plannedIncomeCents - view.summary.allocatedCents - view.summary.plannedFundCents,
    );
  });
});

it("(TC19, DS6') plannedIncomeCents is reported as 0 when nothing is planned, even though leftToBudget is also 0", () => {
  clearSeedCategories();
  const view = loadMonthView(handle.db, 2026, 4);
  expect(view.summary.plannedIncomeCents).toBe(0);
  expect(view.summary.leftToBudgetCents).toBe(0);
  // DS6': the UI must not treat leftToBudgetCents===0 alone as success — it
  // must also require plannedIncomeCents > 0. This pins the raw data that
  // guard depends on; the guard itself is a later (UI-layer) task.
});

describe("groupIntoSections (TC21, D6A)", () => {
  it("the same rows sort differently under two different injected comparators", () => {
    type Row = { parentId: number | null; name: string; value: number };
    const rows: Row[] = [
      { parentId: null, name: "B", value: 20 },
      { parentId: null, name: "A", value: 10 },
    ];
    const byName = (a: Row, b: Row) => a.name.localeCompare(b.name);
    const byValueDesc = (a: Row, b: Row) => b.value - a.value;

    const sortedByName = groupIntoSections(rows, new Map(), byName);
    const sortedByValue = groupIntoSections(rows, new Map(), byValueDesc);

    expect(sortedByName[0].categories.map((r) => r.name)).toEqual(["A", "B"]);
    expect(sortedByValue[0].categories.map((r) => r.name)).toEqual(["B", "A"]);
  });

  it("buckets by parent_id; the unparented bucket never carries an 'Ungrouped' label", () => {
    type Row = { parentId: number | null; name: string };
    const rows: Row[] = [
      { parentId: null, name: "Orphan" },
      { parentId: 1, name: "Child" },
    ];
    const parentInfo = new Map([[1, { name: "Parent", sortOrder: 0 }]]);
    const sections = groupIntoSections(rows, parentInfo, (a, b) => a.name.localeCompare(b.name));

    expect(sections[0].parentId).toBeNull();
    expect(sections[0].parentName).toBeNull();
    expect(sections[1].parentName).toBe("Parent");
  });
});

describe("loadMonthView — TC25a, TC25b, TC26", () => {
  it("(TC25a, A1) an unparented expense category renders directly under the band, never under a literal 'Ungrouped' header", () => {
    clearSeedCategories();
    seedCategory("Orphan Expense");
    const view = loadMonthView(handle.db, 2026, 4);
    const ungroupedSection = view.sections.find((s) => s.parentId === null);
    expect(ungroupedSection).toBeDefined();
    expect(ungroupedSection?.parentName).toBeNull();
    expect(ungroupedSection?.categories.some((c) => c.name.startsWith("Orphan Expense-"))).toBe(true);
  });

  it("(TC25b, X5) Uncategorized renders as its own row with spend, contributing nothing to allocatedCents or leftToBudgetCents", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 50000);
    const uncategorized = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Uncategorized"))
      .get()!;
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: uncategorized.id,
      date: "2026-04-05",
      amountCents: -4000,
    });

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.uncategorizedRow).not.toBeNull();
    expect(view.uncategorizedRow?.spentCents).toBe(4000);
    expect(view.summary.allocatedCents).toBe(0);
    expect(view.summary.leftToBudgetCents).toBe(50000);
    const inSections = view.sections
      .flatMap((s) => s.categories)
      .some((c) => c.categoryId === uncategorized.id);
    expect(inSections).toBe(false);
  });

  it("regression: Uncategorized is excluded from incomeSections too, not just expense sections, if its kind is ever income", () => {
    // `setCategoryKind` refuses to ever put Uncategorized in this state
    // (it's excluded from the reclassify picker), but `loadMonthView` must
    // not rely on that as its only defense — a direct DB write (or a future
    // bug in that refusal) must not double-count Uncategorized as a real
    // income row on top of its dedicated `uncategorizedRow`.
    clearSeedCategories();
    const uncategorized = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Uncategorized"))
      .get()!;
    handle.db.update(schema.categories).set({ kind: "income" }).where(eq(schema.categories.id, uncategorized.id)).run();

    const view = loadMonthView(handle.db, 2026, 4);
    const inIncomeSections = view.incomeSections
      .flatMap((s) => s.categories)
      .some((c) => c.categoryId === uncategorized.id);
    expect(inIncomeSections).toBe(false);
  });

  it("regression: Uncategorized is excluded from fundRows too, if its kind is ever fund", () => {
    clearSeedCategories();
    const uncategorized = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Uncategorized"))
      .get()!;
    handle.db.update(schema.categories).set({ kind: "fund" }).where(eq(schema.categories.id, uncategorized.id)).run();

    const view = loadMonthView(handle.db, 2026, 4);
    const inFundRows = view.fundRows.some((f) => f.categoryId === uncategorized.id);
    expect(inFundRows).toBe(false);
  });

  it("(TC26, DS12) groups order by the parent's sort_order, not alphabetically by name", () => {
    clearSeedCategories();
    const zebraGroup = seedCategory("Zebra Group", { sortOrder: 1 });
    const appleGroup = seedCategory("Apple Group", { sortOrder: 2 });
    seedCategory("Leaf A", { parentId: zebraGroup.id });
    seedCategory("Leaf B", { parentId: appleGroup.id });

    const view = loadMonthView(handle.db, 2026, 4);
    const groupNames = view.sections.filter((s) => s.parentId !== null).map((s) => s.parentName);
    expect(groupNames).toEqual([
      expect.stringMatching(/^Zebra Group-/),
      expect.stringMatching(/^Apple Group-/),
    ]);
  });
});

/**
 * TC31 (TS4) + TC36 (DS27) share this fixture deliberately — the plan notes
 * TC36 is redundant with TC31 "by construction": TC31 pins the summary
 * figures against hand-computed literals, TC36 additionally proves those
 * figures equal the sum of what actually renders per-row, not just what the
 * summarize() function claims.
 */
function seedMixedFixture() {
  clearSeedCategories();
  const account = seedAccount();
  const batch = seedBatch();

  const income = seedCategory("Paycheck", { kind: "income" });
  seedAllocation(income.id, 2026, 4, 400000);
  seedTxn({
    accountId: account.id,
    batchId: batch.id,
    categoryId: income.id,
    date: "2026-04-01",
    amountCents: 300000,
  });

  const rent = seedCategory("Rent", { carryoverPolicy: "rollover" });
  seedAllocation(rent.id, 2026, 3, 100000);
  seedAllocation(rent.id, 2026, 4, 180000);
  seedTxn({
    accountId: account.id,
    batchId: batch.id,
    categoryId: rent.id,
    date: "2026-03-05",
    amountCents: -50000, // 50_00 rolls into April
  });
  seedTxn({
    accountId: account.id,
    batchId: batch.id,
    categoryId: rent.id,
    date: "2026-04-03",
    amountCents: -180000,
  });

  const unallocated = seedCategory("Hobbies"); // no budget_periods row this month
  seedTxn({
    accountId: account.id,
    batchId: batch.id,
    categoryId: unallocated.id,
    date: "2026-04-10",
    amountCents: -2000,
  });

  const archived = seedCategory("Old Subscription");
  handle.db
    .update(schema.categories)
    .set({ archivedAt: new Date() })
    .where(eq(schema.categories.id, archived.id))
    .run();
  seedAllocation(archived.id, 2026, 4, 5000);
  seedTxn({
    accountId: account.id,
    batchId: batch.id,
    categoryId: archived.id,
    date: "2026-04-12",
    amountCents: -1000,
  });

  const fund = seedCategory("Car Repair", { kind: "fund" });
  seedAllocation(fund.id, 2026, 4, 20000);

  const uncategorized = handle.db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.name, "Uncategorized"))
    .get()!;
  seedTxn({
    accountId: account.id,
    batchId: batch.id,
    categoryId: uncategorized.id,
    date: "2026-04-15",
    amountCents: -3000,
  });

  return { income, rent, unallocated, archived, fund, uncategorized };
}

describe("loadMonthView — reconciliation invariant (TC31, TS4)", () => {
  it("plannedIncome - allocated - plannedFund === leftToBudget over a mixed fixture (income, expense, fund, rollover, archived, unallocated, Uncategorized)", () => {
    seedMixedFixture();
    const view = loadMonthView(handle.db, 2026, 4);

    expect(view.summary.plannedIncomeCents).toBe(400000);
    expect(view.summary.allocatedCents).toBe(185000); // rent 180_00 + archived 50_00... see below
    expect(view.summary.plannedFundCents).toBe(20000);
    expect(view.summary.leftToBudgetCents).toBe(195000);
    expect(
      view.summary.plannedIncomeCents - view.summary.allocatedCents - view.summary.plannedFundCents,
    ).toBe(view.summary.leftToBudgetCents);
  });

  it("holds with zero funds too", () => {
    clearSeedCategories();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 60000);
    const groceries = seedCategory("Groceries");
    seedAllocation(groceries.id, 2026, 4, 25000);

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.summary.fundCount).toBe(0);
    expect(
      view.summary.plannedIncomeCents - view.summary.allocatedCents - view.summary.plannedFundCents,
    ).toBe(view.summary.leftToBudgetCents);
  });
});

describe("loadMonthView — band subtotals (TC36, DS27)", () => {
  it("band subtotals equal the sum of their own rendered rows, and the identity holds", () => {
    seedMixedFixture();
    const view = loadMonthView(handle.db, 2026, 4);

    const renderedPlannedIncome = view.incomeSections
      .flatMap((s) => s.categories)
      .reduce((sum, r) => sum + r.plannedCents, 0);
    const renderedAllocated = view.sections
      .flatMap((s) => s.categories)
      .reduce((sum, r) => sum + (r.allocation?.allocatedCents ?? 0), 0);
    const renderedPlannedFund = view.fundRows.reduce((sum, r) => sum + r.plannedCents, 0);

    expect(renderedPlannedIncome).toBe(view.summary.plannedIncomeCents);
    expect(renderedAllocated).toBe(view.summary.allocatedCents);
    expect(renderedPlannedFund).toBe(view.summary.plannedFundCents);
    expect(renderedPlannedIncome - renderedAllocated - renderedPlannedFund).toBe(
      view.summary.leftToBudgetCents,
    );
  });
});

describe("loadMonthView — uncategorizedRow visibility (TC35b, DS26)", () => {
  it("is null when Uncategorized has no month spend and no month-scoped backlog", () => {
    clearSeedCategories();
    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.uncategorizedRow).toBeNull();
  });

  it("is present when Uncategorized has month spend, even with zero backlog", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const uncategorized = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Uncategorized"))
      .get()!;
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: uncategorized.id,
      date: "2026-04-05",
      amountCents: -1500,
    });

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.uncategorizedRow).not.toBeNull();
    expect(view.uncategorizedRow?.spentCents).toBe(1500);
  });

  it("is present when the month-scoped backlog is non-empty, even with zero Uncategorized spend", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: null,
      date: "2026-04-05",
      amountCents: -800,
    });

    const view = loadMonthView(handle.db, 2026, 4);
    expect(view.uncategorizedRow).not.toBeNull();
    expect(view.uncategorizedRow?.spentCents).toBe(0);
  });
});

describe("loadMonthView — query-count invariance (TC29, TS5 + E13)", () => {
  it("issues the same number of statements for a 5-category and a 50-category fixture, both rollover-enabled", () => {
    function countSelectCalls(categoryCount: number): number {
      handle.close();
      handle = createTestDb();
      clearSeedCategories();
      const account = seedAccount();
      const batch = seedBatch();
      for (let i = 0; i < categoryCount; i++) {
        const cat = seedCategory(`Cat${i}`, { carryoverPolicy: "rollover" });
        seedAllocation(cat.id, 2026, 3, 1000);
        seedAllocation(cat.id, 2026, 4, 1000);
        seedTxn({
          accountId: account.id,
          batchId: batch.id,
          categoryId: cat.id,
          date: "2026-03-10",
          amountCents: -500,
        });
      }

      const selectSpy = vi.spyOn(handle.db, "select");
      loadMonthView(handle.db, 2026, 4);
      const count = selectSpy.mock.calls.length;
      selectSpy.mockRestore();
      return count;
    }

    const small = countSelectCalls(5);
    const large = countSelectCalls(50);
    // Deliberately not asserting a literal number here (TS5): whoever adds
    // the next query should not need to update this file to make it pass.
    expect(large).toBe(small);
  });

  it("costs exactly two more statements when a rollover category exists vs. when none do", () => {
    function countSelectCalls(withRollover: boolean): number {
      handle.close();
      handle = createTestDb();
      clearSeedCategories();
      if (withRollover) {
        seedCategory("Gifts", { carryoverPolicy: "rollover" });
      } else {
        seedCategory("Gifts");
      }

      const selectSpy = vi.spyOn(handle.db, "select");
      loadMonthView(handle.db, 2026, 4);
      const count = selectSpy.mock.calls.length;
      selectSpy.mockRestore();
      return count;
    }

    const without = countSelectCalls(false);
    const withRollover = countSelectCalls(true);
    expect(withRollover).toBe(without + 2);
  });
});

describe("loadMonthView — TC12 (INVERTED A4): effective_allocation_cents stays NULL, figures still correct", () => {
  it("upsertAllocation never writes effective_allocation_cents, and loadMonthView is unaffected by that", () => {
    clearSeedCategories();
    const income = seedCategory("Paycheck", { kind: "income" });
    seedAllocation(income.id, 2026, 4, 100000);
    const cat = seedCategory("Groceries", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 3, 5000);

    upsertAllocation(handle.db, { categoryId: cat.id, year: 2026, month: 4, allocatedCents: 1000 });

    const row = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .all()
      .find((r) => r.month === 4);
    expect(row?.effectiveAllocationCents).toBeNull();

    const view = loadMonthView(handle.db, 2026, 4);
    const leaf = view.sections.flatMap((s) => s.categories).find((c) => c.name.startsWith("Groceries-"))!;
    // March allocated 50, spent 0 -> rollover 50; April = 10 + 50 = 60.
    expect(leaf.allocation?.effectiveCents).toBe(6000);
    // leftToBudget uses allocated (10_00), not effective (60_00): 1000_00 - 10_00 = 990_00.
    expect(view.summary.leftToBudgetCents).toBe(99000);
  });
});

describe("loadMonthView — archived-category visibility (X3/§7.2)", () => {
  it("hides an archived expense category from a month with no allocation and no spend", () => {
    clearSeedCategories();
    const cat = seedCategory("Old Gym", { archivedAt: new Date() });

    const view = loadMonthView(handle.db, 2026, 4);
    const names = view.sections.flatMap((s) => s.categories).map((c) => c.name);
    expect(names).not.toContain(cat.name);
  });

  it("keeps an archived expense category visible in a month it has an allocation in", () => {
    clearSeedCategories();
    const cat = seedCategory("Old Gym", { archivedAt: new Date() });
    seedAllocation(cat.id, 2026, 4, 5000);

    const view = loadMonthView(handle.db, 2026, 4);
    const names = view.sections.flatMap((s) => s.categories).map((c) => c.name);
    expect(names).toContain(cat.name);
  });

  it("keeps an archived expense category visible in a month it has spend in", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const cat = seedCategory("Old Gym", { archivedAt: new Date() });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-10", amountCents: -3000 });

    const view = loadMonthView(handle.db, 2026, 4);
    const names = view.sections.flatMap((s) => s.categories).map((c) => c.name);
    expect(names).toContain(cat.name);
  });

  it("hides an archived category with an explicit $0 allocation this month (not just a missing row)", () => {
    // The exact sequence archiving normally requires: F4 refuses to archive
    // a category with a nonzero current-month allocation ("zero out that
    // allocation first"), so a $0 `budget_periods` ROW commonly exists at
    // the moment a category gets archived. That row existing must not, by
    // itself, keep the now-archived category visible — `hasPeriodRow` alone
    // (any row, even at $0) would say it should stay, contradicting
    // "archived categories are hidden."
    clearSeedCategories();
    const cat = seedCategory("Old Gym", { archivedAt: new Date() });
    seedAllocation(cat.id, 2026, 4, 0);

    const view = loadMonthView(handle.db, 2026, 4);
    const names = view.sections.flatMap((s) => s.categories).map((c) => c.name);
    expect(names).not.toContain(cat.name);
  });

  it("hides the SAME archived category from a later month with no activity", () => {
    clearSeedCategories();
    const cat = seedCategory("Old Gym", { archivedAt: new Date() });
    seedAllocation(cat.id, 2026, 4, 5000);

    const laterView = loadMonthView(handle.db, 2026, 5);
    const names = laterView.sections.flatMap((s) => s.categories).map((c) => c.name);
    expect(names).not.toContain(cat.name);
  });

  it("does not hide a non-archived category with no activity (baseline)", () => {
    clearSeedCategories();
    const cat = seedCategory("Groceries");

    const view = loadMonthView(handle.db, 2026, 4);
    const names = view.sections.flatMap((s) => s.categories).map((c) => c.name);
    expect(names).toContain(cat.name);
  });
});
