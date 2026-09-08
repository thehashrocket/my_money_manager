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
 * - TWO sets of merchant keys, not one, because "hide this row" and "count this
 *   as done" have different lifetimes and one set could not honour both.
 *   `done` is what the progress counter is BUILT from and survives the whole
 *   sitting — not the numerator itself, which is `done` minus anything the
 *   server still lists (see the note at `doneMerchants` below; a merchant that
 *   comes back is in both sets at once). `hidden` only bridges the gap between
 *   a submit and the
 *   revalidation that drops the row server-side, so it is CLEARED on every new
 *   server payload — the list the server just sent is authoritative about what
 *   is left. Sharing one set meant a merchant that came back (an import mid
 *   sitting, an undo from another tab, a re-categorization) stayed invisible
 *   for the rest of the session with no way to reach it, since the only
 *   removal path was that row's own Undo and the row was already unmounted.
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
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  // Adjust-state-during-render, not an effect: clearing `hidden` in a
  // `useEffect` would paint one frame with the previous payload's hidden set
  // applied to the new list, which is a visible flicker on exactly the rows
  // this fix exists to bring back.
  const [renderedGroups, setRenderedGroups] = useState(initialGroups);
  if (renderedGroups !== initialGroups) {
    setRenderedGroups(initialGroups);
    setHidden(new Set());
  }

  const groups = useMemo(
    () => initialGroups.filter((g) => !hidden.has(g.normalizedMerchant)),
    [initialGroups, hidden],
  );

  // A pick parked for a merchant this page no longer lists is finished
  // business — see `prunePendingPicks`.
  useEffect(() => {
    prunePendingPicks(initialGroups.map((g) => g.normalizedMerchant));
  }, [initialGroups]);

  const onDismissedChange = (merchant: string, isDismissed: boolean) => {
    const apply = (prev: ReadonlySet<string>) => {
      const next = new Set(prev);
      if (isDismissed) next.add(merchant);
      else next.delete(merchant);
      return next;
    };
    setDone(apply);
    setHidden(apply);
  };

  if (initialGroups.length === 0) {
    return <AllCaughtUp />;
  }

  return (
    <div className="space-y-4">
      <BacklogHeader
        count={count}
        totalCents={initialBacklog.totalCents}
        /* NOT `done.size`. `done` is monotonic and `hidden` is cleared on
           each server payload, so a merchant that comes back is listed again
           while still sitting in `done` — and the numerator would count it as
           finished with its own uncategorized row rendered directly beneath
           the counter saying so. Both halves of the fraction have to answer
           the returning-merchant case the same way, or the fix that made the
           denominator honest leaves the numerator lying. */
        doneMerchants={
          [...done].filter(
            (m) => !groups.some((g) => g.normalizedMerchant === m),
          ).length
        }
        /* Derived from what is LEFT plus what is done, never from
           `initialGroups.length`. Both actions call `revalidatePath`, so the
           server list drops a merchant the moment it is categorized — reading
           the denominator off it made the counter read "1 of 5" one submit
           after it read "0 of 6", overstating progress: the denominator shrank
           with the numerator, so one submit moved it two steps instead of one.
           This form holds steady across the revalidation and still grows if an
           import adds merchants mid-sitting.

           A UNION, not `groups.length + done.size`: now that `hidden` is
           cleared on each payload, a merchant that comes back is in both sets
           at once, and adding the sizes would count it twice and inflate the
           denominator past the work that actually exists. */
        totalMerchants={
          new Set([...groups.map((g) => g.normalizedMerchant), ...done]).size
        }
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
