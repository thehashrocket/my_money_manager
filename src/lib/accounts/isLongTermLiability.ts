import type { AccountType } from "./loadAccountBalances";

/**
 * Whether a liability gets DS59's muted long-term treatment: lower-contrast
 * ink on the balance, grouped under a `LONG-TERM` sub-label, and none of the
 * card-only affordances (no hand-entered charges, no card-terms form).
 *
 * It does NOT decide the balance control. A long-term liability still gets
 * Reconcile or Refresh like any other — `resolveBalanceAction` owns that
 * choice alone, and ANDing this predicate into it left an unlinked car loan
 * with neither control and an uncorrectable balance. See the DS55 block in
 * `_account-row.tsx`.
 *
 * A mortgage is a fact about your life; a card balance is a problem you are
 * solving this month. Rendered identically, a $302k figure sets the
 * emotional register of a page whose real subject is the $2,148 you can
 * actually act on.
 *
 * E7 is why this is its own function keyed on `type` rather than being read
 * off `credit_limit_cents`. DS64 makes the credit limit optional, so
 * "no limit → long-term" filed a perfectly ordinary card the user hadn't
 * bothered to enter a limit for under LONG-TERM, muted and stripped of the
 * Reconcile action that is the only way to update it. Two independent
 * derivations, neither standing in for the other:
 *
 *   utilization bar   ← credit_limit_cents present?  (absence = nothing to show)
 *   LONG-TERM + muted ← isLongTermLiability(type)    (NOT NULL input)
 */
export function isLongTermLiability(type: AccountType): boolean {
  switch (type) {
    case "loan":
      return true;
    case "credit":
    case "checking":
    case "savings":
      return false;
    default: {
      const unreachable: never = type;
      throw new Error(
        `isLongTermLiability: unrecognized accounts.type ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
