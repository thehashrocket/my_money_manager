/**
 * Does a row dated `dateIso` count toward this account's balance?
 *
 * This is rule 1's strict `>` — `starting_balance_cents + SUM(amount_cents
 * WHERE date > starting_balance_date)` — as a function instead of as a
 * comparison retyped at every site that needs it. Both arguments are
 * `YYYY-MM-DD`, so a lexicographic compare IS a chronological one; that only
 * holds because `startingBalanceDateSchema` rejects a calendar-invalid date
 * on every anchor-writing path (rule 1), which is why this takes strings
 * rather than parsing them.
 *
 * THREE sites ask it, and until this module they were three literals:
 *
 *   createCardActivity  `input.date <= account.startingBalanceDate` → refuse
 *   the sync cutover    drop a staged card row on or before the anchor (D8.1)
 *   _account-row.tsx    `startingBalanceDate < today` → is any legal date left
 *                        for `chargeableDateExists` (`canAddCharge`'s gate)
 *
 * The third is the interesting one and it is why this is a shared module
 * rather than a local helper in `sync.ts`. It is not a fourth rule: "is there
 * any date a charge could carry" is exactly "is TODAY after the anchor",
 * because the dialog caps the date at today. Spelled as its own `<` it had
 * already drifted from the server's `<=` once, in a `.tsx` no test can
 * reach — filed as `TODOS.md` P2 with the note that changing the server's
 * comparison hides the button on a day charges are legal, with `tsc` silent
 * and no test moving. All three now read this one function.
 *
 * WHY THE CUTOVER IS THE SAME QUESTION, not merely a similar one. A row on or
 * before the anchor is excluded from the balance sum by the `>` above, but it
 * is NOT excluded from any spend query — those filter on date, category and
 * `transfer_pair_id IS NULL`, never on the anchor. So such a row lands in an
 * envelope while contributing nothing to the balance: money counted as spent
 * that the card does not think you owe. `createCardActivity` calls that "an
 * inconsistent state" and refuses rather than warns. A feed row imported
 * before the cutover would produce it identically, and in bulk — plus, under
 * D8.1, on top of a Phase-A-filed payment for the same dollars in the same
 * month.
 *
 * NAMED PARAMETERS, deliberately, even though both are `YYYY-MM-DD` strings
 * and a positional pair would read the same at every call site today. That
 * sameness is exactly the risk: this function's whole reason to exist is a
 * prior incident where the comparison itself drifted (`<=` to `<`) with no
 * test catching it, and two same-typed positional strings hand a future call
 * site the identical failure mode one level up — `isAfterAnchor(anchor,
 * date)` type-checks and silently inverts the answer. A property-name typo
 * is a loud failure; a transposed positional argument is not.
 */
export function isAfterAnchor({ date, anchor }: { date: string; anchor: string }): boolean {
  return date > anchor;
}
