import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { computeMtdSpent } from "@/lib/budget";
import { hasDrawableData, loadMonthlyTrends } from "./loadMonthlyTrends";

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

  it("aggregates spend per category-group per month, rolling a leaf up to its parent", () => {
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

/**
 * Sign convention (decided 2026-09-08, D2=A). These are the regression tests
 * for the critical gap the eng review found: the refund path had no test, no
 * error handling, and produced a silently wrong number on two pages at once.
 *
 * The measured symptom on the live ledger — September 2026 Misc read $10.00 on
 * `/budget` and $295.00 on the dashboard — is reproduced by
 * "agrees with computeMtdSpent" below, which asserts the two readers against
 * each other rather than against a hand-copied constant.
 */
describe("loadMonthlyTrends — signed spend, so a refund reduces the month (D2=A)", () => {
  it("nets a refund against spend in the same category and month", () => {
    const cat = seedCategory("Groceries");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: -10000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-07",
      amountCents: 2000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(8000);
    expect(view.months[0].byCategory).toEqual([{ name: cat.name, spentCents: 8000 }]);
  });

  it("reports a negative month when refunds exceed spend, rather than clamping to zero", () => {
    const cat = seedCategory("Returns Heavy");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: -1000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-06",
      amountCents: 3000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(-2000);
  });

  it("cancels a same-account transfer reversal pair to zero instead of counting the outbound leg", () => {
    // The live-ledger shape that made this bug visible: five reversal pairs
    // filed to Misc, netting exactly $0.00. Neither transfer matcher can pair
    // them (both require different accounts), so they arrive here uncancelled
    // and the old `amount_cents < 0` filter counted only the outbound halves.
    const cat = seedCategory("Misc");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: -25000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: 25000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(0);
  });

  it("agrees with computeMtdSpent on the same category-month, refund included", () => {
    const cat = seedCategory("Shared Convention");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: -60000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-09",
      amountCents: 1175,
    });

    const chart = loadMonthlyTrends(handle.db, 1).months[0];
    const budget = computeMtdSpent(handle.db, cat.id, 2026, 4);

    expect(chart.totalSpentCents).toBe(budget);
    expect(budget).toBe(58825);
  });
});

describe("loadMonthlyTrends — income is excluded by category kind, not by amount sign", () => {
  it("excludes an income category's positive rows from spend", () => {
    // Regression for the trap the `amount_cents < 0` removal opened: that
    // filter was silently doing the income exclusion too. Without the
    // `kind='expense'` subquery, 43 live paycheck rows worth +$52,131.17
    // would render as ~$52k of negative spend.
    const paycheck = seedCategory("Paycheck", { kind: "income" });
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: paycheck.id,
      date: "2026-04-05",
      amountCents: 520000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(0);
    expect(view.months[0].byCategory).toEqual([]);
  });

  it("excludes an income category's NEGATIVE rows (a clawback) from spend too", () => {
    // The sharper direction: a clawback on an income category is negative, so
    // an amount-sign filter would have let it through as spending.
    const paycheck = seedCategory("Paycheck Clawback", { kind: "income" });
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: paycheck.id,
      date: "2026-04-05",
      amountCents: -15000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(0);
    expect(view.months[0].byCategory).toEqual([]);
  });

  it("keeps expense and income in the same month independent", () => {
    const rent = seedCategory("Rent");
    const paycheck = seedCategory("Salary", { kind: "income" });
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: rent.id,
      date: "2026-04-05",
      amountCents: -180000,
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: paycheck.id,
      date: "2026-04-05",
      amountCents: 520000,
    });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(180000);
    expect(view.months[0].byCategory).toEqual([{ name: rent.name, spentCents: 180000 }]);
  });
});

