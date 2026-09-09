import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import { monthBoundary, nextMonthOf, previousMonth } from "@/lib/budget/monthOfIso";
// Typed on the derived union, never `string`: this predicate exists so the
// fund rule cannot drift, and a `string` parameter would let a schema enum
// rename slip through as "always false" — silently reinstating the exact
// rollover inflation it was written to stop, at BOTH call sites at once.
import type { CategoryKind } from "@/lib/budget/categoryKindLock";

export type EffectiveAllocation = {
  allocatedCents: number;
  rolloverCents: number;
  effectiveCents: number;
};

/**
 * The ONE spelling of "does this category's spend read drop positive rows?"
 *
 * Spend is `0 - SUM(amount_cents)` (rule 1's signed convention), so a positive
 * unpaired row makes `spent` NEGATIVE and `max(0, prevEffective - spent)` then
 * carries a balance LARGER than anything ever allocated. On an expense envelope
 * that is correct and deliberate — a refund restores buying capacity. On a fund
 * it is money appearing from nowhere, and every other subsystem already refuses
 * it: `rules.ts` will not auto-file a positive row into a fund at import,
 * `assertAssignableCategory` refuses a fund on all three categorize paths, and
 * `loadGoals` keeps `withdrawn` outflows-only for this exact reason.
 *
 * There are TWO rollover spellings and they cannot share the SQL — this one is
 * a per-category scalar read, `loadRolloverEffectiveByCategory` is a grouped
 * set-based scan whose clamp has to be inside the aggregate. They share this
 * DECISION instead. They were allowed to disagree for one release: the
 * set-based path got the clamp and this one did not, so a rollover fund's
 * carried balance was correct on load and inflated the moment the user typed
 * into the Allocate cell, because `commitAllocationAction` merges the triple
 * `getEffectiveAllocation` returns into live client state. Do not re-derive
 * `kind === "fund"` inline in a third place.
 */
export function spendIgnoresPositiveRows(kind: CategoryKind | null | undefined): boolean {
  return kind === "fund";
}

/**
 * Return the effective allocation for a category in a given month, or `null`
 * if no budget_periods row exists for that month.
 *
 * Read-only single-row API. Its one production caller is `upsertAllocation`,
 * for the reconciled triple it hands back to `<MonthEditor>`.
 * `loadMonthView`'s per-month render path does NOT call this per leaf; it
 * uses the set-based `computeEffectiveAllocationsForRollover` prefix scan
 * instead (T8/P1), which is what the old `persist` option existed to make
 * fast before that rewrite.
 *
 * Always recomputes. There was a memoised `effective_allocation_cents`
 * column behind this, plus a cache-read branch here and a 13-call-site
 * `invalidateForwardRollover` contract keeping it honest; T8/TS1 deleted the
 * only writer and left the rest standing, so for four releases every write
 * path paid to clear a column nothing could ever fill. The whole apparatus
 * was removed once rollover had actually run against real data and the
 * recompute proved cheap enough not to need it. Cost is NOT a function of
 * chain length alone — three queries per level, dominated by
 * `computeMtdSpent`, so it scales with the transactions in each month of the
 * chain: a 72-month chain measures ~0.1ms at 0 txn/month, ~1ms at 3, ~4ms at
 * a realistic 150 txn/month across 25 categories. That is fine because this
 * function has exactly one production caller (`upsertAllocation`, once per
 * allocate commit) and the render path never touches it. If a cache ever comes back it needs a writer, an
 * invalidation contract AND tests that can fail for the right reason: most of
 * the deleted ones primed a value through a test-only helper and asserted it
 * went back to NULL, which exercised the clearing but never the CACHE — no
 * production state could reach those assertions, and six were vacuous
 * outright (their only assertion was that a never-written column was null).
 *
 * Rollover math: when the category's `carryover_policy = 'rollover'`, the
 * prior month's remaining budget (effective − MTD spent, floored at 0) is
 * added to the current month's explicit `allocated_cents`. A missing prior
 * row contributes 0 (natural floor).
 */
