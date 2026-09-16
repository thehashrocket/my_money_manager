import type { AccountType } from "./loadAccountBalances";
import { isLongTermLiability } from "./isLongTermLiability";
import { importsTransactions } from "./importsTransactions";
import { isAfterAnchor } from "./isAfterAnchor";
import type { BalanceAction } from "./resolveBalanceAction";

export type CardAffordances = {
  canAddCharge: boolean;
  canEditTerms: boolean;
  showReconcile: boolean;
  allowsPositiveBalance: boolean;
};

/**
 * D6.1 (card-transaction-import plan, T7) — what an `/accounts` row can offer
 * for a liability, as ONE pure decision instead of three separately-computed
 * booleans agreeing by hand.
 *
 * Before this, `_account-row.tsx` computed `canAddCharge`, `canEditTerms` and
 * `showReconcile` as three inline expressions passed into `CardControls` —
 * the "three-gate combination that regressed twice inside this branch's own
 * review cycles" (v0.27.0: `CardControls` mounted only on `reconcile`, which
 * silently gated the charge form and the terms form on a fact that has
 * nothing to do with either of them). Three call sites agreeing by hand is
 * exactly the shape rule 6/8/10 keep finding drift in elsewhere in this
 * codebase; folding them into one function gives `tsc` and a test something
 * to hold instead of a paragraph of prose.
 *
 * `showReconcile` is a straight RELAY of `resolveBalanceAction`'s answer, not
 * a second derivation of it — DS55's "exactly one balance control, decided by
 * `action` alone" stays true; this function only adds the two CARD-only
 * affordances beside it.
 */
export function resolveCardAffordances(
  account: {
    type: AccountType;
    startingBalanceDate: string;
    simplefinAccountId: string | null;
  },
  balanceAction: BalanceAction,
  today: string,
): CardAffordances {
  const longTerm = isLongTermLiability(account.type);
  return {
    // D8.3b — a hand-typed charge on a card whose own transactions come in
    // from the feed is refused server-side (`createCardActivity`), so the
    // affordance is withheld here rather than offered and always refused
    // (rule 8). `isAfterAnchor` is rule 1's strict `>` — see its own
    // docstring for why the comparison lives in one place.
    canAddCharge:
      !longTerm &&
      isAfterAnchor({ date: today, anchor: account.startingBalanceDate }) &&
      !importsTransactions(account),
    // NOT `canAddCharge` — terms have no date to refuse, so the credit-limit
    // repair stays reachable on a card anchored today.
    canEditTerms: !longTerm,
    showReconcile: balanceAction === "reconcile",
    // rule 9's sign guard, relayed to `ReconcileForm`: a loan can never
    // legitimately hold a positive balance (unlike a card after an
    // overpayment), so the "You owe"/"You're owed" toggle isn't offered at
    // all for one (rule 8 — a control that can only ever refuse). This used
    // to be a fourth hand-computed `!isLongTermLiability(account.type)` at
    // the `_account-row.tsx` call site, outside this function's own
    // unification of every other liability-row gate — found by Red Team
    // during /ship's pre-landing review as the exact drift shape this
    // function was written to close.
    allowsPositiveBalance: !longTerm,
  };
}

/**
 * D4.1 (T9) — should linking a checking-side payment to a real card row warn
 * rather than proceed silently?
 *
 * Under Phase A (file the payment as spend) the row is categorized before
 * Phase B (import the card's own transactions) can ever exist to pair it —
 * there is nothing else to do with an unpairable payment. Once the card
 * imports, pairing that same row is the CORRECT next step (D2), so a
 * server-side refusal on "already categorized" would block the transition
 * this plan exists to make possible. The categorization is worth a warning
 * anyway: pairing excludes the row from every spend query
 * (`transfer_pair_id IS NOT NULL`), so whatever envelope it was filed under
 * loses that spend the moment the link lands.
 */
export function pairingWarnsOnCategorized(sourceLeg: {
  categoryId: number | null;
}): boolean {
  return sourceLeg.categoryId !== null;
}

/**
 * D5.2 (T9) — is this leg the synthetic mirror `markAsCardPayment` writes?
 *
 * The ONE spelling of the structural test `unmarkCardPayment` already used
 * inline (there is no stored flag marking a pair as "created by this app" —
 * see that function's own comment on why: a real bank row the automatic
 * matcher paired must never be treated as this app's own mirror). Needed a
 * SECOND time as of T9/D5.2 — the `/transactions` row menu has to decide
 * whether to OFFER "Not a card payment" at all (an app-created pair) or a
 * plain, unactionable "Paired" label (a real transfer pair, or a linked pair
 * of two genuine bank rows from T9 itself) — which is exactly the "refusal
 * the user can only discover by triggering it" anti-pattern rule 8 already
 * named for `listCardAccounts`. Extracting this is what keeps the write side
 * and the read side from drifting the way `categoryKindLock.ts` and
 * `kindsImplyUsed.ts` document happening elsewhere in this codebase.
 */
export function isSyntheticCardPaymentMirror(row: {
  importSource: "csv" | "simplefin" | "manual";
  categoryId: number | null;
}): boolean {
  return row.importSource === "manual" && row.categoryId === null;
}

/**
 * D5.2 — is this PAIR app-created (i.e. did `markAsCardPayment` write it)?
 * Either leg may be the synthetic mirror, since `unmarkCardPayment` is
 * reachable from both ends of the pair.
 */
export function isAppCreatedCardPaymentPair(
  leg: { importSource: "csv" | "simplefin" | "manual"; categoryId: number | null },
  partner: { importSource: "csv" | "simplefin" | "manual"; categoryId: number | null },
): boolean {
  return isSyntheticCardPaymentMirror(leg) || isSyntheticCardPaymentMirror(partner);
}
