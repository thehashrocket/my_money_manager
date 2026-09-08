"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { LeafCategory } from "@/lib/categories";
import type { TransactionRow } from "@/lib/categorize/loadTransactions";
import type { UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { formatCents } from "@/lib/money";
import type { AccountOption } from "@/lib/accounts/listAccounts";
import { StateCard } from "@/components/ledger/state-card";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import {
  buildHref,
  filterValuesToSearchParams,
  hasNonMerchantFilters,
  merchantSearchRecoveryHref,
  type TransactionsFilterValues,
} from "./_filter-bar";
import {
  TransactionColumnHeaders,
  TransactionRowForm,
  TransferRowItem,
} from "./_transaction-row";

type Props = {
  rows: TransactionRow[];
  leafCategories: LeafCategory[];
  initialBacklog: UncategorizedBacklog;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  searchParams: TransactionsFilterValues;
  /** Credit cards, for the row menu's "Mark as payment to" (DS52). */
  cardAccounts: AccountOption[];
};

/**
 * Client island for `/transactions`. Owns a live backlog counter that
 * decrements on categorize-from-NULL and increments on Undo. First paint
 * matches the server-rendered number from `loadMonthView`.
 */
export function TransactionsUi({
  rows,
  leafCategories,
  initialBacklog,
  page,
  pageSize,
  totalCount,
  totalPages,
  searchParams,
  cardAccounts,
}: Props) {
  const [backlogCount, setBacklogCount] = useState(initialBacklog.count);
  const router = useRouter();

  // A pairing change alters which rows this list should show at all (a newly
  // paired row disappears unless "show transfers" is on), so the server has
  // to re-run rather than the client patching its own list.
  const onPairingChanged = () => router.refresh();

  return (
    <div className="space-y-4">
      <BacklogStrip count={backlogCount} totalCents={initialBacklog.totalCents} />
      <ResultSummary
        totalCount={totalCount}
        searchParams={searchParams}
      />
      {rows.length === 0 ? (
        <EmptyState
          totalCount={totalCount}
          searchParams={searchParams}
        />
      ) : (
        /* D17 [HARD REJECTION] — one ruled list, not N stacked card shells. */
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          <TransactionColumnHeaders merchantFiltered={searchParams.merchant !== undefined} />
          <ul className="divide-y divide-[var(--rule-faint)]">
            {rows.map((row) => (
              <li key={row.id}>
                {row.transferPairId !== null ? (
                  <TransferRowItem
                    row={row}
                    cardAccounts={cardAccounts}
                    onPairingChanged={onPairingChanged}
                    filterValues={searchParams}
                  />
                ) : (
                  <TransactionRowForm
                    row={row}
                    leafCategories={leafCategories}
                    cardAccounts={cardAccounts}
                    onPairingChanged={onPairingChanged}
                    filterValues={searchParams}
                    onCategorized={(priorCategoryId, updatedCount) => {
                      if (priorCategoryId === null) {
                        setBacklogCount((c) => Math.max(0, c - updatedCount));
                      }
                    }}
                    onUndone={(priorCategoryId, revertedCount) => {
                      if (priorCategoryId === null) {
                        setBacklogCount((c) => c + revertedCount);
                      }
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Pagination
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        totalCount={totalCount}
        searchParams={searchParams}
      />
    </div>
  );
}

/**
 * T14/D21 — the shared `color-mix(… var(--accent-amber) …)` formula, the same
 * one `BacklogBanner`, the dashboard tile and the Spine chip use, rather than
 * Tailwind's raw `amber-*` palette. DESIGN.md's audit table named this strip
 * specifically.
 *
 * `-mx-5` must stay equal to the page's `p-5` gutter or the bleed stops
 * reaching the viewport edges.
 */
function BacklogStrip({
  count,
  totalCents,
}: {
  count: number;
  totalCents: number;
}) {
  if (count === 0) return null;
  return (
    <div
      aria-live="polite"
      className="sticky top-0 z-10 -mx-5 flex items-center justify-between gap-3 border-b px-5 py-2 text-sm backdrop-blur"
      style={{
        background: "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
        borderBottomColor: "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
        color: "color-mix(in oklch, var(--accent-amber) 50%, var(--foreground))",
      }}
    >
      <span>
        Backlog: <strong className="text-foreground">{count}</strong> uncategorized —{" "}
        <span className="[font-variant-numeric:tabular-nums]">
          {formatCents(totalCents)}
        </span>
      </span>
      <Link
        href="/categorize"
        className={`inline-flex min-h-11 items-center px-1 font-medium underline-offset-4 hover:underline ${FOCUS_RING}`}
      >
        Bulk →
      </Link>
    </div>
  );
}

/**
 * T26/E9 — the "show transfers" switch lives BESIDE THE RESULT SUMMARY, not
 * inside the filter slab.
 *
 * The filter card already holds eight controls, and this is not a filter: it
 * does not narrow the result set, it changes which class of row the set is
 * allowed to contain. It is also a plain link rather than a checkbox in a
 * second GET form — one form per page keeps `filterValuesToSearchParams` the
 * single place the URL is built, which is what stops page 2 from silently
 * dropping the toggle.
 */
function ResultSummary({
  totalCount,
  searchParams,
}: {
  totalCount: number;
  searchParams: TransactionsFilterValues;
}) {
  const on = searchParams.includeTransfers === true;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-ink-2">
      <span>
        {totalCount} transaction{totalCount === 1 ? "" : "s"}
      </span>
      <Link
        /* No `page` — omitting it resets to page 1, which is what any change
           to the visible result set should do. */
        href={buildHref({ ...searchParams, includeTransfers: !on })}
        /* `aria-pressed` is only valid on role=button. On a link assistive
           tech drops it (and axe flags it), so the state it was added to
           announce was never announced — the link text carries it instead,
           flipping between "Show transfers" and "Hide transfers".
           `min-h-11` brings the target to the 44px floor the rest of this
           branch's controls use; a bare text-xs link was ~16px tall. */
        className={`inline-flex min-h-11 items-center px-1 font-medium underline-offset-4 hover:underline ${FOCUS_RING}`}
      >
        {on ? "Hide transfers" : "Show transfers"}
      </Link>
    </div>
  );
}

/**
 * T10/D18 — the zero-result state, on the shared `StateCard` shell rather
 * than the flat bordered sentence that predated it.
 *
 * The merchant case is why this needed designing rather than inheriting. It
 * is reachable and it is not the user's fault: `db:backfill-merchants`
 * rewrites `normalized_merchant` when the normalizer changes (rule 10), so a
 * bookmarked drilldown can stop matching anything at all — and a hand-typed
 * `?merchant=amazon` never matches, because the filter is exact against an
 * upper-cased key. Both land here. Naming the key verbatim and offering the
 * `?search=` fallback turns rule 10's unfixable coupling into one click:
 * `search` is `LIKE %x%` and case-insensitive, so it finds the rows the exact
 * key no longer does.
 */
function EmptyState({
  totalCount,
  searchParams,
}: {
  totalCount: number;
  searchParams: TransactionsFilterValues;
}) {
  const actionClass = `inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted ${FOCUS_RING}`;

  if (totalCount !== 0) {
    return (
      <StateCard
        variant="empty"
        title="This page is empty."
        description="There are rows in this filter, just not this far in."
        primaryAction={
          <Link href={buildHref(searchParams)} className={actionClass}>
            Back to page 1
          </Link>
        }
      />
    );
  }

  const { merchant } = searchParams;
  if (merchant !== undefined) {
    /**
     * The diagnosis below ("that exact key matches nothing") is only true when
     * merchant is the ONLY thing narrowing the list. `buildPredicates` ANDs it
     * with eight other filters, so `totalCount === 0` on its own says nothing
     * about whether the key matches: arrive from `/categorize` on
     * `?merchant=AMAZON`, then set a date range with no AMAZON rows in it —
     * two clicks — and this card would assert a false fact about the ledger
     * and blame a rule-10 backfill for it.
     *
     * The recovery links have the same problem in a worse place. Both are
     * built by dropping `merchant` and keeping everything else, so when
     * another filter is what emptied the list, the `?search=` escape hatch —
     * which CLAUDE.md rule 10 names as THE mitigation for the one-way
     * `?merchant=` coupling — lands on another empty page. The user is told
     * the link is stale, clicks the fix, and nothing changes.
     *
     * So: clear every other filter as part of the recovery, and only claim
     * the key is at fault when there is nothing else it could be.
     */
    const otherFiltersActive = hasNonMerchantFilters(searchParams);
    return (
      <StateCard
        variant="empty"
        title={`No transactions for “${merchant}”.`}
        description={
          otherFiltersActive
            ? "No rows match this merchant AND the other active filters. The merchant key itself may still be fine — clearing the rest is the quickest way to tell."
            : "That exact merchant key matches nothing. A merchant backfill can rewrite these keys, so a saved link can go stale."
        }
        primaryAction={
          <Link
            href={buildHref({ ...searchParams, merchant: undefined })}
            className={actionClass}
          >
            Remove the merchant filter
          </Link>
        }
        secondaryAction={
          <Link
            /* Every other filter dropped and the key truncated to the cap —
               the rationale for both, and the tests, live on the builder. */
            href={merchantSearchRecoveryHref(merchant, searchParams.pageSize)}
            className={`inline-flex min-h-11 items-center text-sm font-medium text-terracotta underline underline-offset-4 hover:no-underline ${FOCUS_RING}`}
          >
            Search for “{merchant}” instead →
          </Link>
        }
      />
    );
  }

  if (searchParams.includeTransfers) {
    return (
      <StateCard
        variant="empty"
        title="No transfers in this range."
        description="Transfer-paired rows only appear where both legs fall inside the filter."
      />
    );
  }

  return (
    <StateCard
      variant="empty"
      title="No transactions match this filter."
      primaryAction={
        <Link href="/transactions" className={actionClass}>
          Clear filters
        </Link>
      }
    />
  );
}

function Pagination({
  page,
  pageSize,
  totalPages,
  totalCount,
  searchParams,
}: {
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
  searchParams: Props["searchParams"];
}) {
  if (totalPages <= 1) return null;

  // `pageSize` rides along inside `filterValuesToSearchParams` now, so this
  // no longer re-derives the `!== 50` rule against a bare literal that had to
  // stay in step with three other copies of it.
  const baseParams = filterValuesToSearchParams(searchParams);

  const hrefFor = (p: number) => {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(p));
    return `/transactions?${params.toString()}`;
  };

  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(totalCount, page * pageSize);

  return (
    <nav className="flex items-center justify-between text-sm text-ink-2">
      <span>
        {firstRow}–{lastRow} of {totalCount}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={hrefFor(page - 1)}
            className={`inline-flex min-h-11 items-center rounded-md border border-border px-3 hover:bg-muted ${FOCUS_RING}`}
          >
            ← Prev
          </Link>
        ) : (
          <span className="inline-flex min-h-11 items-center rounded-md border border-border px-3 opacity-50">
            ← Prev
          </span>
        )}
        <span className="px-2">
          Page {page} / {totalPages}
        </span>
        {page < totalPages ? (
          <Link
            href={hrefFor(page + 1)}
            className={`inline-flex min-h-11 items-center rounded-md border border-border px-3 hover:bg-muted ${FOCUS_RING}`}
          >
            Next →
          </Link>
        ) : (
          <span className="inline-flex min-h-11 items-center rounded-md border border-border px-3 opacity-50">
            Next →
          </span>
        )}
      </div>
    </nav>
  );
}
