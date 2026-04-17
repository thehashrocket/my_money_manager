"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MerchantGroup } from "@/lib/categorize/loadMerchantGroups";
import type { LeafCategory } from "@/lib/categories";
import type { UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { formatCents } from "@/lib/money";
import { MerchantRow } from "./_merchant-row";

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
 * - A render list of merchant groups; rows self-dismiss after success but
 *   reappear if the user clicks Undo.
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

  const groups = useMemo(() => initialGroups, [initialGroups]);

  if (groups.length === 0) {
    return <AllCaughtUp />;
  }

  return (
    <div className="space-y-4">
      <BacklogHeader count={count} totalCents={initialBacklog.totalCents} />
      <ul className="space-y-2">
        {groups.map((group) => (
          <li key={group.normalizedMerchant}>
            <MerchantRow
              group={group}
              leafCategories={leafCategories}
              onOptimisticSubmit={(n) => setCount((c) => Math.max(0, c - n))}
              onUndo={(n) => setCount((c) => c + n)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function BacklogHeader({
  count,
  totalCents,
}: {
  count: number;
  totalCents: number;
}) {
  return (
    <div
      aria-live="polite"
      className="sticky top-0 z-10 -mx-6 flex items-center justify-between gap-3 border-b border-amber-400/50 bg-amber-100/90 px-6 py-2 text-sm text-amber-900 backdrop-blur dark:bg-amber-950/80 dark:text-amber-100"
    >
      <span>
        Backlog: <strong>{count}</strong> transaction{count === 1 ? "" : "s"} —{" "}
        <span className="[font-variant-numeric:tabular-nums]">
          {formatCents(totalCents)}
        </span>
      </span>
    </div>
  );
}

function AllCaughtUp() {
  return (
    <div className="rounded-md border border-border bg-card px-6 py-12 text-center">
      <div className="text-3xl">✓</div>
      <h2 className="mt-2 text-lg font-semibold">All caught up.</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        No uncategorized transactions left.
      </p>
      <Link
        href="/budget"
        className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80"
      >
        Go to Budget
      </Link>
    </div>
  );
}
