/**
 * The one focus treatment for interactive elements outside `components/ui`.
 *
 * DESIGN.md gives the accent but not the ring; the shadcn primitives carry
 * their own `focus-visible:ring-*`, so this exists for the app's hand-rolled
 * controls — links, `<summary>` disclosures, and buttons written inline. It is
 * a shared constant rather than a per-file one for the same reason
 * `ROW_GRID`/`TXN_ROW_GRID` are: six copies of a token string across five
 * files is six chances for one of them to drift, and a focus ring that is
 * subtly different on one control out of six is worse than no system at all.
 *
 * `outline`, not `ring`: an outline follows `outline-offset` and is drawn
 * outside the border box without participating in `rounded-*` seams, so it
 * stays a clean rectangle around a control sitting flush inside a ruled row.
 * It is NOT immune to an ancestor's `overflow-hidden` — that clips an outline
 * exactly as it clips a `ring`'s box-shadow — so the choice buys geometry,
 * not clipping.
 */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-terracotta)]";
