import type { LeafRow } from "./loadMonthView";
import type { MonthPhase } from "./monthOfIso";
import { resolveRowDisplay, type ExpenseRowDisplay } from "./resolveRowDisplay";

export type ProximityRow = {
  categoryId: number;
  name: string;
  effectiveCents: number;
  spentCents: number;
  display: ExpenseRowDisplay;
};

/**
 * DS53 — rank leaf envelopes by how close they are to blowing, for the
 * dashboard's "Closest to limit" section.
 *
 * THE OBVIOUS SORT IS WRONG, and this function exists because of it. The plan
 * originally said "top N envelopes by `barPct`", but `resolveRowDisplay` caps
 * `barPct` at 100 AND flattens zero-allocation overspend to exactly 100:
 *
 *     const raw = effective > 0 ? (spent / effective) * 100
 *               : spent > 0 ? 100 : 0;
 *     const barPct = Math.min(100, Math.max(0, raw));
 *
 * So an envelope at 100.0%, one at 400%, and one with no budget at all and
 * $600 spent all sort identically — the section would have been ranked by
 * nothing. Codex caught this against the design review's own proposal.
 *
 * Severity instead, all four keys readable off `RowDisplay` with no new query:
 *
 *   1. rows carrying an `overflow` badge first, descending by its amount
 *      (the badge is the only place the TRUE overage survives the cap)
 *   2. then `barPct` descending
 *   3. then the absolute headroom left, ascending
 *   4. then name, so the order is stable across renders
 *
 * A leaf with neither an allocation nor any spend is dropped entirely: it is
 * not "close to its limit", it is simply unused, and listing it would push a
 * real one off the end of a 5-row section.
 */
export function rankByProximity(
  leaves: readonly LeafRow[],
  phase: MonthPhase,
  limit: number,
): ProximityRow[] {
  const rows: ProximityRow[] = [];

  for (const leaf of leaves) {
    const effectiveCents = leaf.allocation?.effectiveCents ?? 0;
    if (effectiveCents === 0 && leaf.spentCents === 0) continue;

    rows.push({
      categoryId: leaf.categoryId,
      name: leaf.name,
      effectiveCents,
      spentCents: leaf.spentCents,
      display: resolveRowDisplay(
        {
          effectiveCents,
          spentCents: leaf.spentCents,
          pendingCents: leaf.pendingCents,
          hasAllocation: leaf.allocation !== null,
        },
        "expense",
        phase,
      ),
    });
  }

  rows.sort((a, b) => {
    const aOver = overflowCents(a);
    const bOver = overflowCents(b);
    if (aOver !== bOver) return bOver - aOver;
    if (a.display.barPct !== b.display.barPct) return b.display.barPct - a.display.barPct;
    const aHeadroom = a.effectiveCents - a.spentCents;
    const bHeadroom = b.effectiveCents - b.spentCents;
    if (aHeadroom !== bHeadroom) return aHeadroom - bHeadroom;
    return a.name.localeCompare(b.name);
  });

  return rows.slice(0, limit);
}

/** The true overage, which `barPct`'s cap destroys. 0 when not overspent. */
function overflowCents(row: ProximityRow): number {
  const badge = row.display.badges.find((x) => x.type === "overflow");
  return badge?.amountCents ?? 0;
}
