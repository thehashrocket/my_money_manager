import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { upsertAllocation } from "@/lib/budget/upsertAllocation";
import { loadGoals } from "./loadGoals";

/**
 * TC34a (mandatory regression, TS3): `loadGoals` had NO test file at all
 * before A2 repointed its `is_savings_goal = true` filter to `kind = 'fund'`
 * (T5). Pins the pre-existing behavior first, then the drift cases E6 added.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
  // The real seed (migrations 0001/0002/0005/0017) has zero fund categories;
  // clear it so each test's fixture is exact rather than additive.
  handle.db.delete(schema.categories).where(ne(schema.categories.name, "Uncategorized")).run();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedFundCategory(
  name: string,
  opts: {
    targetCents?: number;
    carryoverPolicy?: "none" | "rollover" | "reset";
    isSavingsGoal?: boolean;
    kind?: "income" | "expense" | "fund";
  } = {},
) {
  seq += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      isSavingsGoal: opts.isSavingsGoal ?? true,
      kind: opts.kind ?? "fund",
      targetCents: opts.targetCents ?? 100000,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
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
  transferPairId?: number | null;
}) {
  seq += 1;
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
      importRowHash: `hash-${seq}`,
      transferPairId: opts.transferPairId ?? null,
    })
    .returning()
    .all();
  return row;
}

function seedAllocation(categoryId: number, year: number, month: number, allocatedCents: number) {
  handle.db
    .insert(schema.budgetPeriods)
    .values({ categoryId, year, month, allocatedCents })
    .run();
}

describe("loadGoals (TC34a)", () => {
  it("returns an empty view when there are no fund categories", () => {
    const view = loadGoals(handle.db);
    expect(view).toEqual({
      goals: [],
      totalProgressCents: 0,
      totalTargetCents: 0,
      totalTargetedContributedCents: 0,
      untargetedGoalCount: 0,
    });
  });

  it("computes contributed (from allocations), withdrawn (from negative txns), and progress", () => {
    const cat = seedFundCategory("Car Repair", { targetCents: 100000 });
    seedAllocation(cat.id, 2026, 3, 20000);
    seedAllocation(cat.id, 2026, 4, 20000);

    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: -5000, // withdrawal
    });

    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(1);
    const goal = view.goals[0];
    expect(goal.totalContributedCents).toBe(40000);
    expect(goal.totalWithdrawnCents).toBe(5000);
    expect(goal.progressCents).toBe(35000);
    expect(goal.progressPct).toBeCloseTo(35, 5);
    expect(goal.monthlyBreakdown).toEqual([
      { year: 2026, month: 3, allocatedCents: 20000 },
      { year: 2026, month: 4, allocatedCents: 20000 },
    ]);
  });

  /**
   * Pins the `amount_cents < 0` filter that the sign-convention pass
   * deliberately did NOT convert (see the analysis at `loadGoals.ts:70-95`).
   *
   * Without this test the whole suite passes with that filter deleted — there
   * was no fixture anywhere seeding a POSITIVE row on a fund category, so the
   * one input that distinguishes "outflows only" from "signed sum" was absent.
   * That matters because every sibling reader DID move to a signed sum, so the
   * next person reading `loadMonthlyTrends`' docblock has an obvious-looking
   * one-line change to make here and green CI telling them it was fine.
   *
   * It is not fine: `progress = contributed − withdrawn` where `contributed` is
   * already the PLANNED allocation, so a net `withdrawn` lets a deposit add to
   * progress on top of the allocation that counted the same intention — the
   * goal reads roughly double.
   */
  it("counts a DEPOSIT into a fund as neither progress nor a negative withdrawal", () => {
    const cat = seedFundCategory("Vacation", { targetCents: 100000 });
    seedAllocation(cat.id, 2026, 4, 50000);

    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-05",
      amountCents: 50000, // a deposit landing in the fund category, unpaired
    });

    const goal = loadGoals(handle.db).goals[0];
    // Under a signed sum, withdrawn would be -50000 and progress 100000.
    expect(goal.totalWithdrawnCents).toBe(0);
    expect(goal.progressCents).toBe(50000);
  });

  it("excludes transfer-paired rows from withdrawals", () => {
    const cat = seedFundCategory("Vacation");
    const account = seedAccount();
    const batch = seedBatch();
    const paired = seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-04-10",
      amountCents: -30000,
    });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    const view = loadGoals(handle.db);
    expect(view.goals[0]?.totalWithdrawnCents).toBe(0);
  });

  it("sorts goals by name ascending", () => {
    seedFundCategory("Zebra");
    seedFundCategory("Alpha");
    const view = loadGoals(handle.db);
    expect(view.goals.map((g) => g.name.replace(/-\d+$/, ""))).toEqual(["Alpha", "Zebra"]);
  });

  it("totalProgressCents/totalTargetCents sum across all goals", () => {
    const a = seedFundCategory("A", { targetCents: 10000 });
    const b = seedFundCategory("B", { targetCents: 20000 });
    seedAllocation(a.id, 2026, 4, 5000);
    seedAllocation(b.id, 2026, 4, 8000);

    const view = loadGoals(handle.db);
    expect(view.totalTargetCents).toBe(30000);
    expect(view.totalProgressCents).toBe(13000);
  });
});