describe("loadMonthlyTrends — a net-zero group is dropped, not drawn as a zero", () => {
  it("omits a category whose month cancels itself, so it gets no legend entry", () => {
    // Exactly the live-ledger shape: a reversal pair filed to one category.
    // Emitting {spentCents: 0} draws a legend swatch on a bar of no height,
    // which reads as "you spent nothing here" rather than "these offset".
    const cat = seedCategory("Misc");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: -25000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: 25000 });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].byCategory).toEqual([]);
    expect(view.categoryNames).toEqual([]);
    expect(view.months[0].totalSpentCents).toBe(0);
  });

  it("keeps a genuinely NEGATIVE group — that is real and belongs below the axis", () => {
    const cat = seedCategory("Returns Heavy");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: -1000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-06", amountCents: 3000 });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].byCategory).toEqual([{ name: cat.name, spentCents: -2000 }]);
    expect(view.categoryNames).toEqual([cat.name]);
  });

  it("keeps a group that is zero in one month but real in another", () => {
    // The per-month drop and the six-month `categoryNames` drop are separate
    // decisions; a group cancelled in April must still be listed for March.
    const cat = seedCategory("Sometimes");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-03-05", amountCents: -5000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: -2000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-06", amountCents: 2000 });

    const view = loadMonthlyTrends(handle.db, 2);
    const march = view.months.find((m) => m.month === 3)!;
    const april = view.months.find((m) => m.month === 4)!;
    expect(march.byCategory).toEqual([{ name: cat.name, spentCents: 5000 }]);
    expect(april.byCategory).toEqual([]);
    expect(view.categoryNames).toEqual([cat.name]);
  });
});

describe("loadMonthlyTrends — categoryNames must list everything that draws a bar", () => {
  it("keeps a group whose SIX-MONTH total is exactly zero but whose months are not (regression)", () => {
    // The hole the six-month `total !== 0` filter left: a charge in one month
    // refunded in the next nets to zero across the window while drawing a real
    // bar in BOTH months. `TrendChart` builds its <Bar> elements and its legend
    // from `categoryNames`, and keys `isEmpty` off `byCategory` instead — so
    // dropping the name rendered a chart with axes, no bars and no legend over
    // $50 of genuine activity, with nothing anywhere saying so.
    const cat = seedCategory("Refunded Next Month");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-03-05", amountCents: -5000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cat.id, date: "2026-04-05", amountCents: 5000 });

    const view = loadMonthlyTrends(handle.db, 2);
    const march = view.months.find((m) => m.month === 3)!;
    const april = view.months.find((m) => m.month === 4)!;

    expect(march.byCategory).toEqual([{ name: cat.name, spentCents: 5000 }]);
    expect(april.byCategory).toEqual([{ name: cat.name, spentCents: -5000 }]);
    // Every name a month draws must be listed, or its bars silently vanish.
    expect(view.categoryNames).toEqual([cat.name]);
  });

  it("lists exactly the union of every month's byCategory names, and nothing else", () => {
    // The invariant behind the case above, stated directly: the per-month
    // zero-drop is the ONLY thing that decides drawability, and this list just
    // orders what it produced. A second, independent predicate here is how the
    // two got to disagree in the first place.
    const cancels = seedCategory("Cancels Out");
    const real = seedCategory("Real");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cancels.id, date: "2026-04-05", amountCents: -2500 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: cancels.id, date: "2026-04-06", amountCents: 2500 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: real.id, date: "2026-03-05", amountCents: -100 });

    const view = loadMonthlyTrends(handle.db, 2);
    const drawn = new Set(view.months.flatMap((m) => m.byCategory.map((c) => c.name)));

    expect([...view.categoryNames].sort()).toEqual([...drawn].sort());
    expect(view.categoryNames).toEqual([real.name]);
  });

  it("still orders by six-month total descending, with a negative group ranked last", () => {
    const big = seedCategory("Big");
    const small = seedCategory("Small");
    const negative = seedCategory("Net Negative");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: big.id, date: "2026-04-05", amountCents: -90000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: small.id, date: "2026-04-05", amountCents: -100 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: negative.id, date: "2026-04-05", amountCents: -1000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: negative.id, date: "2026-04-06", amountCents: 4000 });

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.categoryNames).toEqual([big.name, small.name, negative.name]);
  });
});

