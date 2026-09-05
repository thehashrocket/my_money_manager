import Link from "next/link";
import type { AccountOption } from "@/lib/accounts/listAccounts";
import type { LeafCategory } from "@/lib/categories";
import { currentMonth } from "@/lib/now";
import { lastDayOfMonth, monthBoundary } from "@/lib/budget/monthOfIso";
import { centsToDollarString } from "@/lib/money";

/** Mirrors page.tsx's Zod `.max()` — imported there so the client-side limit and validation can't drift. */
export const MAX_SEARCH_LENGTH = 200;

export type TransactionsFilterValues = {
  search: string | undefined;
  accountId: number | undefined;
  categoryId: number | "none" | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  amountMin: number | undefined;
  amountMax: number | undefined;
  pending: "posted" | "pending" | "all" | undefined;
};

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
  pageSize,
}: {
  values: TransactionsFilterValues;
  leafCategories: LeafCategory[];
  accounts: AccountOption[];
  /** Carried as a hidden field so a non-default page size survives a filter change — matches Pagination's own `pageSize !== 50` rule. */
  pageSize: number;
}) {
  const { year, month } = currentMonth();
  // Pagination and the main form both carry a non-default pageSize forward;
  // these two quick links rebuild the URL independently and need the same
  // treatment or clicking either one silently snaps the list back to 50 rows.
  const withPageSize = (href: string) => (pageSize !== 50 ? `${href}${href.includes("?") ? "&" : "?"}pageSize=${pageSize}` : href);
  const thisMonthHref = withPageSize(
    buildHref({
      ...values,
      dateFrom: monthBoundary(year, month),
      dateTo: lastDayOfMonth(year, month),
    }),
  );
  const clearFiltersHref = withPageSize("/transactions");

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
          submitting any filter silently reverts to the 50-row default,
          matching Pagination's own `pageSize !== 50` rule below it. */}
      {pageSize !== 50 ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
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
          className="rounded-md border border-border bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90"
        >
          Apply filters
        </button>
        <Link href={thisMonthHref} className="text-muted-foreground underline-offset-4 hover:underline">
          This month
        </Link>
        <Link href={clearFiltersHref} className="text-muted-foreground underline-offset-4 hover:underline">
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
  return params;
}

export function buildHref(values: TransactionsFilterValues): string {
  const qs = filterValuesToSearchParams(values).toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}
