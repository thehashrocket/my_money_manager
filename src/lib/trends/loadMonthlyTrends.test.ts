import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadMonthlyTrends } from "./loadMonthlyTrends";

/**
 * TC34b (mandatory regression, TS3): `loadMonthlyTrends` had NO test file at
 * all before A2 repointed its `is_savings_goal = false` filter to
 * `kind != 'fund'` (T5). Pins the pre-existing behavior first, then the
 * drift case E6 added.
 */

let handle: TestDbHandle;

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(new Date("2026-04-15T12:00:00Z"));
  handle = createTestDb();
  handle.db.delete(schema.categories).where(ne(schema.categories.name, "Uncategorized")).run();
});

afterEach(() => {
  handle.close();
  vi.useRealTimers();
});

let seq = 0;

function seedCategory(
  name: string,
  opts: { parentId?: number | null; isSavingsGoal?: boolean; kind?: "income" | "expense" | "fund" } = {},
) {
  seq += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: opts.parentId ?? null,
      isSavingsGoal: opts.isSavingsGoal ?? false,
      kind: opts.kind ?? "expense",
    })
    .returning()
    .all();
  return cat;
}

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
  seq += 1;
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: `seed-${seq}.csv` })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  categoryId: number;
  date: string;
  amountCents: number;
}) {
  seq += 1;
  handle.db
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
      importRowHash: `hash-${seq}`,
    })
    .run();
}

describe("loadMonthlyTrends (TC34b)", () => {
  it("returns monthCount months, oldest to newest, ending at the current month", () => {
    const view = loadMonthlyTrends(handle.db, 3);
    expect(view.months.map((m) => `${m.year}-${m.month}`)).toEqual([
      "2026-2",
      "2026-3",
      "2026-4",
    ]);
  });

  it("aggregates spend per category-group per month, excluding transfers and income", () => {
    const parent = seedCategory("Housing");
    const rent = seedCategory("Rent", { parentId: parent.id });
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: rent.id,
      date: "2026-04-05",
      amountCents: -180000,
    });

    const view = loadMonthlyTrends(handle.db, 2);
    const april = view.months.find((m) => m.month === 4)!;
    expect(april.totalSpentCents).toBe(180000);
    expect(april.byCategory).toEqual([{ name: parent.name, spentCents: 180000 }]);
  });

  it("groups an unparented leaf under its own name ('Other' fallback only applies to unmapped ids)", () => {
    const orphan = seedCategory("Misc Expense");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: orphan.id,
      date: "2026-04-05",
      amountCents: -1000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].byCategory).toEqual([{ name: orphan.name, spentCents: 1000 }]);
  });
});

describe("loadMonthlyTrends — kind is authoritative, not is_savings_goal (E6 drift)", () => {
  it("excludes a kind='fund' category from spend even when isSavingsGoal=0 (TC22 direction)", () => {
    const fund = seedCategory("Drifted Fund", { isSavingsGoal: false, kind: "fund" });
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: fund.id,
      date: "2026-04-05",
      amountCents: -5000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(0);
    expect(view.months[0].byCategory).toEqual([]);
  });

  it("includes a kind='expense' category even when isSavingsGoal=1 (TC22b inverse direction)", () => {
    const drifted = seedCategory("Drifted Expense", { isSavingsGoal: true, kind: "expense" });
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: drifted.id,
      date: "2026-04-05",
      amountCents: -5000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(5000);
  });
});
