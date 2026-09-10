import type { AccountType } from "./loadAccountBalances";

/**
 * Whether a SimpleFIN sync stages this account's TRANSACTION rows.
 *
 * The fifth sibling of `accountClass` / `isCreditCard` / `isLongTermLiability`
 * / `hasAnyTransactionRows`, and it exists for the reason rule 9 states
 * outright: do not add a second independent derivation of an account
 * capability. The natural way to write the partition this feeds is
 * `isCreditCard(a.type) && a.simplefinAccountId !== null`, inline — which
 * would be a fourth capability derivation in a file that already imports
 * three, and the next consumer (`resolveBalanceAction`, the synthetic-mirror
 * refusal, `resolveCardAffordances`) would spell it a fourth way.
 *
 * READ THE NAME PRECISELY. It is about the FEED, not about whether the
 * account can hold rows at all:
 *
 *   linked checking   true    the feed stages its rows (and CSV also imports)
 *   UNLINKED checking false   CSV still imports for it — the feed does not
 *   linked credit     true    what this whole change is for
 *   UNLINKED credit   false   hand-entered charges only, exactly as before
 *   loan (either)     false   the feed reports 0 rows over 89 days for THIS
 *                             loan, which is too new to have a payment yet —
 *                             not a proven feed limitation (D1, corrected)
 *
 * The unlinked-card row is the one that does real work. `markAsCardPayment`
 * fabricates a mirror row on the card dated from the CHECKING leg with an
 * invented memo, and on an IMPORTING card the bank's own credit later arrives
 * with a different date and a different memo — so content dedup cannot
 * collapse them and the card counts one payment twice (D8.3). On an unlinked
 * card no such row is ever coming, so the mirror is still the right answer and
 * the affordance stays. One predicate, two correct behaviours.
 *
 * Exhaustive on purpose, like its three siblings: a new account type is a
 * compile error here and in all of them at once, which is the whole point.
 * A `line_of_credit` must decide this question explicitly rather than
 * inheriting an answer from whichever branch happened to catch it.
 */
export function importsTransactions(account: {
  type: AccountType;
  simplefinAccountId: string | null;
}): boolean {
  switch (account.type) {
    case "checking":
    case "savings":
    case "credit":
      return account.simplefinAccountId !== null;
    // D1 — CORRECTED same day. Probed 2026-09-09: the live feed returns 0
    // transactions for the mortgage over an 89-day window. A first draft of
    // this comment read that as proof the feed can never return mortgage
    // transactions and called the exclusion permanent. Wrong: this loan was
    // originated 1-2 weeks before the probe and has had no payments post — a
    // round origination-principal balance, an anchor that has never moved,
    // and zero mortgage-shaped memos anywhere in the checking history all
    // point at the account's AGE, not a feed limitation. Whether Star One
    // exposes loan transactions at all is untested, not settled, and only
    // checkable once a first payment posts.
    //
    // The exclusion still holds today, on E1 alone: importing a mortgage's
    // interest/escrow/principal rows double-counts a payment already
    // budgeted on the checking side, regardless of why the feed currently
    // reports zero rows. That argument does not need the "the feed can
    // never" claim, which is why removing the claim does not change the
    // return value here.
    case "loan":
      return false;
    default: {
      const unreachable: never = account.type;
      throw new Error(
        `importsTransactions: unrecognized accounts.type ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
