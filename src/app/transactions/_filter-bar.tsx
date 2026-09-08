import Link from "next/link";
import type { AccountOption } from "@/lib/accounts/listAccounts";
import type { LeafCategory } from "@/lib/categories";
import { currentMonth } from "@/lib/now";
import { lastDayOfMonth, monthBoundary } from "@/lib/budget/monthOfIso";
import { centsToDollarString } from "@/lib/money";
// From `limits`, not `searchParams`: this file is in the client graph, and the
// schema module carries zod, which is not tree-shakeable at module scope.
import { DEFAULT_PAGE_SIZE, MAX_SEARCH_LENGTH } from "@/lib/transactions/limits";
import { FOCUS_RING } from "@/components/ledger/focus-ring";

export type TransactionsFilterValues = {
  search: string | undefined;
  accountId: number | undefined;
  categoryId: number | "none" | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  amountMin: number | undefined;
  amountMax: number | undefined;
  pending: "posted" | "pending" | "all" | undefined;
  /**
   * T26/D14 — reveal transfer-paired rows. Carried here rather than in the
   * component's own state so `filterValuesToSearchParams` stays the single
   * place the URL is built; without that, page 2 silently drops the toggle.
   */
  includeTransfers: boolean | undefined;
  /**
   * D2 — exact `normalized_merchant`, set only by the `/categorize` drilldown
   * and by a row's own merchant link. It has no visible input in the form
   * below (D10: a text field would silently zero-row anyone who typed
   * `amazon` at a key stored as `AMAZON`), so like `pageSize` and
   * `includeTransfers` beside it, it survives an "Apply filters" submit ONLY
   * via the hidden field, and page 2 ONLY via the serializer.
   */
  merchant: string | undefined;
  /**
   * `undefined` means "the default", and is the overwhelmingly common case —
   * only a hand-edited or bookmarked `?pageSize=` puts a number here.
   *
   * It is a member of this type rather than a separate argument threaded past
   * it because THAT is what made it invisible. `pageSize` is one of the two
   * fields this app has already shipped silently dropping, and the round-trip
   * guard in `_filter-bar.test.ts` enumerates the keys of this type — so while
   * `pageSize` sat outside it, the one test written to catch this exact bug
   * structurally could not see it, and six `buildHref` call sites reset a
   * non-default page size with nothing failing. Paging position (`page`) is
   * deliberately NOT here: every one of those call sites changes the result
   * set, which must reset to page 1 or you land past the end of it.
   */
  pageSize: number | undefined;
};

/**
 * Every filter off. Spread-and-override rather than hand-listing the fields
 * you want at each call site, so adding field #12 cannot leave one of them
 * quietly carrying a filter it meant to drop — the annotation makes `tsc`
 * demand an entry here too.
 */
export const CLEARED_FILTERS: TransactionsFilterValues = {
  search: undefined,
  accountId: undefined,
  categoryId: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  amountMin: undefined,
  amountMax: undefined,
  pending: undefined,
  includeTransfers: undefined,
  merchant: undefined,
  pageSize: undefined,
};

/**
 * Is anything other than `merchant` narrowing the row set?
 *
 * Answered by asking the serializer rather than by walking the keys of
 * `TransactionsFilterValues`, because "set" and "active" are not the same
 * fact and a key walk gets it wrong on two fields: `includeTransfers` parses
 * to `false` rather than `undefined` when its param is absent, and `pending`
 * carries the inert `"all"`. `filterValuesToSearchParams` already encodes
 * which values are worth putting in a URL, so deferring to it means this
 * cannot drift away from what the filters actually do.
 *
 * Two fields are then excluded from that answer, for the same reason: neither
 * can be why the list came back empty.
 *
 * - `pageSize` is a display preference, not a predicate — it changes how many
 *   matching rows you see, never which rows match.
 * - `includeTransfers` only ever WIDENS the row set. Counting it made the one
 *   consumer of this function tell the opposite of the truth: on a stale
 *   `?merchant=OLDKEY`, the empty state correctly blames the key (the rule-10
 *   recovery), but one click of "Show transfers" — which preserves `merchant`
 *   and adds rows — flipped the copy to "the merchant key itself may still be
 *   fine", suppressing the diagnosis on a page that is emptier for no new
 *   reason.
 */
export function hasNonMerchantFilters(values: TransactionsFilterValues): boolean {
  const params = filterValuesToSearchParams({
    ...values,
    merchant: undefined,
    pageSize: undefined,
    includeTransfers: undefined,
  });
  return params.size > 0;
}