/*
 * D3=C (2026-09-08) — the end-to-end statement of the fund fix.
 *
 * Every test above seeds `budget_periods` rows DIRECTLY, which is why this
 * file was green for the whole time a fund was unfundable: `loadGoals`' math
 * was always correct, and no UI could produce its input. `/budget`'s FUNDS
 * band was links-only (DS19) and `/goals` exports only `createGoalAction`
 * and `updateGoalTargetAction`, neither of which touches `budget_periods` —
 * so `progressCents = allocated - withdrawn` was pinned at `0 - withdrawn`
 * on the live ledger for the life of the app, and `PLAN.md`'s 1.0.0 gate #2
 * ("what a fund's progress means") could not be answered by creating a fund.
 *
 * This joins the two halves through the REAL writer. It fails if anyone adds
 * a `kind` guard to `upsertAllocation` — the natural-looking "funds are not
 * expenses" tidy-up that would silently restore the dead end.
 */
describe("loadGoals — a fund funded through the real write path (D3=C)", () => {
  it("progress moves from 0 once upsertAllocation writes a fund's contribution", () => {
    const cat = seedFundCategory("Emergency", { targetCents: 100000 });

    const before = loadGoals(handle.db);
    expect(before.goals[0].progressCents).toBe(0);
    expect(before.goals[0].progressPct).toBe(0);

    upsertAllocation(handle.db, { categoryId: cat.id, year: 2026, month: 4, allocatedCents: 25000 });

    const after = loadGoals(handle.db);
    expect(after.goals[0].progressCents).toBe(25000);
    expect(after.totalProgressCents).toBe(25000);
  });

  it("accumulates across months, because a contribution is per-month by construction", () => {
    const cat = seedFundCategory("Emergency", { targetCents: 100000 });
    upsertAllocation(handle.db, { categoryId: cat.id, year: 2026, month: 4, allocatedCents: 25000 });
    upsertAllocation(handle.db, { categoryId: cat.id, year: 2026, month: 5, allocatedCents: 30000 });

    expect(loadGoals(handle.db).goals[0].progressCents).toBe(55000);
  });

  it("re-committing the same month REPLACES rather than adds (budget_periods is unique per category-month)", () => {
    const cat = seedFundCategory("Emergency", { targetCents: 100000 });
    upsertAllocation(handle.db, { categoryId: cat.id, year: 2026, month: 4, allocatedCents: 25000 });
    upsertAllocation(handle.db, { categoryId: cat.id, year: 2026, month: 4, allocatedCents: 40000 });

    // Editing a cell twice is the commonest possible interaction on the new
    // control; an upsert that appended would double-count every correction.
    expect(loadGoals(handle.db).goals[0].progressCents).toBe(40000);
  });
});

describe("loadGoals — kind is authoritative, not is_savings_goal (E6 drift)", () => {
  it("includes a kind='fund' category even when isSavingsGoal=0 (TC22 direction)", () => {
    seedFundCategory("Drifted Fund", { isSavingsGoal: false, kind: "fund" });
    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(1);
  });

  it("excludes a kind='expense' category even when isSavingsGoal=1 (TC22b inverse direction)", () => {
    seedFundCategory("Drifted Expense", { isSavingsGoal: true, kind: "expense" });
    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(0);
  });
});

