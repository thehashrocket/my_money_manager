import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/money";

/**
 * Envelope card — signature Ledger Paper component.
 *
 * Shape rules (per design handoff):
 *  - Display font on the category name, mono on everything else.
 *  - 6px progress bar. Fill is ledger-green by default, amber when ≥80% but
 *    not yet over, redbrown when overspent.
 *  - Folded-flap corner rendered via the `.envelope` CSS class in
 *    `globals.css` (pseudo-element is too fiddly to express as utilities).
 *
 * Consumers pass raw cents so this component owns the pct math + formatting.
 * `title` is the slot a link/button can wrap; callers that want row-click
 * navigation should wrap the whole card instead of the title alone.
 */
type EnvelopeState = "default" | "warn" | "over";

export type EnvelopeCardProps = {
  name: string;
  effectiveCents: number;
  spentCents: number;
  /** Optional slot rendered in the top-right (e.g., a mono % if caller wants a custom value). */
  rightMeta?: React.ReactNode;
  /** Optional footer row (e.g., "Allocate" CTA). */
  footer?: React.ReactNode;
  /** Optional small badge row (e.g., "Rollover" tag). */
  badges?: React.ReactNode;
  /** Render the title through a custom wrapper (e.g., next/link). */
  titleAs?: (node: React.ReactNode) => React.ReactNode;
  className?: string;
};

function resolveState(
  effectiveCents: number,
  spentCents: number,
): { pct: number; state: EnvelopeState } {
  if (effectiveCents > 0) {
    const raw = (spentCents / effectiveCents) * 100;
    const pct = Math.min(100, Math.max(0, raw));
    const state: EnvelopeState =
      raw > 100 ? "over" : raw >= 80 ? "warn" : "default";
    return { pct, state };
  }
  // No allocation: anything spent is overspend.
  return { pct: spentCents > 0 ? 100 : 0, state: spentCents > 0 ? "over" : "default" };
}

const FILL_COLORS: Record<EnvelopeState, string> = {
  default: "bg-[var(--accent-ledger)]",
  warn: "bg-[var(--accent-amber)]",
  over: "bg-[var(--accent-redbrown)]",
};

export function EnvelopeCard({
  name,
  effectiveCents,
  spentCents,
  rightMeta,
  footer,
  badges,
  titleAs,
  className,
}: EnvelopeCardProps) {
  const { pct, state } = resolveState(effectiveCents, spentCents);
  const remaining = effectiveCents - spentCents;

  const titleNode = (
    <span className="font-display text-[var(--text-md)] leading-tight">
      {name}
    </span>
  );

  const pctLabel = effectiveCents > 0 ? `${Math.round(pct)}%` : "—";

  return (
    <div className={cn("envelope", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          {titleAs ? titleAs(titleNode) : titleNode}
          {badges}
        </div>
        <span className="font-mono text-[var(--text-xs)] text-muted-foreground shrink-0">
          {rightMeta ?? pctLabel}
        </span>
      </div>

      <div
        className="relative mt-[10px] h-[6px] overflow-hidden rounded-full bg-[var(--bg-inset)]"
        aria-hidden
      >
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", FILL_COLORS[state])}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-[10px] flex items-baseline justify-between font-mono text-[var(--text-sm)] text-muted-foreground">
        <span>
          <span className="text-foreground font-medium">
            {formatCents(spentCents)}
          </span>{" "}
          / {formatCents(effectiveCents)}
        </span>
        <span
          className={
            state === "over"
              ? "text-[var(--money-neg)]"
              : remaining === 0
                ? "text-[var(--money-zero)]"
                : "text-[var(--money-pos)]"
          }
        >
          {formatCents(remaining)}
        </span>
      </div>

      {footer ? <div className="mt-[12px]">{footer}</div> : null}
    </div>
  );
}
