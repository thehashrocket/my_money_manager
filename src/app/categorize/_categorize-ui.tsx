"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { MerchantGroup } from "@/lib/categorize/loadMerchantGroups";
import type { LeafCategory } from "@/lib/categories";
import type { UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { formatCents } from "@/lib/money";
import { StateCard } from "@/components/ledger/state-card";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import { MerchantRow, ROW_GRID } from "./_merchant-row";
import { prunePendingPicks } from "./_pending-pick";
import { cn } from "@/lib/utils";

type Props = {
  initialGroups: MerchantGroup[];
  leafCategories: LeafCategory[];
  initialBacklog: UncategorizedBacklog;
};

/**
 * Client island wrapper for `/categorize`. Owns two pieces of local state:
 *
 * - A live backlog counter that decrements optimistically on submit and
 *   increments back on Undo. Matches the server-rendered count on first paint;
 *   diverges while a 10s Undo window is open, then re-syncs on page reload or
 *   on a Next revalidation round-trip.
 * - The set of merchants finished this sitting. Rows self-dismissed from their
 *   own state before, which meant the page could not say how far through the
 *   list you were — `groups.length` was computed here and never rendered
 *   (T15). Lifting it makes the progress counter possible and keeps "which
 *   rows are gone" in one place.
 * - Nothing else: the per-row pending pick lives in `sessionStorage`, because
 *   it has to outlive this component (D19).
 *
 * `aria-live="polite"` on the counter mirrors the Sonner toast for screen
 * readers (Pass 6 accessibility decision).
 */
export function CategorizeUi({
  initialGroups,
  leafCategories,
  initialBacklog,
}: Props) {
  const [count, setCount] = useState(initialBacklog.count);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  const groups = useMemo(
    () => initialGroups.filter((g) => !dismissed.has(g.normalizedMerchant)),
    [initialGroups, dismissed],
  );

  // A pick parked for a merchant this page no longer lists is finished
  // business — see `prunePendingPicks`.
  useEffect(() => {
    prunePendingPicks(initialGroups.map((g) => g.normalizedMerchant));
  }, [initialGroups]);

  const onDismissedChange = (merchant: string, isDismissed: boolean) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      if (isDismissed) next.add(merchant);
      else next.delete(merchant);
      return next;
    });
  };

  if (initialGroups.length === 0) {
    return <AllCaughtUp />;
  }

  return (
    <div className="space-y-4">
      <BacklogHeader
        count={count}
        totalCents={initialBacklog.totalCents}
        doneMerchants={dismissed.size}
        /* Derived from what is LEFT plus what is done, never from
           `initialGroups.length`. Both actions call `revalidatePath`, so the
           server list drops a merchant the moment it is categorized — reading
           the denominator off it made the counter read "1 of 5" one submit
           after it read "0 of 6", as though the work had grown. This form
           holds steady across the revalidation and still grows if an import
           adds merchants mid-sitting. */
        totalMerchants={groups.length + dismissed.size}
      />
      {groups.length === 0 ? (
        <AllCaughtUp />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          <ColumnHeaders />
          {/* D17 [HARD REJECTION] — one ruled list, not 181 stacked card
              shells. Both outside voices triggered the same rejection on the
              old `rounded-md border p-3` inside `ul.space-y-2`, and DS49
              already made exactly this move on the dashboard, so this follows
              a reference implementation rather than inventing one. */}
          <ul className="divide-y divide-[var(--rule-faint)]">
            {groups.map((group) => (
              <li key={group.normalizedMerchant}>
                <MerchantRow
                  group={group}
                  leafCategories={leafCategories}
                  onOptimisticSubmit={(n) => setCount((c) => Math.max(0, c - n))}
                  onUndo={(n) => setCount((c) => c + n)}
                  onDismissedChange={onDismissedChange}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * D17 — a two-line row with no header leaves its second line unlabelled. All
 * four mockups added a header row unprompted, for that structural reason.
 * Hidden below `sm`, where the row stacks and the labels would outnumber the
 * data.
 */
function ColumnHeaders() {
  return (
    <div
      aria-hidden
      /* `cn()`, not a template string: the grid constant already carries
         `py-3`, and Tailwind resolves a `py-3`/`py-2` collision by
         stylesheet order rather than by class-string order — so the
         header's own `py-2` was dead and it rendered at full row height.
         tailwind-merge makes the later class win, which is what the
         shared-template pattern assumed all along. */
      className={cn(
        ROW_GRID,
        "hidden border-b border-[var(--rule-strong)] bg-[var(--bg-inset)] py-2 font-mono text-[10px] uppercase tracking-wide text-ink-3 sm:grid",
      )}
    >
      <span>Merchant</span>
      <span className="text-right">Rows</span>
      <span className="text-right">Total</span>
    </div>
  );
}

/**
 * T14/D21 — the Ledger Paper amber token via the shared `color-mix` formula
 * (`BacklogBanner`, the dashboard tile and the Spine chip all use it), not
 * Tailwind's raw `amber-*` palette. DESIGN.md's own audit table named this
 * strip as one of three surfaces that had drifted off the token entirely, so
 * a future change to `--accent-amber` would have moved everything except the
 * two places the backlog is most visible.
 *
 * `-mx-5` must stay equal to the page's `p-5` gutter, or the strip stops
 * reaching the viewport edges it is bled to.
 */
function BacklogHeader({
  count,
  totalCents,
  doneMerchants,
  totalMerchants,
}: {
  count: number;
  totalCents: number;
  doneMerchants: number;
  totalMerchants: number;
}) {
  return (
    <div
      aria-live="polite"
      className="sticky top-0 z-10 -mx-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-5 py-2 text-sm backdrop-blur"
      style={{
        background: "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
        borderBottomColor: "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
        color: "color-mix(in oklch, var(--accent-amber) 50%, var(--foreground))",
      }}
    >
      <span>
        Backlog: <strong className="text-foreground">{count}</strong> transaction
        {count === 1 ? "" : "s"} —{" "}
        <span className="[font-variant-numeric:tabular-nums]">
          {formatCents(totalCents)}
        </span>
      </span>
      {/* T15 — the progress counter. It counts MERCHANTS, not transactions:
          the list you are working through is one row per merchant, so "12 of
          181" is the only figure that predicts how much is left to do. The
          backlog figure beside it moves in transactions and can drop by 53 for
          one decision. */}
      <span className="font-mono text-xs">
        {doneMerchants} of {totalMerchants} merchant
        {totalMerchants === 1 ? "" : "s"} done
      </span>
    </div>
  );
}

function AllCaughtUp() {
  return (
    <StateCard
      variant="success"
      title="All caught up."
      description="No uncategorized transactions left."
      primaryAction={
        <Link
          href="/budget"
          className={`inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80 ${FOCUS_RING}`}
        >
          Go to Budget
        </Link>
      }
    />
  );
}