describe("loadGoals — progressPct clamp boundaries", () => {
  it("clamps progressPct to 100 when withdrawals plus contributions exceed the target", () => {
    const cat = seedFundCategory("Overfunded", { targetCents: 10000 });
    seedAllocation(cat.id, 2026, 3, 15000); // 150% of target, pre-clamp

    const view = loadGoals(handle.db);
    expect(view.goals[0].progressCents).toBe(15000);
    expect(view.goals[0].progressPct).toBe(100);
  });

  it("clamps progressPct to 0 when withdrawals exceed contributions (negative pre-clamp)", () => {
    const cat = seedFundCategory("Drained", { targetCents: 10000 });
    seedAllocation(cat.id, 2026, 3, 2000);
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      categoryId: cat.id,
      date: "2026-03-10",
      amountCents: -9000, // withdrew more than was ever contributed
    });

    const view = loadGoals(handle.db);
    expect(view.goals[0].progressCents).toBe(-7000);
    expect(view.goals[0].progressPct).toBe(0);
  });

  /* A NULL target is REPORTED AS NULL, never coerced to 0 — the same rule
     `FundRow.targetCents` follows on `/budget`, where `fundTargetGap` renders
     it as an em dash. It was `?? 0` until v0.23.0's review, so `/goals` said
     "target $0.00" for a fund that has no target, which claims it is already
     complete, and prefilled its Edit-target form with `0.00` — a value
     `updateGoalTargetSchema`'s `.positive()` then refused, taking out the page.

     Newly ORDINARY rather than exotic: the FUNDS band's "+ Add a line" goes
     through `createCategory`, which does not write `target_cents`. Before that
     existed, the only fund-creation path was `createGoalAction`, whose schema
     is `.positive()`. */
  it("reports a null targetCents as NULL, and progressPct 0 rather than dividing by zero", () => {
    const cat = seedFundCategory("No target set", { targetCents: undefined });
    handle.db
      .update(schema.categories)
      .set({ targetCents: null })
      .where(eq(schema.categories.id, cat.id))
      .run();
    seedAllocation(cat.id, 2026, 3, 5000);

    const view = loadGoals(handle.db);
    expect(view.goals[0].targetCents).toBeNull();
    expect(view.goals[0].progressPct).toBe(0);
  });

  /* The headline ratio's two halves must cover the SAME funds. They did not:
     the page summed contributions over every fund while `totalTargetCents`
     summed targets, so one untargeted fund made the numerator describe a
     larger set than the denominator — a ratio that looks fine and compares
     different things. */
  it("draws the headline ratio's numerator and denominator from the same fund set", () => {
    const targeted = seedFundCategory("Vacation", { targetCents: 100000 });
    seedAllocation(targeted.id, 2026, 3, 20000);

    const untargeted = seedFundCategory("Rainy day", { targetCents: undefined });
    handle.db
      .update(schema.categories)
      .set({ targetCents: null })
      .where(eq(schema.categories.id, untargeted.id))
      .run();
    seedAllocation(untargeted.id, 2026, 3, 30000);

    const view = loadGoals(handle.db);
    // The untargeted fund's $300 is in neither half of the ratio…
    expect(view.totalTargetCents).toBe(100000);
    expect(view.totalTargetedContributedCents).toBe(20000);
    // …and the page is told it exists so it can say so rather than drop it.
    expect(view.untargetedGoalCount).toBe(1);
    // It is still a fund, and still listed.
    expect(view.goals).toHaveLength(2);
  });
});

/* T5 (round-5): an archived fund is excluded outright rather than marked.
   The filter shipped with no test at all — `loadGoals`' WHERE went from
   `eq(kind, 'fund')` to `and(eq(kind, 'fund'), isNull(archivedAt))` and every
   existing case in this file seeds a live fund, so none of them can see the
   difference. Rule 8 keeps the row itself (archiving never deletes), and
   `/budget/categories` stays the one surface that lists and unarchives it. */
describe("loadGoals — archived funds (T5)", () => {
  function archive(categoryId: number) {
    handle.db
      .update(schema.categories)
      .set({ archivedAt: new Date() })
      .where(eq(schema.categories.id, categoryId))
      .run();
  }

  it("drops an archived fund from the list entirely", () => {
    const live = seedFundCategory("Vacation", { targetCents: 100000 });
    const gone = seedFundCategory("Old plan", { targetCents: 100000 });
    seedAllocation(live.id, 2026, 3, 20000);
    seedAllocation(gone.id, 2026, 3, 50000);

    archive(gone.id);

    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0].categoryId).toBe(live.id);
  });

  /* The archived fund's money must leave every headline figure too, not just
     the list — a total that still counts a fund the page no longer shows is
     the "two surfaces disagree" shape this branch exists to close. */
  it("removes an archived fund's contributions and target from every total", () => {
    const live = seedFundCategory("Vacation", { targetCents: 100000 });
    const gone = seedFundCategory("Old plan", { targetCents: 400000 });
    seedAllocation(live.id, 2026, 3, 20000);
    seedAllocation(gone.id, 2026, 3, 50000);

    archive(gone.id);

    const view = loadGoals(handle.db);
    expect(view.totalTargetCents).toBe(100000);
    expect(view.totalProgressCents).toBe(20000);
    expect(view.totalTargetedContributedCents).toBe(20000);
  });

  /* An archived fund with no target used to inflate `untargetedGoalCount`,
     which is the count the page renders as "N funds have no target yet" — a
     prompt to go fix funds that are not on the page. */
  it("does not count an archived untargeted fund in untargetedGoalCount", () => {
    const gone = seedFundCategory("Rainy day", { targetCents: undefined });
    handle.db
      .update(schema.categories)
      .set({ targetCents: null })
      .where(eq(schema.categories.id, gone.id))
      .run();
    seedAllocation(gone.id, 2026, 3, 30000);

    expect(loadGoals(handle.db).untargetedGoalCount).toBe(1);
    archive(gone.id);
    expect(loadGoals(handle.db).untargetedGoalCount).toBe(0);
  });

  it("returns the empty view when the only fund is archived", () => {
    const gone = seedFundCategory("Only one", { targetCents: 100000 });
    seedAllocation(gone.id, 2026, 3, 5000);
    archive(gone.id);

    expect(loadGoals(handle.db)).toEqual({
      goals: [],
      totalProgressCents: 0,
      totalTargetCents: 0,
      totalTargetedContributedCents: 0,
      untargetedGoalCount: 0,
    });
  });

  /* Archiving is reversible by rule 8's contract, so the exclusion has to be
     a live read of `archived_at` and not a one-way write anywhere. */
  it("brings the fund back once it is unarchived", () => {
    const cat = seedFundCategory("Vacation", { targetCents: 100000 });
    seedAllocation(cat.id, 2026, 3, 20000);
    archive(cat.id);
    expect(loadGoals(handle.db).goals).toHaveLength(0);

    handle.db
      .update(schema.categories)
      .set({ archivedAt: null })
      .where(eq(schema.categories.id, cat.id))
      .run();

    const view = loadGoals(handle.db);
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0].progressCents).toBe(20000);
  });
});

