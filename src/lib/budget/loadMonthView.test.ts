import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadMonthView } from "./loadMonthView";

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
    .values({ source: "csv", filename: "seed.csv" })
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
 * The :memory: migrator seeds 6 default leaf categories (Uncategorized +
 * Groceries/Gas/Dining/Utilities/Misc) with parent_id = NULL. Tests that
 * want to assert exact structure delete these first so they start clean.
 */
function clearSeedCategories() {
  const seeds = [
    "Groceries",
    "Gas",
    "Dining",
    "Utilities",
    "Misc",
  ];
  for (const name of seeds) {
    handle.db
      .delete(schema.categories)
      .where(eq(schema.categories.name, name))
      .run();
  }
  // Uncategorized has a BEFORE DELETE trigger — leave it; callers can filter.
}

function leafNamesByParent(view: ReturnType<typeof loadMonthView>) {
  return view.sections.map((s) => ({
    parentName: s.parentName,
    leaves: s.categories.map((c) => c.name),
  }));
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

  it("excludes savings-goal categories from the view entirely", () => {
    clearSeedCategories();
    seedCategory("Groceries");
    seedCategory("Emergency Fund", { isSavingsGoal: true });

    const view = loadMonthView(handle.db, 2026, 4);
    const flat = view.sections.flatMap((s) => s.categories.map((c) => c.name));
    expect(flat).toEqual(expect.arrayContaining([expect.stringMatching(/^Groceries-/)]));
    expect(flat.some((n) => n.startsWith("Emergency Fund-"))).toBe(false);
  });

  it("sorts leaves within a section by spent DESC, then name ASC", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
    const a = seedCategory("AAA");
    const b = seedCategory("BBB");
    const c = seedCategory("CCC");

    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: a.id, date: "2026-04-05", amountCents: -1000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: b.id, date: "2026-04-05", amountCents: -5000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: c.id, date: "2026-04-05", amountCents: -1000 });

    const view = loadMonthView(handle.db, 2026, 4);
    const section = view.sections.find((s) => s.parentId === null)!;
    const ours = section.categories.filter((cat) => /^(AAA|BBB|CCC)-/.test(cat.name));
    expect(ours.map((cat) => cat.name)).toEqual([
      expect.stringMatching(/^BBB-/), // 50
      expect.stringMatching(/^AAA-/), // 10, ties broken by name
      expect.stringMatching(/^CCC-/), // 10
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
  it("counts transactions with category_id = NULL across all time, excluding transfer pairs", () => {
    clearSeedCategories();
    const account = seedAccount();
    const batch = seedBatch();
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
    expect(view.uncategorizedBacklog.count).toBe(2);
    expect(view.uncategorizedBacklog.totalCents).toBe(-3700);
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
