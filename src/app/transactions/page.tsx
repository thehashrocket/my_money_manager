import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/db";
import { listLeafCategories, type LeafCategory } from "@/lib/categories";
import { listAccounts, listCardAccounts, type AccountOption } from "@/lib/accounts/listAccounts";
import { loadUncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";
import {
  loadTransactions,
  summarizeByCategory,
  type CategoryBreakdownRow,
  type FilterPredicateInput,
} from "@/lib/categorize/loadTransactions";
import { centsToDollarString } from "@/lib/money";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import {
  DEFAULT_PAGE_SIZE,
  flatten,
  resolveIsPending,
  searchParamsSchema,
  type RawSearchParams,
} from "@/lib/transactions/searchParams";
import {
  buildHref,
  FilterBar,
  hasNonMerchantFilters,
  type TransactionsFilterValues,
} from "./_filter-bar";
import { RetargetForm, type FiledCategory } from "./_retarget-form";
import { TransactionsUi } from "./_transactions-ui";

/**
 * `/transactions` — filtered, paginated transaction list with inline
 * categorize. Entry points:
 * - `/budget` row link → `?categoryId=<leafId>&dateFrom=<first>&dateTo=<last>`
 *   for drilldown into one category's transactions for one month
 * - `/categorize` row link → `?merchant=<normalized_merchant>` for drilldown
 *   into one merchant's transactions (D2 — exact, not `search=`)
 * - standalone → no filter, newest first
 * - `_filter-bar.tsx`'s GET form → any combination of search/account/
 *   category/date-range/amount-range/pending
 *
 * Invalid searchParams (non-int, out-of-range, calendar-invalid dates,
 * unparseable amounts) route through `notFound()` so URL tampering lands in
 * Next's 404 UI rather than a server error banner (matches
 * `/budget/[year]/[month]` behavior). The schema itself lives in
 * `@/lib/transactions/searchParams` (D11) so the round-trip test can reach
 * both halves of the carry-forward contract.
 *
 * Transfer-paired rows are excluded from the list server-side (see
 * `loadTransactions`); the categorize action additionally refuses them as a
 * defense-in-depth check.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await connection();
  const raw = await searchParams;
  const parsed = searchParamsSchema.safeParse(flatten(raw));
  if (!parsed.success) {
    // Logged before the 404 because the amount fields are free text on a GET
    // form, so this is reachable by typing `12.5o` — not only by tampering.
    // The user gets Next's generic 404 either way; without this line the
    // server keeps no record of WHICH param was rejected or why, which is
    // exactly what you need to tell a typo apart from an in-app link builder
    // emitting a param the schema refuses. That second case has shipped
    // twice. Paths only, never values: a `search`/`merchant` value is ledger
    // content and does not belong in a log.
    console.error("[/transactions] rejected searchParams", {
      keys: Object.keys(raw),
      issues: parsed.error.issues.map((i) =>
        // A root-level `.strict()` violation carries `path: []` and puts the
        // offending NAMES on `issue.keys` — so mapping to `path` alone logged
        // `{path: [], code: "unrecognized_keys"}` and named nothing, in
        // exactly the link-builder case above. Verified against this repo's
        // zod 4.5.4. A key name is URL/schema space, not ledger content, so
        // the no-values rule does not cover it.
        i.code === "unrecognized_keys"
          ? { code: i.code, unrecognized: i.keys }
          : { code: i.code, path: i.path },
      ),
    });
    notFound();
  }

  const {
    categoryId,
    accountId,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    pending,
    search,
    includeTransfers,
    merchant,
  } = parsed.data;
  // Logged for the same reason as the schema rejection above, and these are
  // MORE reachable than that path: both fields are user-entered on a GET form,
  // and `amountSchema` applies `Math.abs`, so typing `-100` into "Amount min"
  // (a natural reading on a ledger where withdrawals are negative) silently
  // becomes 10000 and trips this guard. The user gets Next's stock 404 with no
  // field named. A date bound and a cents magnitude are schema-space, not
  // ledger content, so unlike a `search`/`merchant` value they are safe to log.
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
    console.error("[/transactions] rejected searchParams", {
      reason: "dateFrom is after dateTo",
      dateFrom,
      dateTo,
    });
    notFound();
  }
  if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) {
    console.error("[/transactions] rejected searchParams", {
      reason: "amountMin is above amountMax (both are magnitudes — the sign is dropped)",
      amountMinCents: amountMin,
      amountMaxCents: amountMax,
    });
    notFound();
  }

  const isPending = resolveIsPending(pending);

  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? DEFAULT_PAGE_SIZE;

  const predicateInput: { [K in keyof FilterPredicateInput & string]: FilterPredicateInput[K] } = {
    categoryId,
    accountId,
    dateFrom,
    dateTo,
    amountMinCents: amountMin,
    amountMaxCents: amountMax,
    isPending,
    search,
    includeTransfers,
    merchant,
  };

  const { rows, totalCount } = loadTransactions(db, {
    ...predicateInput,
    page,
    pageSize,
  });

  // D18 — only the merchant header renders a filing breakdown, so only the
  // merchant case pays for the extra aggregate. It shares `loadTransactions`'
  // own predicates, so the two can never disagree about which rows match.
  // (Which rows match, not which instant they were read at — see
  // `summarizeByCategory`'s docstring.)
  const categoryBreakdown =
    merchant !== undefined ? summarizeByCategory(db, predicateInput) : null;

  // The SAME aggregate over `{ merchant }` alone — deliberately not
  // `predicateInput`. `bulkRetarget` derives its rows from the key and ignores
  // every other filter (see its header for why), so the control has to be
  // labelled with the key-wide count or its button would promise a number it
  // will not move. That is the same failure `MerchantSummary.scoped` exists to
  // prevent, arriving from the other side: there the fix is to omit a count we
  // cannot honour, here it is to show the one we can.
  //
  // A second grouped query rather than a conditional reuse of the one above:
  // they coincide only when NO other filter is active, and `includeTransfers`
  // — which `hasNonMerchantFilters` deliberately ignores, because it only ever
  // widens the list — is enough on its own to make them differ.
  const merchantWideBreakdown =
    merchant !== undefined ? summarizeByCategory(db, { merchant }) : null;

  const filedCategories: FiledCategory[] =
    merchantWideBreakdown === null
      ? []
      : merchantWideBreakdown.flatMap((row) =>
          row.categoryId === null || row.categoryName === null
            ? []
            : [{ categoryId: row.categoryId, categoryName: row.categoryName, count: row.count }],
        );

  // X3/B7: the picker excludes archived categories (you can't re-file a
  // transaction into one), but a `?categoryId=` filter can point at a
  // category that's since been archived — e.g. a `/budget` row link
  // followed after the fact. Resolving the filter's own label needs the
  // archived category to still be findable, or the header silently drops
  // the name it's filtering by.
  const leafCategories = listLeafCategories(db);
  const allCategoriesForLabels = listLeafCategories(db, { includeArchived: true });
  const accounts = listAccounts(db);
  const cardAccounts = listCardAccounts(db);
  // E5: unscoped (all-time), matching this page's existing behavior — only
  // /budget's own banner is month-scoped (X4).
  const uncategorizedBacklog = loadUncategorizedBacklog(db);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const activeCategoryName = resolveActiveCategoryName(categoryId, allCategoriesForLabels);
  const activeAccountName = resolveActiveAccountName(accountId, accounts);

  const filterValues: TransactionsFilterValues = {
    search,
    accountId,
    categoryId,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    pending,
    includeTransfers,
    merchant,
    // The raw parsed value, not the `?? DEFAULT_PAGE_SIZE` one above: an
    // absent `?pageSize=` must serialize back to absent, or every link this
    // page builds would carry a redundant `pageSize=50`.
    pageSize: parsed.data.pageSize,
  };

  return (
    <main className="mx-auto max-w-5xl p-5 space-y-7 [font-variant-numeric:tabular-nums]">
      <FilterHeader
        values={filterValues}
        categoryName={activeCategoryName}
        accountName={activeAccountName}
        totalCount={totalCount}
        categoryBreakdown={categoryBreakdown}
      />

      {/* Under the header rather than inside it: the header answers "what am I
          looking at", and this is a write. It renders only on the merchant
          drilldown and only when that merchant HAS filed rows — with nothing
          filed there is nothing to move, and `bulkCategorize` on /categorize is
          the right tool for what is left. */}
      {merchant !== undefined && filedCategories.length > 0 ? (
        <RetargetForm
          normalizedMerchant={merchant}
          filed={filedCategories}
          leafCategories={leafCategories}
        />
      ) : null}

      <FilterBar values={filterValues} leafCategories={leafCategories} accounts={accounts} />

      <TransactionsUi
        rows={rows}
        leafCategories={leafCategories}
        initialBacklog={uncategorizedBacklog}
        page={page}
        pageSize={pageSize}
        totalCount={totalCount}
        totalPages={totalPages}
        searchParams={filterValues}
        cardAccounts={cardAccounts}
      />
    </main>
  );
}

