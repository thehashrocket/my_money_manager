import Link from "next/link";
import { formatCents } from "@/lib/money";
import type { UncategorizedBacklog } from "@/lib/budget/loadMonthView";

type Variant = "budget" | "categorize";

/**
 * Sticky amber banner showing the uncategorized backlog + CTA.
 *
 * Two variants share the same visual treatment:
 * - "budget" renders the CTA link → `/categorize`.
 * - "categorize" omits the CTA (we're already on that page) and leaves room
 *   for a live client-side counter rendered by the caller.
 *
 * Negative-cents display uses the global parens rule via `formatCents`.
 */
export function BacklogBanner({
  backlog,
  variant,
}: {
  backlog: UncategorizedBacklog;
  variant: Variant;
}) {
  const plural = backlog.count === 1 ? "" : "s";
  return (
    <div className="sticky top-0 z-10 -mx-6 flex items-center justify-between gap-3 border-b border-amber-400/50 bg-amber-100/90 px-6 py-2 text-sm text-amber-900 backdrop-blur dark:bg-amber-950/80 dark:text-amber-100">
      <span className="[font-variant-numeric:tabular-nums]">
        <strong>{backlog.count}</strong> uncategorized transaction{plural} —{" "}
        {formatCents(backlog.totalCents)}
      </span>
      {variant === "budget" ? (
        <Link
          href="/categorize"
          className="font-medium underline-offset-4 hover:underline"
        >
          Categorize backlog →
        </Link>
      ) : null}
    </div>
  );
}
