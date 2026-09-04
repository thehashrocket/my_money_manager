import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import { monthBoundary, nextMonthOf, previousMonth } from "@/lib/budget/monthOfIso";

export type EffectiveAllocation = {
  allocatedCents: number;
  rolloverCents: number;
  effectiveCents: number;
};

export type GetEffectiveAllocationOptions = {
  /**
   * Write the computed `effective_allocation_cents` back to the row.
   *
   * Default `false` (read-only). Server Component render paths must stay
   * read-only: writing during render + React 19 prefetch can double-fire or
   * persist stale values. Server Actions that own the mutation should pass
   * `true` inside the same transaction that writes the user's change.
   */
  persist?: boolean;
};

/**
 * Return the effective allocation for a category in a given month, or `null`
 * if no budget_periods row exists for that month.
 *
 * Cached `effective_allocation_cents` is preferred when present. When absent,
 * the value is computed from the prior month's state but NOT written back
 * unless `{ persist: true }` is passed. Invalidation (see
 * {@link invalidateForwardRollover}) clears cached values on upstream edits.
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
  options?: GetEffectiveAllocationOptions,
): EffectiveAllocation | null {
  const persist = options?.persist ?? false;

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
    const prior = getEffectiveAllocation(db, categoryId, priorYear, priorMonth, {
      persist,
    });
    if (prior) {
      const priorSpent = computeMtdSpent(db, categoryId, priorYear, priorMonth);
      rolloverCents = Math.max(0, prior.effectiveCents - priorSpent);
    }
  }

  const effectiveCents = allocatedCents + rolloverCents;

  if (persist) {
    db.update(schema.budgetPeriods)
      .set({ effectiveAllocationCents: effectiveCents })
      .where(eq(schema.budgetPeriods.id, row.id))
      .run();
  }

  return { allocatedCents, rolloverCents, effectiveCents };
}

/**
 * Clear cached `effective_allocation_cents` for the given month and every
 * later month of the same category. The next read of any affected month
 * recomputes from fresh explicit allocations and prior-month state.
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

