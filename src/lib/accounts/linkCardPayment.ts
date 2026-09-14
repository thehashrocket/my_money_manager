import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { linkTransferPairManually } from "@/lib/simplefin/sync";
import { accountClass } from "./accountClass";
import { importsTransactions } from "./importsTransactions";
import { isCreditCard } from "./isCreditCard";
import { loadAccountBalances } from "./loadAccountBalances";
import { pairingWarnsOnCategorized } from "./resolveCardAffordances";
import type { ManualWriteResult } from "./manualTransaction";

type Db = typeof defaultDb;

export type LinkCardPaymentInput = {
  /** The checking/savings side — money leaving an account, filed or not. */
  transactionId: number;
  /** The real bank row on the importing card — a `loadCardPaymentCandidates` row. */
  cardTransactionId: number;
};

/**
 * T9 (card-transaction-import plan, D8.2/D4.1) — the manual entry point onto
 * the ALREADY-EXISTING `linkTransferPairManually`, deliberately thin.
 *
 * D8.2's finding was that the missing piece for pairing a Citi payment was an
 * entry point, not a new matching engine: `linkTransferPairManually`'s date
 * guard sits entirely inside its same-account branch, so a cross-account pair
 * — which this always is, a checking row to a card row — is date-unchecked
 * already. This function adds only what a card-payment link specifically
 * needs on top of that: confirming the target really is an importing card
 * (belt and braces — the picker only ever lists one, per
 * `listImportingCardAccounts`, but the form's props are server-rendered and
 * the link can move in another tab, rule 11), and D4.1's warning.
 *
 * Lives beside `manualTransaction.ts` rather than in it: that module's three
 * functions each WRITE a new row (a charge, a payment mirror) or delete one;
 * this one only links two rows that already exist, which is `sync.ts`'s
 * domain (`linkTransferPairManually` lives there, alongside the ordinary
 * transfer-review queue this is a cousin of) — importing it here rather than
 * duplicating its guards is the same "one spelling" discipline CLAUDE.md
 * names throughout this codebase.
 */
export function linkCardPayment(
  input: LinkCardPaymentInput,
  db: Db = defaultDb,
): ManualWriteResult {
  const source = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      amountCents: schema.transactions.amountCents,
      categoryId: schema.transactions.categoryId,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.transactionId))
    .get();
  if (!source) {
    return {
      status: "refused",
      reason: "not-found",
      message: "That transaction no longer exists.",
    };
  }

  // Red-team finding (card-payment-linking-pr2): the row menu's candidate
  // filter is magnitude-only (`c.amountCents === -amountCents`), with no
  // restriction on the SOURCE row's own account or sign — so without these
  // two checks, a categorized charge sitting ON one card could be "linked"
  // to an unrelated credit on a DIFFERENT card whenever their magnitudes
  // happened to match, or an incoming deposit could be linked to a card's
  // own charge. Both are reachable through ordinary use, not a crafted
  // request. `markAsCardPayment` already guards the identical invariant for
  // its own source leg (`manualTransaction.ts`'s "THE SOURCE LEG MUST BE AN
  // ASSET" comment records the real incident this class of bug already
  // caused once: a Visa charge marked as a Mastercard payment inflated
  // `paidDownCents` for money that was never paid) — mirrored here verbatim
  // rather than trusted to the UI, since `linkTransferPairManually`'s own
  // guards only check opposite-signs/equal-magnitude/not-already-paired and
  // have no opinion on which account a leg belongs to.
  if (source.amountCents >= 0) {
    return {
      status: "refused",
      reason: "invalid",
      message: "A card payment has to be money leaving an account.",
    };
  }
  const sourceAccount = db
    .select({ type: schema.accounts.type, name: schema.accounts.name })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, source.accountId))
    .get();
  if (!sourceAccount || accountClass(sourceAccount.type) !== "asset") {
    return {
      status: "refused",
      reason: "invalid",
      message: `A payment has to come from a checking or savings account, not from ${sourceAccount?.name ?? "that account"}.`,
    };
  }

  const cardLeg = db
    .select({ id: schema.transactions.id, accountId: schema.transactions.accountId })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, input.cardTransactionId))
    .get();
  if (!cardLeg) {
    return {
      status: "refused",
      reason: "not-found",
      message: "That card transaction no longer exists.",
    };
  }

  const card = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, cardLeg.accountId))
    .get();
  if (!card || !isCreditCard(card.type)) {
    return {
      status: "refused",
      reason: "not-a-card",
      message: "That row is not on a credit card.",
    };
  }
  if (!importsTransactions(card)) {
    return {
      status: "refused",
      // Distinct from the `!isCreditCard` refusal above: this account IS a
      // real credit card, it just isn't feed-linked-and-importing — a
      // structurally different condition, so it gets its own reason rather
      // than overloading "not-a-card" for two different refusal classes.
      reason: "not-importing",
      message: `${card.name} does not import its own transactions, so there is no bank row here to link to. Use "Mark as payment to" instead.`,
      accountId: card.id,
    };
  }

  let linked: { clearedRejection: boolean };
  try {
    linked = linkTransferPairManually(input.transactionId, input.cardTransactionId, db);
  } catch (err) {
    return {
      status: "refused",
      reason: "invalid",
      message: err instanceof Error ? err.message : "That didn't work.",
    };
  }

  const balanceCents = loadAccountBalances(db).find((b) => b.id === card.id)?.balanceCents ?? null;

  // D4.1 — warn, don't refuse. Under Phase A the source row was filed under a
  // category before Phase B could ever exist to pair it; pairing it now is
  // the CORRECT next step, but it does take the row out of that category's
  // spend (`transfer_pair_id IS NOT NULL`), so the message says so rather
  // than silently changing what a category's spend total means.
  const warning = pairingWarnsOnCategorized(source)
    ? " That transaction was already filed under a category — it no longer counts as spend now that it is linked."
    : "";
  const clearedNote = linked.clearedRejection
    ? " This also cleared the “not a transfer” you had recorded for this pair."
    : "";

  return {
    status: "ok",
    transactionId: input.transactionId,
    balanceCents: balanceCents ?? 0,
    message: `Linked to ${card.name}.${clearedNote}${warning}`,
  };
}