/**
 * The fields with their own `name=`d control in the form below. Everything
 * else `filterValuesToSearchParams` emits needs a hidden input or an "Apply
 * filters" submit drops it:
 *
 * - `pageSize` — set only by a hand-edited or bookmarked URL,
 * - `includeTransfers` (T26/E9) — its switch lives beside the result summary,
 *   not in this slab,
 * - `merchant` (D10/D18) — its only control is the removable chip in the page
 *   header, because a text field would zero-row anyone typing `amazon` at a
 *   key stored as `AMAZON`.
 *
 * Listing what IS visible, and deriving the hidden set as the remainder, is
 * what makes this safe: a new field is hidden by default and therefore carried
 * by default. The old spelling hand-wrote one `<input type="hidden">` per
 * field, so the failure mode for forgetting was a silently dropped filter.
 */
export const VISIBLE_FIELDS = new Set([
  "search",
  "accountId",
  "categoryId",
  "dateFrom",
  "dateTo",
  "amountMin",
  "amountMax",
  "pending",
]);

/**
 * Server-rendered GET form — no client JS, matching D4's "extend the
 * existing pattern" call and this page's existing `<Link>`-based Pagination.
 * Submitting reloads `/transactions` with the new query string; omitting a
 * `page` field means any filter change implicitly resets to page 1.
 */
