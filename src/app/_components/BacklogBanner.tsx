import Link from "next/link";
import { formatCents } from "@/lib/money";
import type { UncategorizedBacklog } from "@/lib/budget/loadMonthView";

type Variant = "budget" | "categorize";

/**
 * Sticky amber banner showing the uncategorized backlog + CTA.
 *
 * Uses the Ledger Paper amber token rather than Tailwind's amber-* palette
 * so light/dark modes pick up the same adjustment the rest of the system
 * uses.
 *
 * Two variants share the same visual treatment:
 *  - "budget"     renders the CTA link → `/categorize`.
 *  - "categorize" omits the CTA (we're already there) and leaves room for
 *    the caller's live counter.
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
    <div
      className="sticky top-0 z-10 -mx-6 flex items-center justify-between gap-3 border-b px-6 py-2 text-sm backdrop-blur"
      style={{
        background:
          "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
        borderBottomColor:
          "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
        color: "color-mix(in oklch, var(--accent-amber) 50%, var(--foreground))",
      }}
    >
      <span>
        <strong className="text-foreground">{backlog.count}</strong>{" "}
        uncategorized transaction{plural} — {formatCents(backlog.totalCents)}
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
