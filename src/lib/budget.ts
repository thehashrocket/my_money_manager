import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { schema } from "@/db";

/**
 * Structural DB type — accepts both the singleton `better-sqlite3`
 * database and a transaction handle (`db.transaction((tx) => …)`). Both
 * derive from `BaseSQLiteDatabase` and expose the same query-builder API
 * used here.
 */
type Db = BaseSQLiteDatabase<
  "sync",
  unknown,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

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
  db: Db,
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
    .select({ carryoverPolicy: schema.categories.carryoverPolicy })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();

  let rolloverCents = 0;
  if (category?.carryoverPolicy === "rollover") {
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
