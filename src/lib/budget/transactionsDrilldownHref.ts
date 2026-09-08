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

/**
 * `/categorize` → `/transactions` drilldown link for one merchant (D6 puts it
 * here, beside its sibling, rather than opening a third URL-builder module).
 *
 * `URLSearchParams`, never a template literal. 17 of the 363 real
 * `normalized_merchant` keys on this ledger carry `# * ? / ;` — and a bare
 * `#` does not error, it truncates the query string, so
 * `?merchant=GASCO#00000ANYTWN` silently filters on `GASCO` and shows a
 * different, plausible-looking row set.
 *
 * Returns `null` for an empty key rather than emitting a bare `?merchant=`,
 * which `flatten()` would normalize back to "no filter" — landing the user on
 * all 1,540 rows from a link that promised one merchant's. `null` is the
 * return type so the caller is forced by the compiler to render something
 * else (it already has a plain-text branch for the self-match case, D23).
 */
export function merchantDrilldownHref(merchant: string): string | null {
  if (merchant === "") return null;
  const params = new URLSearchParams({ merchant });
  return `/transactions?${params.toString()}`;
}