function resolveActiveCategoryName(
  categoryId: number | "none" | undefined,
  leaves: LeafCategory[],
): string | null {
  if (categoryId === undefined) return null;
  if (categoryId === "none") return "Uncategorized";
  return leaves.find((l) => l.id === categoryId)?.name ?? null;
}

function resolveActiveAccountName(
  accountId: number | undefined,
  accounts: AccountOption[],
): string | null {
  if (accountId === undefined) return null;
  return accounts.find((a) => a.id === accountId)?.name ?? null;
}

/**
 * D18 — the header block. Replaces a `parts.join(" · ")` `<p>` that could
 * only ever state facts, with the one place this page answers three
 * questions at once: what am I looking at, how do I stop looking at part of
 * it, and how do I finish what I came here to do.
 *
 * The merchant drilldown is the reason it exists. You arrive from
 * `/categorize` in the middle of a task, so the header carries the return
 * link back (mirroring `categorize/page.tsx`'s own `← Budget`), the filing
 * history that made D3 show ALL of a merchant's rows rather than just its
 * uncategorized ones, and the finishing action.
 */
function FilterHeader({
  values,
  categoryName,
  accountName,
  totalCount,
  categoryBreakdown,
}: {
  values: TransactionsFilterValues;
  categoryName: string | null;
  accountName: string | null;
  totalCount: number;
  categoryBreakdown: CategoryBreakdownRow[] | null;
}) {
  const { merchant } = values;
  return (
    <header className="space-y-3">
      {merchant !== undefined ? (
        <Link
          href="/categorize"
          className={`inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-wide text-ink-3 underline-offset-4 hover:text-terracotta hover:underline ${FOCUS_RING}`}
        >
          ← Categorize
        </Link>
      ) : null}
      <h1 className="font-display text-[var(--text-3xl)] leading-none tracking-[-0.015em]">
        Transactions
      </h1>
      <FilterChips values={values} categoryName={categoryName} accountName={accountName} />
      {/* `categoryBreakdown !== null`, not `merchant !== undefined`: the two
          conditions are equivalent today (both gate on the merchant filter in
          `TransactionsPage`), but they were two separate expressions, and a
          `?? []` here would have let a widened gate render the summary from
          an invented empty breakdown — reporting 0 uncategorized and hiding
          the "Categorize all N" action for a merchant that has plenty. */}
      {categoryBreakdown !== null ? (
        <MerchantSummary
          totalCount={totalCount}
          breakdown={categoryBreakdown}
          scoped={hasNonMerchantFilters(values)}
        />
      ) : (
        <p className="text-sm text-ink-2">
          <strong className="text-foreground">{totalCount}</strong> row
          {totalCount === 1 ? "" : "s"}
        </p>
      )}
    </header>
  );
}

