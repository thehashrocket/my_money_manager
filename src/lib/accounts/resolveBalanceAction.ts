/** `accounts.balance_source` — which path last moved the anchor. */
export type BalanceSource = "feed" | "manual";

/** The single balance-updating action a row offers. Never both, never neither. */
export type BalanceAction = "refresh" | "reconcile";

/**
 * What an account row can DO about its balance.
 *
 * DS55 promised "never both, never neither" and tried to read it off
 * `balance_source`, which nothing set at account creation — so every new card
 * rendered with no Refresh and no Reconcile, and Reconcile is the only way to
 * update a card balance at all under D15. The account was uneditable from the
 * moment it existed (E4).
 *
 * The fix is to notice DS55 was asking one column two questions:
 *
 *   CAPABILITY — derived, here.       What this row can do right now.
 *   HISTORY    — stored, balance_source. What last happened, for DS57's
 *                                        staleness threshold only.
 *
 * Total over both inputs by construction: two booleans, two outcomes, no
 * third state to forget. This also closes a case DS55 merely styled — a
 * `feed` account that later grew transaction rows kept offering Refresh while
 * D7/D15's zero-row-scoped balance pass silently skipped it every time.
 *
 * `hasAnyRows` must come from `hasAnyTransactionRows` (E16), which counts
 * rows with NO anchor filter. The cheap reading — reusing
 * `loadAccountBalances`' existing anchor-filtered aggregate — makes a card
 * reconciled to today look zero-row (every row it owns now predates the
 * anchor) and therefore eligible for a feed refresh, which is exactly what
 * D15 forbids.
 */
export function resolveBalanceAction(
  account: { simplefinAccountId: string | null },
  hasAnyRows: boolean,
): BalanceAction {
  // D7/D15: the feed pass only ever writes an anchor for an account whose SUM
  // is zero regardless, because SimpleFIN's balance-date is an instant, not a
  // close-of-day figure. With rows present, collapsing it to a date would
  // silently drop every row later that same day out of the balance.
  if (account.simplefinAccountId !== null && !hasAnyRows) return "refresh";
  return "reconcile";
}