describe("loadMonthlyTrends — an uncategorized row is not spend", () => {
  it("ignores a NULL-category row entirely (rule 6: NULL is the unmatched default)", () => {
    // The `kind='expense'` subquery replaced `amount_cents < 0`, and the
    // `category_id IS NOT NULL` guard sits beside it. A NULL-category
    // withdrawal is the single commonest row shape on a fresh ledger, so if
    // the subquery rewrite ever loosened that guard the backlog would land in
    // the chart as an untitled group.
    const account = seedAccount();
    const batch = seedBatch();
    seq += 1;
    handle.db
      .insert(schema.transactions)
      .values({
        accountId: account.id,
        date: "2026-04-05",
        rawDescription: "TEST",
        rawMemo: "",
        normalizedMerchant: "TEST",
        amountCents: -4200,
        categoryId: null,
        importSource: "csv",
        importBatchId: batch.id,
        importRowHash: `null-cat-${seq}`,
      })
      .run();

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(0);
    expect(view.months[0].byCategory).toEqual([]);
    expect(view.categoryNames).toEqual([]);
  });
});

describe("loadMonthlyTrends — a linked transfer is not spend", () => {
  it("excludes BOTH legs of a linked transfer pair, even when they are filed to different categories", () => {
    // `transfer_pair_id IS NULL` had no test: the case that claimed to cover it
    // ("excluding transfers and income") never seeded a transfer.
    //
    // The two legs are filed to DIFFERENT categories on purpose. Under the
    // signed convention a same-category pair cancels itself arithmetically, so
    // a fixture like that passes whether the filter runs or not — it cannot
    // tell the two apart. Split across categories, a leak is loud: one group
    // gains $250 of phantom spend and the other goes $250 negative.
    const spent = seedCategory("Misc");
    const other = seedCategory("Other Misc");
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: spent.id, date: "2026-04-05", amountCents: -25000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: other.id, date: "2026-04-05", amountCents: 25000 });
    seedTxn({ accountId: account.id, batchId: batch.id, categoryId: spent.id, date: "2026-04-06", amountCents: -3000 });

    const legs = handle.db
      .select()
      .from(schema.transactions)
      .all()
      .filter((r) => Math.abs(r.amountCents) === 25000);
    const [out, back] = legs;
    handle.db.update(schema.transactions).set({ transferPairId: back.id }).where(eq(schema.transactions.id, out.id)).run();
    handle.db.update(schema.transactions).set({ transferPairId: out.id }).where(eq(schema.transactions.id, back.id)).run();

    const view = loadMonthlyTrends(handle.db, 1);
    expect(view.months[0].totalSpentCents).toBe(3000);
    expect(view.months[0].byCategory).toEqual([{ name: spent.name, spentCents: 3000 }]);
    expect(view.categoryNames).toEqual([spent.name]);
  });
});

/**
 * `TrendChart` used to decide emptiness itself, as
 * `months.every((m) => m.totalSpentCents === 0)`. Under the signed convention
 * that is no longer the same question, and the read model is what knows the
 * difference — so the definition moved here and this pins it.
 */
describe("hasDrawableData — 'nothing to draw', not 'sums to zero'", () => {
  it("is false when there is genuinely nothing", () => {
    expect(hasDrawableData({ categoryNames: [] })).toBe(false);
  });

  it("is true for a window whose net spend is exactly zero but which draws bars", () => {
    // A charge in one month, refunded in the next: every month totals zero and
    // the six-month total is zero, yet two real bars exist. The old predicate
    // rendered "import some transactions" over two months of activity.
    expect(hasDrawableData({ categoryNames: ["Shopping"] })).toBe(true);
  });
});