/**
 * The active filters as a chip row (D18), replacing the joined sentence.
 *
 * Only the merchant chip is removable, and that is deliberate rather than an
 * oversight: the merchant filter is the only one with no visible control
 * anywhere on the page, so it is the only one you could otherwise get stuck
 * inside. The other eight each have their own field in `FilterBar` below —
 * blank it and hit "Apply filters". Giving all nine a chip `×` is tracked in
 * TODOS.md as a consistency improvement, not a fix for anything unreachable.
 */
function FilterChips({
  values,
  categoryName,
  accountName,
}: {
  values: TransactionsFilterValues;
  categoryName: string | null;
  accountName: string | null;
}) {
  const facts: string[] = [];
  if (values.search !== undefined) facts.push(`"${values.search}"`);
  if (categoryName !== null) facts.push(categoryName);
  else if (values.categoryId !== undefined) facts.push(`Category ${values.categoryId}`);
  if (accountName !== null) facts.push(accountName);
  else if (values.accountId !== undefined) facts.push(`Account ${values.accountId}`);
  if (values.dateFrom !== undefined || values.dateTo !== undefined) {
    facts.push(`${values.dateFrom ?? "…"} – ${values.dateTo ?? "…"}`);
  }
  if (values.amountMin !== undefined || values.amountMax !== undefined) {
    const min = values.amountMin !== undefined ? `$${centsToDollarString(values.amountMin)}` : "$0";
    const max = values.amountMax !== undefined ? `$${centsToDollarString(values.amountMax)}` : "…";
    facts.push(`${min} – ${max}`);
  }
  if (values.pending === "posted") facts.push("Posted only");
  else if (values.pending === "pending") facts.push("Pending only");

  if (values.merchant === undefined && facts.length === 0) {
    return <p className="text-sm text-ink-3">All transactions</p>;
  }

  return (
    <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2">
      {values.merchant !== undefined ? (
        <li className="flex min-h-11 items-center gap-1 rounded-[999px] bg-terracotta pl-3 pr-1 text-sm text-paper-0">
          <span className="max-w-[28ch] truncate font-mono" title={values.merchant}>
            {values.merchant}
          </span>
          <Link
            /* The glyph is silent to a screen reader (the DS66 parens rule),
               so the label carries the meaning. No `page` in the rebuilt
               href: removing a filter widens the result set, which has to
               reset to page 1 or you land past the end of the new one.

               Deliberately NOT `FOCUS_RING`: this is the one control sitting
               ON the terracotta fill, where a terracotta ring is invisible.
               Same 2px/2px geometry, paper ink. */
            href={buildHref({ ...values, merchant: undefined })}
            aria-label="Remove merchant filter"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-[999px] text-base leading-none hover:bg-[color-mix(in_oklch,var(--paper-0)_25%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--paper-0)]"
          >
            <span aria-hidden>×</span>
          </Link>
        </li>
      ) : null}
      {facts.map((fact, i) => (
        <li
          /* Index-keyed: two different filters can render the same label —
             an account and a category both named "Checking", say — and this
             list is rebuilt from scratch on every render anyway. */
          key={`${i}-${fact}`}
          className="rounded-[999px] border border-border px-3 py-1 text-sm text-ink-2"
        >
          {fact}
        </li>
      ))}
    </ul>
  );
}

