/**
 * The one focus treatment for interactive elements outside `components/ui`.
 *
 * DESIGN.md gives the accent but not the ring; the shadcn primitives carry
 * their own `focus-visible:ring-*`, so this exists for the app's hand-rolled
 * controls — links, `<summary>` disclosures, and buttons written inline. It is
 * a shared constant rather than a per-file one for the same reason
 * `ROW_GRID`/`TXN_ROW_GRID` are: it is interpolated at 17 call sites across
 * six files, and a focus ring that is subtly different on one control out of
 * seventeen is worse than no system at all. (Count the `${FOCUS_RING}`
 * interpolations, not `grep -c FOCUS_RING` — the latter is 27, because it also
 * counts the six imports, this definition, and three prose lines: two in this
 * comment, plus the one in `page.tsx` marking the control that opts out.)
 *
 * `outline`, not `ring`: an outline is drawn outside the border box and does
 * not participate in layout, so it can be offset off the control without
 * displacing anything beside it in a dense ruled row — where a `ring`'s
 * box-shadow spread has to be budgeted against the row's own padding. It
 * follows `border-radius` like a `ring` does (CSS UI 4, and every browser
 * this app targets), so it is NOT a way to get a rectangle around a rounded
 * control: the 7 consumers that carry `rounded-md` get a rounded ring, and the
 * other 10 — bare links and `<summary>` elements with no radius at all — get a
 * rectangular one, because that is the shape of their border box. No consumer
 * carries `rounded-[999px]`: the one pill control that does, the merchant
 * chip's `×`, deliberately opts out for a paper-coloured ring. Nor is it
 * immune to an ancestor's `overflow-hidden`: that clips an outline exactly as
 * it clips a box-shadow. The choice buys layout independence, not shape and
 * not clipping.
 */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-terracotta)]";
