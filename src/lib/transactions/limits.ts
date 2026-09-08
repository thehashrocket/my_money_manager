/**
 * The two `/transactions` URL limits, in a module with NO dependencies.
 *
 * They belong to `searchParams.ts` conceptually, and lived there first. But
 * `_filter-bar.tsx` imports `MAX_SEARCH_LENGTH` for the search input's own
 * `maxLength`, and `_filter-bar.tsx` is in the client graph (`_transactions-ui.tsx`
 * and `_transaction-row.tsx` are both `"use client"` and import from it). A
 * zod schema built at module scope is not tree-shakeable, so importing one
 * number out of `searchParams.ts` dragged the whole of zod into the route's
 * client bundle: measured with two full `next build` runs, `/transactions`
 * first-load JS went 831,806 -> 1,207,712 uncompressed bytes, +376 KB / +45%,
 * on a route that shipped no zod at all before this feature.
 *
 * So the constants live here, importable from either side of the boundary,
 * and `searchParams.ts` imports them rather than declaring them.
 */

/** Mirrors the filter form's own `maxLength` — imported there so the client-side limit and validation can't drift. */
export const MAX_SEARCH_LENGTH = 200;
export const MAX_PAGE_SIZE = 500;