/**
 * `50 rows, 1 uncategorized · 49 filed as Gas`.
 *
 * The merchant name is not repeated here — `FilterChips` above renders it as
 * the removable chip, once.
 *
 * The filed counts are the whole point of D3=A: that example is `COSTCO GAS`,
 * which shows 1 uncategorized row on `/categorize` but 50 in total, 49 of
 * them already filed as Gas — which answers the question you clicked to ask
 * before you read a single row. (The example previously read `59 rows, 53
 * uncategorized · 49 filed as Gas`, which is impossible: it spliced AMAZON's
 * row and backlog counts onto COSTCO GAS's filing history, and 53 + 49
 * overruns the 59 it claimed to break down.)
 */
function MerchantSummary({
  totalCount,
  breakdown,
  scoped,
}: {
  totalCount: number;
  breakdown: CategoryBreakdownRow[];
  /**
   * True when a filter other than `merchant` is also narrowing the list.
   *
   * The breakdown describes the LIST — it shares `buildPredicates` with it,
   * which is the invariant that stops the header describing rows the list is
   * not showing. `/categorize` shares none of that: `loadMerchantGroups`
   * filters on `category_id IS NULL AND transfer_pair_id IS NULL` and nothing
   * else, so it offers every uncategorized row for the key regardless of the
   * date range, account or amount window in force here.
   *
   * So the count is right about this page and wrong about the destination,
   * and the CTA is the one place that difference can cost money. Measured on
   * the real ledger: with a month selected, `AMAZON` reads between 3 and 17
   * depending on the month, while `/categorize` files all 53 rows ($2,647.30)
   * across eight months. The user is told one number and moves another.
   *
   * Naming a count we cannot honour is the failure; omitting it is not. When
   * scoped, the CTA drops the number rather than the link.
   */
  scoped: boolean;
}) {
  const uncategorized = breakdown.find((r) => r.categoryId === null)?.count ?? 0;
  const filed = breakdown.filter((r) => r.categoryId !== null).slice(0, 2);
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm text-ink-2">
      <p>
        <strong className="text-foreground">{totalCount}</strong> row
        {totalCount === 1 ? "" : "s"}
        {uncategorized > 0 ? `, ${uncategorized} uncategorized` : null}
        {filed.map((row) => (
          <span key={row.categoryId}>
            {" · "}
            {row.count} filed as {row.categoryName}
          </span>
        ))}
      </p>
      {uncategorized > 0 ? (
        <Link
          href="/categorize"
          className={`inline-flex min-h-11 items-center font-medium text-terracotta underline-offset-4 hover:underline ${FOCUS_RING}`}
        >
          {scoped ? "Categorize this merchant →" : `Categorize all ${uncategorized} →`}
        </Link>
      ) : null}
    </div>
  );
}
