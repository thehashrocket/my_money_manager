"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { LeafCategory } from "@/lib/categories";
import type { TransactionRow } from "@/lib/categorize/loadTransactions";
import type { UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { formatCents } from "@/lib/money";
import type { AccountOption } from "@/lib/accounts/listAccounts";
import { buildHref, filterValuesToSearchParams, type TransactionsFilterValues } from "./_filter-bar";
import { TransactionRowForm, TransferRowItem } from "./_transaction-row";

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
        <EmptyState totalCount={totalCount} includeTransfers={searchParams.includeTransfers} />
      ) : (
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            {row.transferPairId !== null ? (
              <TransferRowItem
                row={row}
                cardAccounts={cardAccounts}
                onPairingChanged={onPairingChanged}
              />
            ) : (
              <TransactionRowForm
                row={row}
                leafCategories={leafCategories}
                cardAccounts={cardAccounts}
                onPairingChanged={onPairingChanged}
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
      className="sticky top-0 z-10 -mx-6 flex items-center justify-between gap-3 border-b border-amber-400/50 bg-amber-100/90 px-6 py-2 text-sm text-amber-900 backdrop-blur dark:bg-amber-950/80 dark:text-amber-100"
    >
      <span>
        Backlog: <strong>{count}</strong> uncategorized —{" "}
        <span className="[font-variant-numeric:tabular-nums]">
          {formatCents(totalCents)}
        </span>
      </span>
      <Link
        href="/categorize"
        className="font-medium underline-offset-4 hover:underline"
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
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {totalCount} transaction{totalCount === 1 ? "" : "s"}
      </span>
      <Link
        /* No `page` — omitting it resets to page 1, which is what any change
           to the visible result set should do. */
        href={buildHref({ ...searchParams, includeTransfers: !on })}
        className="font-medium underline-offset-4 hover:underline"
        aria-pressed={on}
      >
        {on ? "Hide transfers" : "Show transfers"}
      </Link>
    </div>
  );
}

function EmptyState({
  totalCount,
  includeTransfers,
}: {
  totalCount: number;
  includeTransfers?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
      {totalCount !== 0
        ? "This page is empty — try a lower page number."
        : includeTransfers
          ? "No transfers in this range."
          : "No transactions match this filter."}
    </div>
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

  const baseParams = filterValuesToSearchParams(searchParams);
  if (pageSize !== 50) baseParams.set("pageSize", String(pageSize));

  const hrefFor = (p: number) => {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(p));
    return `/transactions?${params.toString()}`;
  };

  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(totalCount, page * pageSize);

  return (
    <nav className="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {firstRow}–{lastRow} of {totalCount}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={hrefFor(page - 1)}
            className="rounded-md border border-border px-3 py-1 hover:bg-muted"
          >
            ← Prev
          </Link>
        ) : (
          <span className="rounded-md border border-border px-3 py-1 opacity-50">
            ← Prev
          </span>
        )}
        <span className="px-2">
          Page {page} / {totalPages}
        </span>
        {page < totalPages ? (
          <Link
            href={hrefFor(page + 1)}
            className="rounded-md border border-border px-3 py-1 hover:bg-muted"
          >
            Next →
          </Link>
        ) : (
          <span className="rounded-md border border-border px-3 py-1 opacity-50">
            Next →
          </span>
        )}
      </div>
    </nav>
  );
}
