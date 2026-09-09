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

/** Written out so Tailwind's source scan can see each class literally. */
const LG_COLUMNS = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
} as const;

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
    /* The column count FOLLOWS `cells.length`; it was hardcoded `lg:grid-cols-5`
       while `/budget` emitted a 6th cell ("Planned funding") whenever a fund
       exists, which orphaned the last cell — `Remaining`, the toned one the
       page exists for — alone on a second row at 1/5 width. `lg:divide-y-0`
       also cancels the horizontal rule at that breakpoint, so the wrapped cell
       had no separator above it either. Invisible below `lg`, where
       `grid-cols-2` tiles 6 cells evenly, so it would not show up in a
       phone-width check.

       An explicit map, not an interpolated `lg:grid-cols-${n}`: Tailwind scans
       source text for whole class names, so a computed one is never emitted. */
    <div
      className={cn(
        "grid grid-cols-2 divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg bg-[var(--bg-raised)] shadow-soft lg:divide-x lg:divide-y-0",
        LG_COLUMNS[Math.min(cells.length, 6) as keyof typeof LG_COLUMNS] ??
          "lg:grid-cols-5",
      )}
    >
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
