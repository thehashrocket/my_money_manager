import { and, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type EffectiveAllocation = {
  allocatedCents: number;
  rolloverCents: number;
  effectiveCents: number;
};

/**
 * Return the effective allocation for a category in a given month, or `null`
 * if no budget_periods row exists for that month.
 *
 * Lazy-persist: once computed, the result is written back to
 * `budget_periods.effective_allocation_cents` so subsequent reads are O(1).
 * Invalidation (see {@link invalidateForwardRollover}) clears these cached
 * values on upstream edits.
 *
 * Rollover math: when the category's `carryover_policy = 'rollover'`, the
 * prior month's remaining budget (effective − MTD spent, floored at 0) is
 * added to the current month's explicit `allocated_cents`. A missing prior
 * row contributes 0 (natural floor).
 */
export function getEffectiveAllocation(
  db: Db,
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
    .select({ carryoverPolicy: schema.categories.carryoverPolicy })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();

  let rolloverCents = 0;
  if (category?.carryoverPolicy === "rollover") {
    const { year: priorYear, month: priorMonth } = previousMonth(year, month);
    const prior = getEffectiveAllocation(db, categoryId, priorYear, priorMonth);
    if (prior) {
      const priorSpent = computeMtdSpent(db, categoryId, priorYear, priorMonth);
      rolloverCents = Math.max(0, prior.effectiveCents - priorSpent);
    }
  }

  const effectiveCents = allocatedCents + rolloverCents;

  db.update(schema.budgetPeriods)
    .set({ effectiveAllocationCents: effectiveCents })
    .where(eq(schema.budgetPeriods.id, row.id))
    .run();

  return { allocatedCents, rolloverCents, effectiveCents };
}

/**
 * Clear cached `effective_allocation_cents` for the edited month and every
 * later month of the same category. The next read of any affected month will
 * recompute from fresh explicit allocations and prior-month state.
 */
export function invalidateForwardRollover(
  db: Db,
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
 * Month-to-date spend in positive cents for the given category + month.
 * Excludes transfer-paired rows (both sides are bookkeeping, not spend).
 * Pending rows are included — they count toward spent until they post.
 * Refunds (positive amount_cents on a spend category) net against debits.
 */
export function computeMtdSpent(
  db: Db,
  categoryId: number,
  year: number,
  month: number,
): number {
  const firstDay = monthBoundary(year, month);
  const { year: nextYear, month: nextMonth } = nextMonthOf(year, month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);

  const row = db
    .select({
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.categoryId, categoryId),
        isNull(schema.transactions.transferPairId),
        gte(schema.transactions.date, firstDay),
        sql`${schema.transactions.date} < ${firstDayNext}`,
      ),
    )
    .get();

  const sum = row?.total ?? 0;
  return 0 - sum;
}

function previousMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function nextMonthOf(year: number, month: number): { year: number; month: number } {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function monthBoundary(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}
