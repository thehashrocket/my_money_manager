import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";

export type SummaryStripTone = "pos" | "neg" | "zero";

export type SummaryStripCell = {
  label: string;
  cents: number;
  /** Money semantic tone (e.g. a "Remaining" cell) — unset renders neutral. */
  tone?: SummaryStripTone;
};

const TONE_CLASS: Record<SummaryStripTone, string> = {
  pos: "text-money-pos",
  neg: "text-money-neg",
  zero: "text-money-zero",
};

/**
 * T13/DS10: `cells[]` contract shared by `/budget/[year]/[month]` and the
 * dashboard — both render the same figures through one component instead of
 * two copy-pasted grids (`DESIGN.md:144` used to say not to do this; the
 * doc's own two-use threshold is now exceeded).
 *
 * DS45 — `variant="ledger" | "plain"` exists so extracting this component
 * does not also half-restyle the dashboard, which nobody has reviewed a
 * redesign for. `"ledger"` is DS39's one ruled `--bg-raised` strip with
 * `--rule-faint` dividers (no per-cell border/radius). `"plain"` is the
 * dashboard's pre-existing five-bordered-boxes look, preserved byte-for-byte
 * on purpose — this is debt with a name on it (DS45); delete `"plain"` when
 * the dashboard's own restyle lands, at which point every caller is
 * `"ledger"` and the variant prop itself can go.
 */
export function SummaryStrip({
  cells,
  variant,
}: {
  cells: SummaryStripCell[];
  variant: "ledger" | "plain";
}) {
  if (variant === "plain") {
    return (
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.label} className="rounded-md border border-border bg-card px-3 py-2">
            <div className="text-xs text-muted-foreground">{cell.label}</div>
            <div className={cn("font-medium", cell.tone && TONE_CLASS[cell.tone])}>
              {formatCents(cell.cents)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg bg-[var(--bg-raised)] shadow-soft lg:grid-cols-5 lg:divide-x lg:divide-y-0">
      {cells.map((cell) => (
        <div key={cell.label} className="px-4 py-3">
          <div className="font-mono text-xs uppercase tracking-wide text-ink-2">{cell.label}</div>
          <div
            className={cn(
              "font-mono text-lg font-medium [font-variant-numeric:tabular-nums]",
              cell.tone ? TONE_CLASS[cell.tone] : "text-ink-1",
            )}
          >
            {formatCents(cell.cents)}
          </div>
        </div>
      ))}
    </div>
  );
}
