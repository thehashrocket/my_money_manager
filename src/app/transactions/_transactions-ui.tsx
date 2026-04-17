"use client";

import Link from "next/link";
import { useState } from "react";
import type { LeafCategory } from "@/lib/categories";
import type { TransactionRow } from "@/lib/categorize/loadTransactions";
import type { UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { formatCents } from "@/lib/money";
import { TransactionRowForm } from "./_transaction-row";

type Props = {
  rows: TransactionRow[];
  leafCategories: LeafCategory[];
  initialBacklog: UncategorizedBacklog;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  searchParams: {
    categoryId: number | "none" | undefined;
    year: number | undefined;
    month: number | undefined;
  };
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
}: Props) {
  const [backlogCount, setBacklogCount] = useState(initialBacklog.count);

  if (rows.length === 0) {
    return <EmptyState totalCount={totalCount} />;
  }

  return (
    <div className="space-y-4">
      <BacklogStrip count={backlogCount} totalCents={initialBacklog.totalCents} />
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <TransactionRowForm
              row={row}
              leafCategories={leafCategories}
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
          </li>
        ))}
      </ul>
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

function EmptyState({ totalCount }: { totalCount: number }) {
  return (
    <div className="rounded-md border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
      {totalCount === 0
        ? "No transactions match this filter."
        : "This page is empty — try a lower page number."}
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

  const baseParams = new URLSearchParams();
  if (searchParams.categoryId !== undefined) {
    baseParams.set("categoryId", String(searchParams.categoryId));
  }
  if (searchParams.year !== undefined) {
    baseParams.set("year", String(searchParams.year));
  }
  if (searchParams.month !== undefined) {
    baseParams.set("month", String(searchParams.month));
  }
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
