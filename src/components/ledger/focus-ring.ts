/**
 * The one focus treatment for interactive elements outside `components/ui`.
 *
 * DESIGN.md gives the accent but not the ring; the shadcn primitives carry
 * their own `focus-visible:ring-*`, so this exists for the app's hand-rolled
 * controls — links, `<summary>` disclosures, and buttons written inline. It is
 * a shared constant rather than a per-file one for the same reason
 * `ROW_GRID`/`TXN_ROW_GRID` are: it is interpolated at 14 call sites across
 * five files, and a focus ring that is subtly different on one control out of
 * fourteen is worse than no system at all. (Count the `${FOCUS_RING}`
 * interpolations, not `grep -c FOCUS_RING` — the latter is 21, because it also
 * counts the five imports, this definition, and one prose mention.)
 *
 * `outline`, not `ring`: an outline is drawn outside the border box and does
 * not participate in layout, so it can be offset off the control without
 * displacing anything beside it in a dense ruled row — where a `ring`'s
 * box-shadow spread has to be budgeted against the row's own padding. It
 * follows `border-radius` like a `ring` does (CSS UI 4, and every browser
 * this app targets), so it is NOT a way to get a rectangle around a rounded
 * control: the six consumers that carry `rounded-md` or `rounded-[999px]` get
 * a rounded ring, and the eight bare links and `<summary>` elements get a
 * rectangular one, because that is the shape of their border box. Nor is it
 * immune to an ancestor's `overflow-hidden`: that clips an outline exactly as
 * it clips a box-shadow. The choice buys layout independence, not shape and
 * not clipping.
 */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-terracotta)]";
