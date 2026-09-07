import type { AccountType } from "./loadAccountBalances";

/**
 * Whether an account is a credit card — the type that carries a limit, takes
 * hand-entered charges, and offers Reconcile.
 *
 * This exists because the predicate the code actually asks is "is this a
 * card", and it was spelled FIVE different ways, one of which was not
 * equivalent to the other four:
 *
 *   manualTransaction        accountClass(t) !== "liability" || isLongTermLiability(t)
 *   updateCardTermsAction    account.type !== "credit"
 *   validateCreateAccountInput  v.type !== "credit"
 *   _create-account-form     type === "credit"
 *   listCardAccounts         eq(accounts.type, "credit")   (SQL)
 *
 * They agree today only because `{credit, loan}` has exactly two members, so
 * "liability and not long-term" and "equals credit" happen to coincide. Add a
 * `line_of_credit` and they diverge silently: `manualTransaction` would ADMIT
 * hand-entered charges on it while `updateCardTermsAction` refused its terms
 * and `listCardAccounts` never offered it — three different answers, one of
 * them a silent refusal, and NOTHING would fail to compile, because the two
 * exhaustive switches in `accountClass` and `isLongTermLiability` would
 * absorb the new member happily.
 *
 * That is the failure CLAUDE.md rule 9 warns about ("do not add a second
 * independent derivation"), wearing the opposite polarity: the rule was
 * watching the mortgage predicate, and the drift was in its complement.
 *
 * Exhaustive on purpose, like its two siblings — a new account type is a
 * compile error in all three at once, which is the whole point.
 */
export function isCreditCard(type: AccountType): boolean {
  switch (type) {
    case "credit":
      return true;
    case "loan":
    case "checking":
    case "savings":
      return false;
    default: {
      const unreachable: never = type;
      throw new Error(`isCreditCard: unrecognized accounts.type ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The same fact for a SQL `inArray`, where a function can't run.
 *
 * Kept beside `isCreditCard` rather than inlined at the query so the two
 * cannot drift; if a second card-like type is ever added, both this and the
 * switch above have to change, and the switch will refuse to compile until it
 * does.
 */
export const CARD_TYPES = ["credit"] as const satisfies readonly AccountType[];
