import { lastDayOfMonth, monthBoundary } from "./monthOfIso";

/**
 * `/budget` → `/transactions` drilldown link for one category, one month.
 *
 * D9: `/transactions` dropped its `year`/`month` filter params in favor of
 * `dateFrom`/`dateTo` (D6). A link still built with `year`/`month` wouldn't
 * error — Zod just ignores the unknown keys — it would silently widen to
 * "every transaction ever filed under this category," exactly the
 * silent-wrong-result class this app's rules exist to avoid.
 */
export function transactionsDrilldownHref(categoryId: number, year: number, month: number): string {
  const params = new URLSearchParams({
    categoryId: String(categoryId),
    dateFrom: monthBoundary(year, month),
    dateTo: lastDayOfMonth(year, month),
  });
  return `/transactions?${params.toString()}`;
}
