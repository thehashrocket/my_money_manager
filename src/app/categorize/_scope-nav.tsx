import Link from "next/link";
import {
  monthLabel,
  nextMonthOf,
  previousMonth,
  type YearMonth,
} from "@/lib/budget/monthOfIso";
import { SCOPE_YEAR_MAX, SCOPE_YEAR_MIN } from "@/lib/categorize/scopeParams";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import { cn } from "@/lib/utils";

type Props = {
  /** `undefined` means "all time" — the page's original, and still default, behavior. */
  scope: YearMonth | undefined;
  thisMonth: YearMonth;
};

const LINK_CLASS = cn(
  "text-terracotta underline-offset-4 hover:underline",
  FOCUS_RING,
);

/**
 * `/categorize`'s month scope nav — mirrors `/budget`'s own `MonthNav`
 * (prev/label/next as plain `Link`s, no client JS) rather than inventing a
 * second pattern for the same idea. "All time" is not a third position on
 * the same axis as prev/next; it is a separate link that clears both params,
 * since there is no month before or after "all time" to arrow into.
 */
export function ScopeNav({ scope, thisMonth }: Props) {
  if (!scope) {
    return (
      <nav className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="text-ink-1">
          Showing: <strong>all time</strong>
        </span>
        <Link
          href={`/categorize?year=${thisMonth.year}&month=${thisMonth.month}`}
          className={LINK_CLASS}
        >
          Just {monthLabel(thisMonth.year, thisMonth.month)} →
        </Link>
      </nav>
    );
  }

  const prev = previousMonth(scope.year, scope.month);
  const next = nextMonthOf(scope.year, scope.month);
  const isCurrent = scope.year === thisMonth.year && scope.month === thisMonth.month;
  // Red Team review: `previousMonth`/`nextMonthOf` have no bound of their
  // own, but `scopeParams.ts`'s parser does — an unbounded arrow can walk
  // past it, and landing on that URL fails validation and silently falls
  // back to "all time" with no explanation. Rather than generate a link
  // this page's own parser would reject, the arrow is withheld at the
  // boundary — the same "don't offer a control that can only refuse"
  // discipline `canAddCharge`/`assignableKinds` already use elsewhere.
  const prevInBounds = prev.year >= SCOPE_YEAR_MIN;
  const nextInBounds = next.year <= SCOPE_YEAR_MAX;

  return (
    // flex-wrap + gap, not the bare `justify-between` `/budget` MonthNav uses:
    // this row's center label is longer ("Showing: <month> (this month) ·
    // all time" vs. a bare month name), so on a narrow viewport it wraps as
    // three legible chunks instead of each `<span>`/`<Link>` shrinking its
    // own text into a cramped multi-line block.
    <nav className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
      {prevInBounds ? (
        <Link href={`/categorize?year=${prev.year}&month=${prev.month}`} className={LINK_CLASS}>
          ← {monthLabel(prev.year, prev.month)}
        </Link>
      ) : (
        <span aria-hidden />
      )}
      <span className="text-ink-1">
        Showing: <strong>{monthLabel(scope.year, scope.month)}</strong>
        {isCurrent ? " (this month)" : ""}
        {" · "}
        <Link href="/categorize" className={LINK_CLASS}>
          all time
        </Link>
      </span>
      {nextInBounds ? (
        <Link href={`/categorize?year=${next.year}&month=${next.month}`} className={LINK_CLASS}>
          {monthLabel(next.year, next.month)} →
        </Link>
      ) : (
        <span aria-hidden />
      )}
    </nav>
  );
}