/* `/goals` labels its headline "Planned to date" and `/budget`'s FUNDS band
   labels its column the same words. `loadFundPlannedToDate` was given a hard
   upper bound in v0.23.0 for exactly this; `loadGoals` never got one, so the
   two pages disagreed about the same phrase. /budget is editable for FUTURE
   months and nothing gates a commit on phase, so "every allocation ever
   entered" is reachable by ordinary use, not by a crafted fixture. */
describe("loadGoals — planned-to-date is bounded at asOf (round-5 /ship)", () => {
  it("excludes an allocation planned for a LATER month", () => {
    const fund = seedFundCategory("Emergency", { targetCents: 100000 });
    seedAllocation(fund.id, 2026, 8, 20000);
    seedAllocation(fund.id, 2026, 9, 30000);
    seedAllocation(fund.id, 2026, 12, 50000); // planned, not yet "to date"

    const view = loadGoals(handle.db, { year: 2026, month: 9 });
    expect(view.goals[0].totalContributedCents).toBe(50000);
    expect(view.totalTargetedContributedCents).toBe(50000);
  });

  /* A (year, month) PAIR comparison, never month alone: December 2025 is
     BEFORE January 2026 even though 12 > 1. Both directions pinned. */
  it("counts a prior YEAR's later month, and excludes the same month next year", () => {
    const fund = seedFundCategory("Emergency", { targetCents: 100000 });
    seedAllocation(fund.id, 2025, 12, 20000);
    seedAllocation(fund.id, 2026, 1, 10000);
    seedAllocation(fund.id, 2027, 1, 90000);

    const view = loadGoals(handle.db, { year: 2026, month: 1 });
    expect(view.goals[0].totalContributedCents).toBe(30000);
  });

  /* The LEFT join makes the bound's NULL escape load-bearing: without it a
     fund whose only allocation is in a future month vanishes from the page
     instead of reporting $0, and so does a fund with no allocation at all. */
  it("still lists a fund whose only allocation is in the future, at zero", () => {
    const fund = seedFundCategory("Sabbatical", { targetCents: 100000 });
    seedAllocation(fund.id, 2027, 3, 40000);

    const view = loadGoals(handle.db, { year: 2026, month: 9 });
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0].totalContributedCents).toBe(0);
  });

  it("still lists a fund with no allocation at all", () => {
    seedFundCategory("Untouched", { targetCents: 100000 });

    const view = loadGoals(handle.db, { year: 2026, month: 9 });
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0].totalContributedCents).toBe(0);
  });

  /* The breakdown table is the explanation OF the headline, so it takes the
     SAME bound — an unbounded list would show rows that do not add up to the
     number above them. */
  it("bounds the monthly breakdown identically, so its rows sum to the total", () => {
    const fund = seedFundCategory("Emergency", { targetCents: 100000 });
    seedAllocation(fund.id, 2026, 8, 20000);
    seedAllocation(fund.id, 2026, 9, 30000);
    seedAllocation(fund.id, 2026, 12, 50000);

    const view = loadGoals(handle.db, { year: 2026, month: 9 });
    const breakdown = view.goals[0].monthlyBreakdown;
    expect(breakdown.map((m) => [m.year, m.month])).toEqual([
      [2026, 8],
      [2026, 9],
    ]);
    expect(breakdown.reduce((n, m) => n + m.allocatedCents, 0)).toBe(
      view.goals[0].totalContributedCents,
    );
  });
});