export function getEffectiveAllocation(
  db: AnyDb,
  categoryId: number,
  year: number,
  month: number,
): EffectiveAllocation | null {
  // Explicit projection, not a bare `.select()`. Drizzle expands a bare select
  // into the full column list from the schema, which made this the ONE query in
  // production that would break on a schema/DB mismatch after migration 0021 —
  // `SQLITE_ERROR: no such column: effective_allocation_cents` on every allocate
  // commit if the image is ever rolled back past the migration, while every
  // other `budget_periods` read (loadAllocationsForMonth, copyMonth) projects
  // explicitly and keeps working. 0021 is still forward-only for the DATA (see
  // the migration header), but it no longer has to be forward-only for the CODE.
  const row = db
    .select({ allocatedCents: schema.budgetPeriods.allocatedCents })
    .from(schema.budgetPeriods)
    .where(
      and(
        eq(schema.budgetPeriods.categoryId, categoryId),
        eq(schema.budgetPeriods.year, year),
        eq(schema.budgetPeriods.month, month),
      ),
    )
    .get();
  if (!row) return null;

  const allocatedCents = row.allocatedCents;

  const category = db
    .select({ carryoverPolicy: schema.categories.carryoverPolicy, kind: schema.categories.kind })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();

  // Rollover is meaningless on an income category — there is nothing to
  // "carry forward under-spent." A hand-set carryover_policy='rollover' on
  // an income row must not inflate planned income (F2).
  let rolloverCents = 0;
  if (category?.carryoverPolicy === "rollover" && category?.kind !== "income") {
    const { year: priorYear, month: priorMonth } = previousMonth(year, month);
    const prior = getEffectiveAllocation(db, categoryId, priorYear, priorMonth);
    // O5 (E4): a missing prior-month row is a natural floor, not a
    // deliberate one — the chain simply terminates and this category's
    // whole accumulated balance is gone, not just capped. Fund $200/month
    // for six months, skip funding it once, and the skipped month's
    // successor opens at $200 rather than $1,200. Distinct from B3 below:
    // that clamp forgives money you SPENT past the budget; this discards
    // money you never touched. Deliberately left as an open product
    // question (TODOS.md) rather than decided here — answer after real
    // fund usage, at PR3.
    if (prior) {
      const priorSpent = computeMtdSpent(db, categoryId, priorYear, priorMonth, {
        ignorePositiveRows: spendIgnoresPositiveRows(category?.kind),
      });
      // B3: overspending a rollover envelope forgives the overage rather
      // than carrying a negative balance forward — a defensible product
      // call (EveryDollar's Funds go negative, YNAB makes you cover the
      // overage explicitly; forgiving it is a third valid option) but an
      // undocumented one until now. Untested and unrecorded no longer;
      // see TC4/TC30 and TODOS.md's O2 for the open question of whether
      // this is the semantics PR3 should keep.
      rolloverCents = Math.max(0, prior.effectiveCents - priorSpent);
    }
  }

  const effectiveCents = allocatedCents + rolloverCents;

  return { allocatedCents, rolloverCents, effectiveCents };
}

export type RolloverPeriod = {
  year: number;
  month: number;
  allocatedCents: number;
};

/**
 * Set-based replacement for the per-category backward recursion in
 * {@link getEffectiveAllocation} (P1): given one category's ENTIRE
 * `budget_periods` history (ascending, sparse — only months with a real
 * row) and its spend per month, returns `effectiveCents` for every month
 * that has a row, keyed `"year-month"`.
 *
 * This is a clamped PREFIX scan, not a running SUM — `effective(N) =
 * allocated(N) + max(0, effective(N−1) − spent(N−1))`, and that clamp is
 * exactly what makes it non-decomposable into one SQL running total: every
 * month's contribution depends on the previous month's CLAMPED result, not
 * just its allocation.
 *
 * E4: `effective(N-1)` only contributes rollover when N−1's row is the
 * literal calendar month immediately before N — a scan that just walks
 * `periods` in order without checking adjacency would wrongly carry
 * rollover across a gap (Jan $200 · Feb no row · Mar $200 must produce
 * `effective(Mar) = 200`, not 400). The chain's rollover resets to 0 at any
 * gap, which is equivalent to "only the earliest CONTIGUOUS run of months
 * ending at the target matters" without needing to search backward for it.
 */
