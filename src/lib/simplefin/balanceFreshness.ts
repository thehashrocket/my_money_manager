/**
 * Decides whether the bank's own balance figure is new enough to adjudicate a
 * ledger-vs-bank difference.
 *
 * ## Why this exists
 *
 * The balance check had exactly one thing to say about a non-zero difference:
 * "a row is missing or duplicated, or the starting balance is wrong." That is a
 * claim about the *ledger*, and it is only true if the bank's figure covers
 * everything the ledger covers. SimpleFIN's `balance` is a point-in-time
 * snapshot carrying its own `balance-date`, and when MX stops refreshing a
 * connection that snapshot simply stops moving — so the app confidently accused
 * the ledger of corruption over a bank figure that was a day old. Measured
 * once, on real data: a +$893.84 "drift" that reconciled to the cent against
 * activity the feed had not yet reported.
 *
 * ## Why the test is `>` and not `>=`
 *
 * Transactions are stored as local calendar dates; the bank's figure is an
 * instant. A snapshot taken at 09:52 on the 2nd has seen *some* of the 2nd, and
 * nothing in a day-granular ledger says which rows. So a bank figure dated the
 * same day as the newest ledger row proves nothing, and only a figure dated
 * strictly later is guaranteed to have seen every row the ledger holds.
 *
 * This is deliberately conservative — it will call a real drift "inconclusive"
 * on any day the ledger already has rows for. That is the right way to be
 * wrong: the number is still shown, alongside the bank figure's age, so the
 * user can judge. Asserting corruption that isn't there sends someone digging
 * through 1,500 rows for a duplicate that doesn't exist.
 */

export type BalanceFreshness =
  /** The bank figure post-dates every ledger row; a difference is real drift. */
  | { state: "conclusive" }
  /**
   * The bank figure may predate some ledger rows (or carries no date at all),
   * so a difference cannot be blamed on the ledger.
   */
  | { state: "inconclusive"; bankAsOfDate: string | null; ledgerAsOfDate: string };

/**
 * @param bankAsOfDate  The feed's `balance-date` collapsed to a LOCAL calendar
 *                      date (`toLocalIso`), or null if the feed omitted it.
 *                      A local date rather than the raw instant so this stays a
 *                      pure string comparison — the timezone collapse is tested
 *                      once, in `now.ts`, instead of in every case here.
 * @param ledgerAsOfDate The newest date the ledger has an opinion about: its
 *                      newest posted row, or the starting-balance anchor date
 *                      when there are no rows after it.
 */
export function classifyBalanceFreshness(
  bankAsOfDate: string | null,
  ledgerAsOfDate: string,
): BalanceFreshness {
  if (bankAsOfDate === null) {
    return { state: "inconclusive", bankAsOfDate: null, ledgerAsOfDate };
  }
  return bankAsOfDate > ledgerAsOfDate
    ? { state: "conclusive" }
    : { state: "inconclusive", bankAsOfDate, ledgerAsOfDate };
}