export function FilterBar({
  values,
  leafCategories,
  accounts,
}: {
  values: TransactionsFilterValues;
  leafCategories: LeafCategory[];
  accounts: AccountOption[];
}) {
  const { year, month } = currentMonth();
  // `buildHref` carries `pageSize` itself now that it is a member of
  // `TransactionsFilterValues`, so these two quick links need no special
  // treatment — the `withPageSize` string-splicing helper that used to wrap
  // them (and that three other call sites forgot to use) is gone.
  const thisMonthHref = buildHref({
    ...values,
    dateFrom: monthBoundary(year, month),
    dateTo: lastDayOfMonth(year, month),
  });
  // "Clear filters" clears FILTERS. A page size is a display preference you
  // set deliberately and can only change through the URL, so wiping it here
  // would be one more silent reset — the class this whole field exists to fix.
  const clearFiltersHref = buildHref({
    ...CLEARED_FILTERS,
    pageSize: values.pageSize,
  });

  // A filter can name an id that isn't in the picker's own list — an
  // archived category (still reachable via an old /budget drilldown link)
  // or a hand-edited URL. Without a matching <option>, the browser silently
  // selects the first option ("All ...") while the id is still the one
  // actively filtering — so resubmitting the form without touching this
  // field would drop the filter the URL had been enforcing. A synthetic
  // option keeps the select's displayed state honest.
  const accountKnown = values.accountId === undefined || accounts.some((a) => a.id === values.accountId);
  const categoryKnown =
    values.categoryId === undefined ||
    values.categoryId === "none" ||
    leafCategories.some((c) => c.id === values.categoryId);

  return (
    <form
      method="GET"
      action="/transactions"
      className="grid grid-cols-2 gap-3 rounded-md border border-border bg-card p-4 text-sm sm:grid-cols-4"
    >
      {/* A non-default pageSize (e.g. from a bookmarked ?pageSize=200 link)
          has no visible field in this form — without carrying it forward,
          submitting any filter silently reverts to the 50-row default.
          This is the FOURTH gate a filter has to clear (the other three are
          the contract edges named in `_filter-bar.test.ts`), and it is
          entirely separate machinery: a field can be in the type, emitted by
          `filterValuesToSearchParams` and accepted by the schema, and still
          be dropped by an "Apply filters" submit if nobody gives it an input.
          `filterValuesToSearchParams` is the shared source of truth for which
          fields need one, so these are generated from it rather than
          hand-listed — a new field is then carried by default. */}
      {[...filterValuesToSearchParams(values)]
        .filter(([name]) => !VISIBLE_FIELDS.has(name))
        .map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      <label className="col-span-2 flex flex-col gap-1 sm:col-span-4">
        <span className="text-xs text-muted-foreground">Search</span>
        <input
          type="search"
          name="search"
          defaultValue={values.search ?? ""}
          placeholder="Description, merchant, or payee…"
          maxLength={MAX_SEARCH_LENGTH}
          className="rounded-md border border-border bg-background px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Account</span>
        <select
          name="accountId"
          defaultValue={values.accountId !== undefined ? String(values.accountId) : ""}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          <option value="">All accounts</option>
          {!accountKnown ? <option value={values.accountId}>Account {values.accountId}</option> : null}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Category</span>
        <select
          name="categoryId"
          defaultValue={values.categoryId !== undefined ? String(values.categoryId) : ""}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          <option value="">All categories</option>
          <option value="none">Uncategorized</option>
          {!categoryKnown ? <option value={values.categoryId}>Category {values.categoryId}</option> : null}
          {leafCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">From</span>
        <input
          type="date"
          name="dateFrom"
          defaultValue={values.dateFrom ?? ""}
          className="rounded-md border border-border bg-background px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">To</span>
        <input
          type="date"
          name="dateTo"
          defaultValue={values.dateTo ?? ""}
          className="rounded-md border border-border bg-background px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Amount min</span>
        <input
          type="text"
          inputMode="decimal"
          name="amountMin"
          placeholder="$0.00"
          defaultValue={values.amountMin !== undefined ? centsToDollarString(values.amountMin) : ""}
          className="rounded-md border border-border bg-background px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Amount max</span>
        <input
          type="text"
          inputMode="decimal"
          name="amountMax"
          placeholder="$0.00"
          defaultValue={values.amountMax !== undefined ? centsToDollarString(values.amountMax) : ""}
          className="rounded-md border border-border bg-background px-2 py-1"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Status</span>
        <select
          name="pending"
          defaultValue={values.pending ?? "all"}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          <option value="all">All</option>
          <option value="posted">Posted only</option>
          <option value="pending">Pending only</option>
        </select>
      </label>

      <div className="col-span-2 flex items-end gap-3 sm:col-span-4">
        <button
          type="submit"
          className={`rounded-md border border-border bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 ${FOCUS_RING}`}
        >
          Apply filters
        </button>
        <Link href={thisMonthHref} className={`text-muted-foreground underline-offset-4 hover:underline ${FOCUS_RING}`}>
          This month
        </Link>
        <Link href={clearFiltersHref} className={`text-muted-foreground underline-offset-4 hover:underline ${FOCUS_RING}`}>
          Clear filters
        </Link>
      </div>
    </form>
  );
}

/**
 * Shared with `_transactions-ui.tsx`'s Pagination — every active filter must
 * carry forward onto page-2+ links or it silently vanishes.
 */
export function filterValuesToSearchParams(values: TransactionsFilterValues): URLSearchParams {
  const params = new URLSearchParams();
  if (values.search) params.set("search", values.search);
  if (values.accountId !== undefined) params.set("accountId", String(values.accountId));
  if (values.categoryId !== undefined) params.set("categoryId", String(values.categoryId));
  if (values.dateFrom !== undefined) params.set("dateFrom", values.dateFrom);
  if (values.dateTo !== undefined) params.set("dateTo", values.dateTo);
  if (values.amountMin !== undefined) params.set("amountMin", centsToDollarString(values.amountMin));
  if (values.amountMax !== undefined) params.set("amountMax", centsToDollarString(values.amountMax));
  if (values.pending !== undefined && values.pending !== "all") params.set("pending", values.pending);
  if (values.includeTransfers) params.set("includeTransfers", "true");
  // `""` is skipped, not emitted. `flatten()` turns a bare `?merchant=` back
  // into `undefined` at the destination, so a row whose `normalized_merchant`
  // is empty would produce a link that promises one merchant and silently
  // lands on all 1,540 rows. `merchantDrilldownHref` guards this by returning
  // `null`; the row-level link builder goes through here instead, so the guard
  // has to live at the one place both paths share.
  if (values.merchant !== undefined && values.merchant !== "") {
    params.set("merchant", values.merchant);
  }
  // Emitted only when it differs from the default, so an ordinary link stays
  // clean — but emitted from HERE, which is the point: every `buildHref`
  // caller now carries a deliberate page size forward without knowing it has
  // to, and the round-trip guard covers it like any other field.
  if (values.pageSize !== undefined && values.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(values.pageSize));
  }
  return params;
}

export function buildHref(values: TransactionsFilterValues): string {
  const qs = filterValuesToSearchParams(values).toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}

/**
 * The zero-result state's `?search=` recovery link — CLAUDE.md rule 10 names
 * this as the mitigation for the one coupling a merchant backfill cannot
 * repair from its own side, so it is worth pinning rather than spelling
 * inline.
 *
 * Two things about the shape are load-bearing and both were bugs first:
 *
 * - **Every other filter is dropped** (`CLEARED_FILTERS`, not the live values).
 *   Keeping them meant the suggested fix landed on a second empty page
 *   whenever a date range was what emptied the first.
 * - **The key is truncated to `MAX_SEARCH_LENGTH`.** `merchant` is
 *   deliberately unbounded (D12) while `search` is capped, so an over-long key
 *   turned the one offered escape hatch into a 404. `search` is `LIKE %x%`, so
 *   a prefix still finds the rows.
 *
 * `pageSize` rides along because it is a display preference, not a predicate.
 *
 * It is a function rather than an expression inside `EmptyState` so the tests
 * can assert against the link the page actually renders. While it was inline,
 * the suite that documents both bugs above asserted against its own private
 * copy of this expression — so either bug could have been reintroduced in
 * `_transactions-ui.tsx` with every test still green.
 */
export function merchantSearchRecoveryHref(
  merchant: string,
  pageSize: number | undefined,
): string {
  return buildHref({
    ...CLEARED_FILTERS,
    pageSize,
    search: merchant.slice(0, MAX_SEARCH_LENGTH),
  });
}
