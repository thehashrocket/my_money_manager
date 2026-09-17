import { gte, lt, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import { monthBoundary, nextMonthOf, type YearMonth } from "@/lib/budget/monthOfIso";

/**
 * The `[gte(date, firstDayOfMonth), lt(date, firstDayOfNextMonth))` pair that
 * narrows a `transactions.date` predicate to one calendar month — shared by
 * `loadUncategorizedBacklog`, `loadMerchantGroups` and `bulkCategorize`,
 * which each hand-rolled this same three-line computation before this
 * extraction (one of them via a raw `sql` template for the upper bound
 * instead of `lt()`, which this version does not repeat).
 *
 * `scope` undefined returns an empty array — spread into an `and(...)` call
 * alongside the caller's other predicates, an absent month predicate is a
 * no-op rather than a branch every caller would otherwise need of its own.
 */
export function monthDatePredicates(scope: YearMonth | undefined): SQL[] {
  if (!scope) return [];
  const firstDay = monthBoundary(scope.year, scope.month);
  const { year: nextYear, month: nextMonth } = nextMonthOf(scope.year, scope.month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);
  return [
    gte(schema.transactions.date, firstDay),
    lt(schema.transactions.date, firstDayNext),
  ];
}
