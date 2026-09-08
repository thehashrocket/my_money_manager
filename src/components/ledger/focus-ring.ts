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
 * `outline`, not `ring`: it must not be clipped by the `overflow-hidden` on
 * the ruled row lists these controls sit inside.
 */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-terracotta)]";
