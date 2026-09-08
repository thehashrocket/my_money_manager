/**
 * How an empty `normalized_merchant` is shown to a person.
 *
 * The empty key is reachable, not hypothetical: `parseCsv` passes the Memo
 * column through unchecked, `normalizeMerchant("")` returns `""` (pinned in
 * `normalize.test.ts`), and no write path rejects it — so one blank Memo cell
 * produces a stored key of `""`. Such a row is uncategorized, so it becomes a
 * `/categorize` group as well as a `/transactions` row.
 *
 * It lives here, shared, because the drilldown gave the two pages the same
 * job and they got different answers: `/transactions` rendered this fallback
 * while `/categorize` rendered the key verbatim — an invisible row name, an
 * sr-only label that read "Category for " and stopped, and no drilldown link
 * (`merchantDrilldownHref("")` correctly returns `null`). A blank row you
 * cannot read, explain, or click, which may carry many transactions.
 *
 * Zero imports on purpose: `_merchant-row.tsx` and `_transaction-row.tsx` are
 * both in the client graph, and this module sits beside `limits.ts` under the
 * same constraint — anything it imported would ship to the browser with it.
 */
export const NO_MERCHANT_NAME = "No merchant name";

/** The key as a person should read it — the key itself, or the fallback. */
export function merchantLabel(normalizedMerchant: string): string {
  return normalizedMerchant === "" ? NO_MERCHANT_NAME : normalizedMerchant;
}

/** Whether this key has a name at all, for callers that branch on layout. */
export function hasMerchantName(normalizedMerchant: string): boolean {
  return normalizedMerchant !== "";
}
