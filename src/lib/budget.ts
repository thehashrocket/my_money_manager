import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import { monthBoundary, nextMonthOf, previousMonth } from "@/lib/budget/monthOfIso";

export type EffectiveAllocation = {
  allocatedCents: number;
  rolloverCents: number;
  effectiveCents: number;
};

/**
 * Return the effective allocation for a category in a given month, or `null`
 * if no budget_periods row exists for that month.
 *
 * Read-only single-row API — kept for the allocate dialog's one-field
 * breakdown read. `loadMonthView`'s per-month render path does NOT call
 * this per leaf; it uses the set-based `computeEffectiveAllocationsForRollover`
 * prefix scan instead (T8/P1), which is what `persist` existed to make fast
 * before this rewrite. TS1: `persist` is deleted — its only production
 * caller was this function's own prior-month recursion, and no production
 * code ever passed `{ persist: true }` at the top of that recursion (B5),
 * so deleting it changes no real behavior. `effective_allocation_cents`
 * stays in the schema and this function still prefers a cached non-NULL
 * value if one is ever present, but nothing writes one anymore.
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
  const row = db
    .select()
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

  if (row.effectiveAllocationCents !== null) {
    return {
      allocatedCents,
      rolloverCents: row.effectiveAllocationCents - allocatedCents,
      effectiveCents: row.effectiveAllocationCents,
    };
  }

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
      const priorSpent = computeMtdSpent(db, categoryId, priorYear, priorMonth);
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
 * Clear cached `effective_allocation_cents` for the given month and every
 * later month of the same category.
 *
 * P3: this clears a column that, after T8, nothing can ever read a non-NULL
 * value out of. `getEffectiveAllocation`'s cache-read branch is still there
 * (line ~50 above) but structurally unreachable — TS1 deleted the only
 * writer (`persist`), and `loadMonthView`'s set-based path (the read every
 * real render takes) never consults this column at all; it recomputes from
 * `budget_periods.allocated_cents` and transaction sums directly. Six call
 * sites today (`upsertAllocation`, `categorizeTransaction`, `bulkCategorize`,
 * and the three undo paths) still call this faithfully on every write that
 * could shift downstream rollover; PR2a/PR2b add more (a carryover-policy
 * change, a kind change, `copyPreviousMonth`). Deliberately not ripped out:
 * PR3's fund work may legitimately want a real cache, in which case deleting
 * the column now just becomes a migration to add it back — see `TODOS.md`
 * for the tracked follow-up. Kept working today at zero cost either way,
 * since the column being NULL vs also-NULL-after-this-call is not
 * observable.
 *
 * Callers MUST invoke this after any change that shifts downstream rollover:
 * 1. Allocation edit — `upsertBudgetAllocationAction` passes the edited month.
 * 2. Transaction categorize / re-categorize — changing `category_id` shifts
 *    prior-month spend for both the old and new category. Pass the
 *    transaction's date month for each affected category.
 * 3. `carryover_policy` change — flipping rollover ↔ reset re-keys the math
 *    for every downstream month. Pass the earliest allocation month for the
 *    category (or any month <= the earliest that matters).
 */
export function invalidateForwardRollover(
  db: AnyDb,
  categoryId: number,
  fromYear: number,
  fromMonth: number,
): void {
  db.update(schema.budgetPeriods)
    .set({ effectiveAllocationCents: null })
    .where(
      and(
        eq(schema.budgetPeriods.categoryId, categoryId),
        sql`(${schema.budgetPeriods.year} > ${fromYear} OR (${schema.budgetPeriods.year} = ${fromYear} AND ${schema.budgetPeriods.month} >= ${fromMonth}))`,
      ),
    )
    .run();
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
 */
export function computeMtdSpent(
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

