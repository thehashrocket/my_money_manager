import { formatCents, moneyToneClass } from "@/lib/money";
import type { AccountClass } from "@/lib/accounts/accountClass";

/**
 * The recessed subtotal row that closes an ASSETS or LIABILITIES list —
 * DS51's `Cash` and `Debt`.
 *
 * Shared between the dashboard and `/accounts` because they render the same
 * concept, and because a second copy of it is precisely the failure D8 and D9
 * were raised to delete in this same PR: two identical components one Tailwind
 * edit away from disagreeing about what a subtotal looks like.
 *
 * No date, no action, and a recessed surface — the approved mockup rendered
 * `Cash`/`Debt` as clickable-looking account rows, and that correction is one
 * of the ones that overrides the image.
 */
export function SubtotalRow({
  label,
  cents,
  context,
  note,
  className,
}: {
  label: string;
  cents: number;
  context: AccountClass;
  /** e.g. DS58's "paid down $500.00 this month". Omitted at $0. */
  note?: React.ReactNode;
  className?: string;
}) {
  return (
    <li className={`bg-[var(--bg-inset)] px-4 py-3 ${className ?? ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="font-mono text-xs uppercase tracking-wide text-ink-2">{label}</span>
        <span
          className={`font-mono text-lg [font-variant-numeric:tabular-nums] ${moneyToneClass(cents, { context })}`}
          /* DS66 — accounting parens are silent to a screen reader. */
          aria-label={context === "liability" ? `owed ${formatCents(Math.abs(cents))}` : undefined}
        >
          {formatCents(cents)}
        </span>
      </div>
      {note ? <div className="mt-1">{note}</div> : null}
    </li>
  );
}
