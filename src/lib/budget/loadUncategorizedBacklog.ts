import { and, gte, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { monthBoundary, nextMonthOf } from "./monthOfIso";

type Db = typeof defaultDb;

export type UncategorizedBacklog = {
  count: number;
  /** Signed sum of `amount_cents` (spend is negative; refunds positive). */
  totalCents: number;
};

/**
 * X4 + E5: extracted from `loadMonthView` so `/categorize` and
 * `/transactions` — which only ever wanted this one COUNT(*) + SUM — stop
 * building and discarding a full month view (every allocation, every spend
 * sum, the rollover scan) to get it. Those two routes call this directly and
 * stay unscoped (all-time), matching their existing behavior; `loadMonthView`
 * is the only caller that passes `scope`, so its own `uncategorizedBacklog`
 * field narrows to the month actually being viewed — without a scope,
 * September's `received` figure could read short with no local explanation
 * while the banner blamed 498 rows from every month.
 */
export function loadUncategorizedBacklog(
  db: Db,
  scope?: { year: number; month: number },
): UncategorizedBacklog {
  const datePredicates = scope
    ? (() => {
        const firstDay = monthBoundary(scope.year, scope.month);
        const { year: nextYear, month: nextMonth } = nextMonthOf(scope.year, scope.month);
        const firstDayNext = monthBoundary(nextYear, nextMonth);
        return [gte(schema.transactions.date, firstDay), sql`${schema.transactions.date} < ${firstDayNext}`];
      })()
    : [];

  const row = db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
        ...datePredicates,
      ),
    )
    .get();

  return {
    count: row?.count ?? 0,
    totalCents: row?.total ?? 0,
  };
}