export function computeEffectiveAllocationsForRollover(
  periods: RolloverPeriod[],
  spentCentsByMonth: Map<string, number>,
): Map<string, number> {
  const sorted = [...periods].sort((a, b) => a.year - b.year || a.month - b.month);
  const effectiveByKey = new Map<string, number>();

  let prevKey: string | null = null;
  let prevYear = 0;
  let prevMonth = 0;
  let prevEffective = 0;

  for (const period of sorted) {
    const key = periodKey(period.year, period.month);
    const { year: expectedYear, month: expectedMonth } = nextMonthOf(prevYear, prevMonth);
    const isConsecutive = prevKey !== null && expectedYear === period.year && expectedMonth === period.month;

    // B3: the max(0, ...) forgives an overspent envelope rather than
    // carrying a negative balance forward — see the identical clamp and
    // its full rationale in getEffectiveAllocation above. `!isConsecutive`
    // is O5: a gap erases the accumulated balance entirely rather than
    // merely capping it, a different and currently undecided question.
    const rollover = isConsecutive
      ? Math.max(0, prevEffective - (spentCentsByMonth.get(prevKey!) ?? 0))
      : 0;
    const effective = period.allocatedCents + rollover;

    effectiveByKey.set(key, effective);
    prevKey = key;
    prevYear = period.year;
    prevMonth = period.month;
    prevEffective = effective;
  }

  return effectiveByKey;
}

export function periodKey(year: number, month: number): string {
  return `${year}-${month}`;
}

/**
 * The genuinely shared half of every category-month total (D5A): a category,
 * excluding transfer-paired rows (both sides are bookkeeping, not spend or
 * income), within [first day of month, first day of next month). Sign
 * handling and pending inclusion are NOT shared — they differ per caller and
 * stay explicit at each call site rather than behind a `mode` flag, because
 * what "spent" or "received" means is a product decision (see TODOS.md).
 *
 * Two callers, two sign conventions, one shared WHERE clause:
 *
 *   categoryMonthPredicate()  ← shared: transfer-pair exclusion + date window
 *           │
 *           ├─ computeMtdSpent()     = 0 − SUM(amount_cents)   pending IN
 *           │                          (a refund nets debits down)
 *           └─ computeMtdReceived()  = SUM(amount_cents)       pending OUT
 *                                      (TS2 — a pending paycheck isn't
 *                                      received yet; a clawback nets down)
 */
function categoryMonthPredicate(categoryId: number, year: number, month: number) {
  const firstDay = monthBoundary(year, month);
  const { year: nextYear, month: nextMonth } = nextMonthOf(year, month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);

  return and(
    eq(schema.transactions.categoryId, categoryId),
    isNull(schema.transactions.transferPairId),
    gte(schema.transactions.date, firstDay),
    sql`${schema.transactions.date} < ${firstDayNext}`,
  );
}

/**
 * Month-to-date spend in positive cents for the given category + month.
 * Pending rows are included — they count toward spent until they post.
 * Refunds (positive amount_cents on a spend category) net against debits.
 *
 * `ignorePositiveRows` drops positive rows from the sum instead of letting
 * them net debits down — see {@link spendIgnoresPositiveRows} for which
 * categories need it and why. It has to be applied INSIDE the aggregate, not
 * to the result: a month holding both a $50 credit and a $100 withdrawal nets
 * to $50 once summed, and no clamp applied afterwards can recover the $100.
 */
export function computeMtdSpent(
  db: AnyDb,
  categoryId: number,
  year: number,
  month: number,
  options: { ignorePositiveRows?: boolean } = {},
): number {
  const amount = schema.transactions.amountCents;
  const row = db
    .select({
      total: options.ignorePositiveRows
        ? sql<number>`COALESCE(SUM(CASE WHEN ${amount} > 0 THEN 0 ELSE ${amount} END), 0)`
        : sql<number>`COALESCE(SUM(${amount}), 0)`,
    })
    .from(schema.transactions)
    .where(categoryMonthPredicate(categoryId, year, month))
    .get();

  const sum = row?.total ?? 0;
  return 0 - sum;
}

/**
 * Month-to-date received in cents for an income category (TS2). Unlike
 * `computeMtdSpent`, pending rows are EXCLUDED: CLAUDE.md rule 1 already
 * treats pending money as not-yet-yours for every balance in the app, and a
 * pending paycheck counted as received would make Left to Budget report a
 * paycheck that has not actually landed. A negative row (a clawback) nets
 * the total down rather than being dropped.
 */
export function computeMtdReceived(
  db: AnyDb,
  categoryId: number,
  year: number,
  month: number,
): number {
  const row = db
    .select({
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        categoryMonthPredicate(categoryId, year, month),
        eq(schema.transactions.isPending, false),
      ),
    )
    .get();

  return row?.total ?? 0;
}

