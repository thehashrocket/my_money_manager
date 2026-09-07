import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";
import { accountClass } from "./accountClass";
import { isLongTermLiability } from "./isLongTermLiability";
import { loadAccountBalances } from "./loadAccountBalances";
import { normalizeMerchant } from "@/lib/normalize";
import { formatCents } from "@/lib/money";

type Db = typeof defaultDb;

/**
 * The third write path (D6=B): rows the user types, rather than rows a bank
 * hands us. CSV import and SimpleFIN sync are the other two.
 *
 * D10=C gives card activity exactly three movements, and they are genuinely
 * different operations rather than one parameterised one:
 *
 *   1. PAYMENT   -$500 checking ↔ +$500 card, a transfer pair. Money-neutral,
 *                excluded from spend by every existing `transfer_pair_id IS
 *                NULL` filter with no query changes.
 *   2. CHARGE    -$80 on the card, categorized. Counts as real spending in its
 *                envelope, in the month charged — this is what keeps card
 *                spending visible to the budget at all (D13=B). A REFUND is
 *                the same operation with the sign flipped (E13).
 *   3. RECONCILE an anchor move, and therefore NOT here — see
 *                `/accounts`' updateLiabilityBalanceAction.
 *
 * Everything returns its outcome as state and nothing throws for a reachable
 * outcome (E20): each of these is called from a `/accounts` server action, and
 * a throw would unmount the route and take the user's typed input with it.
 */

export type ManualRefusalReason =
  | "not-found"
  | "not-a-card"
  | "before-anchor"
  | "already-paired"
  | "invalid";

export type ManualWriteResult =
  | { status: "ok"; message: string; transactionId: number; balanceCents: number }
  | {
      status: "refused";
      reason: ManualRefusalReason;
      message: string;
      /** The account the refusal is about, when there is one — DS56 needs it
       *  to open the right row's reconcile form. */
      accountId?: number;
    };

function refused(
  reason: ManualRefusalReason,
  message: string,
  accountId?: number,
): ManualWriteResult {
  return { status: "refused", reason, message, accountId };
}

/**
 * `import_row_hash` is NOT NULL and unique within
 * `(account_id, import_batch_id, import_row_hash)`. E21 gives every manual
 * operation its own batch, so uniqueness is satisfied by construction; the
 * hash still carries the row's own fields so it is not a constant.
 */
function manualRowHash(parts: {
  accountId: number;
  date: string;
  amountCents: number;
  rawMemo: string;
  batchId: number;
}): string {
  return createHash("sha1")
    .update(
      `manual|${parts.accountId}|${parts.date}|${parts.amountCents}|${parts.rawMemo}|${parts.batchId}`,
    )
    .digest("hex");
}

/**
 * E21 — ONE BATCH PER MANUAL OPERATION, never one reused forever.
 *
 * Every column on `import_batches` is scoped to a single atomic write:
 * `transactionCount`, `snapshotPath`, `snapshotWarning`,
 * `anchoredStartingBalance*`, `priorStartingBalance*`, `importedAt`. Reusing
 * one row would freeze `importedAt`, require a read-modify-write increment on
 * a count nobody reads, and permanently falsify four columns. At ~20 manual
 * entries a month that is ~240 small rows a year in a local SQLite file with
 * no batch-list UI to clutter — and it is LESS code than the lazy-reuse
 * design D6=B originally specified.
 */
function createManualBatch(tx: AnyDb): number {
  const [batch] = tx
    .insert(schema.importBatches)
    .values({ source: "manual", label: null, transactionCount: 1 })
    .returning({ id: schema.importBatches.id })
    .all();
  return batch.id;
}

/**
 * E17 — the shared entry guard, applied once rather than per action.
 *
 * Nothing stopped a charge or a payment landing on the mortgage. `/accounts`
 * only offers those controls on card rows, but a Server Action does not care
 * what the UI offered, and the zero-transaction-row premise is load-bearing
 * under D3 (spend queries don't filter by account), D7 and D15 (the feed
 * balance pass is scoped to zero-row accounts) and E16. It was guaranteed by
 * button placement alone.
 */
function requireCardAccount(
  accountId: number,
  tx: AnyDb,
): { ok: true; account: typeof schema.accounts.$inferSelect } | { ok: false; result: ManualWriteResult } {
  const account = tx
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!account) {
    return { ok: false, result: refused("not-found", "That account no longer exists.") };
  }
  if (accountClass(account.type) !== "liability" || isLongTermLiability(account.type)) {
    return {
      ok: false,
      result: refused(
        "not-a-card",
        `${account.name} is not a credit card, so activity can't be added to it.`,
        accountId,
      ),
    };
  }
  return { ok: true, account };
}

function currentBalanceCents(accountId: number, db: Db): number {
  return loadAccountBalances(db).find((b) => b.id === accountId)?.balanceCents ?? 0;
}

export type CardActivityInput = {
  accountId: number;
  date: string;
  /** Always POSITIVE. The caller picks charge or refund; the sign is ours. */
  amountCents: number;
  merchant: string;
  /** Required — see below. */
  categoryId: number;
};

/**
 * D10 path 2 — a hand-entered card charge. `kind: "refund"` flips the sign
 * (E13).
 *
 * The category is REQUIRED, not optional. D13=B's whole argument is that card
 * charges are how card spending stays visible to the budget; a charge landing
 * with `category_id = NULL` goes to the categorize backlog instead, and
 * D13's claim quietly fails for that row.
 */
export function createCardActivity(
  input: CardActivityInput & { kind: "charge" | "refund" },
  db: Db = defaultDb,
): ManualWriteResult {
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    return refused("invalid", "Enter an amount greater than zero.");
  }
  if (input.merchant.trim() === "") {
    return refused("invalid", "Enter where the charge was made.");
  }

  const result = db.transaction((tx): ManualWriteResult => {
    const guard = requireCardAccount(input.accountId, tx);
    if (!guard.ok) return guard.result;
    const { account } = guard;

    // D12 — REFUSED on or before the anchor, for charges and refunds only.
    //
    // Rule 1's `>` is strict. Reconcile on the 20th, then remember an $80
    // charge from the 3rd: `09-03 > 09-20` is false, so the row lands in
    // /transactions and in your budget envelope and contributes NOTHING to
    // the card balance. It does (a) count as spend and (b) not move the
    // balance — an inconsistent state. Refuse rather than warn: make the bad
    // state unrepresentable, not merely announced.
    //
    // E5 — this is correct for charges and WRONG for payment mirrors, which
    // is why the check lives here and not in the shared guard.
    if (input.date <= account.startingBalanceDate) {
      return refused(
        "before-anchor",
        // DS61 #12. States the consequence, names no schema concept, and the
        // caller pairs it with "Reconcile instead →" — which is genuinely the
        // right fix, since a fresh reconcile already includes this charge.
        `This is dated before your last reconcile (${account.startingBalanceDate}), so it wouldn't count toward the balance.`,
        input.accountId,
      );
    }

    const amountCents = input.kind === "charge" ? -input.amountCents : input.amountCents;
    const rawMemo = input.merchant.trim();
    const batchId = createManualBatch(tx);

    const [row] = tx
      .insert(schema.transactions)
      .values({
        accountId: input.accountId,
        date: input.date,
        // The subscription detector excludes rows whose rawDescription is
        // 'DEPOSIT'; a refund is not a recurring charge, so this keeps that
        // exclusion working the same way the SimpleFIN path does.
        rawDescription: input.kind === "charge" ? "PURCHASE" : "DEPOSIT",
        rawMemo,
        normalizedMerchant: normalizeMerchant(rawMemo),
        amountCents,
        importSource: "manual",
        importBatchId: batchId,
        importRowHash: manualRowHash({
          accountId: input.accountId,
          date: input.date,
          amountCents,
          rawMemo,
          batchId,
        }),
        categoryId: input.categoryId,
      })
      .returning({ id: schema.transactions.id })
      .all();

    return {
      status: "ok",
      message: "",
      transactionId: row.id,
      balanceCents: 0,
    };
  });

  if (result.status !== "ok") return result;

  // Read back outside the write transaction so the figure quoted to the user
  // is the committed one.
  const balanceCents = currentBalanceCents(input.accountId, db);
  return {
    ...result,
    balanceCents,
    message: `Recorded. The balance is now ${formatCents(balanceCents)}.`,
  };
}

/**
 * D10 path 1 — mark an existing checking-account debit as a payment to a card.
 *
 * Inserts the mirror row on the card (+cents, same date, category NULL,
 * source 'manual') and links the two with `transfer_pair_id` in both
 * directions. The checking leg then drops out of every spend sum AND the
 * categorize backlog automatically, with no query changes anywhere.
 *
 * E5 — ACCEPTS ANY DATE, unlike a charge. The anchor defaults to today at
 * account creation, so D12-as-originally-written would have failed this for
 * 100% of existing history on day one. Worse, each refusal left the checking
 * leg unpaired, so `transfer_pair_id` stayed NULL and the payment kept
 * counting as spend — the exact double-count D13=B exists to prevent. The
 * reasoning: a payment must (a) not count as spend and (b) contribute nothing
 * new to the card balance, because any anchor dated after it ALREADY includes
 * it. A pre-anchor mirror does exactly that. It is correct, not a compromise.
 */
export function markAsCardPayment(
  input: { transactionId: number; cardAccountId: number },
  db: Db = defaultDb,
): ManualWriteResult {
  const result = db.transaction((tx): ManualWriteResult => {
    const guard = requireCardAccount(input.cardAccountId, tx);
    if (!guard.ok) return guard.result;
    const { account: card } = guard;

    const leg = tx
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.transactionId))
      .get();
    if (!leg) return refused("not-found", "That transaction no longer exists.");

    if (leg.accountId === input.cardAccountId) {
      return refused("invalid", `That transaction is already on ${card.name}.`);
    }
    if (leg.amountCents >= 0) {
      return refused("invalid", "A card payment has to be money leaving an account.");
    }

    // E10 — the idempotency guard, three-way, re-read INSIDE the write
    // transaction. Guarding on `transfer_pair_id IS NOT NULL` alone silently
    // SUCCEEDS on a row the automatic matcher already paired somewhere else
    // (rule 4 auto-links balanced buckets without asking), quietly reporting
    // a payment to this card that does not exist. Same pattern undoSyncBatch
    // uses for a stale tab or a resubmitted form.
    if (leg.transferPairId !== null) {
      const partner = tx
        .select({
          accountId: schema.transactions.accountId,
          name: schema.accounts.name,
        })
        .from(schema.transactions)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
        .where(eq(schema.transactions.id, leg.transferPairId))
        .get();

      if (partner?.accountId === input.cardAccountId) {
        // Already exactly what was asked for — a double-submit. Report
        // success rather than an error the user cannot act on.
        return {
          status: "ok",
          message: `Already recorded as a payment to ${card.name}.`,
          transactionId: leg.transferPairId,
          balanceCents: 0,
        };
      }
      return refused(
        "already-paired",
        `That transaction is already matched with ${partner?.name ?? "another account"}. Unlink it first.`,
        input.cardAccountId,
      );
    }

    const batchId = createManualBatch(tx);
    const rawMemo = `PAYMENT TO ${card.name.toUpperCase()}`;
    const [mirror] = tx
      .insert(schema.transactions)
      .values({
        accountId: input.cardAccountId,
        date: leg.date,
        rawDescription: "DEPOSIT",
        rawMemo,
        normalizedMerchant: normalizeMerchant(rawMemo),
        amountCents: -leg.amountCents,
        importSource: "manual",
        importBatchId: batchId,
        importRowHash: manualRowHash({
          accountId: input.cardAccountId,
          date: leg.date,
          amountCents: -leg.amountCents,
          rawMemo,
          batchId,
        }),
        // NULL on purpose: a transfer leg is not spending, and pairing takes
        // it out of the backlog, so it never needs one.
        categoryId: null,
      })
      .returning({ id: schema.transactions.id })
      .all();

    // Written directly rather than through `linkTransferPairManually`. The
    // mirror is brand new and carries no rejection marker, and CLAUDE.md rule
    // 4 has that function clear a marker only when it points at the row being
    // relinked — there is nothing here for it to do.
    tx.update(schema.transactions)
      .set({ transferPairId: mirror.id })
      .where(eq(schema.transactions.id, leg.id))
      .run();
    tx.update(schema.transactions)
      .set({ transferPairId: leg.id })
      .where(eq(schema.transactions.id, mirror.id))
      .run();

    return { status: "ok", message: "", transactionId: mirror.id, balanceCents: 0 };
  });

  if (result.status !== "ok") return result;
  const balanceCents = currentBalanceCents(input.cardAccountId, db);
  const card = db
    .select({ name: schema.accounts.name })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, input.cardAccountId))
    .get();
  return {
    ...result,
    balanceCents,
    // DS61 #16.
    message:
      result.message ||
      `Recorded as a payment to ${card?.name ?? "the card"}. ${card?.name ?? "It"} is now ${formatCents(balanceCents)}.`,
  };
}

/**
 * E12 — the correct inverse of `markAsCardPayment`, and NOT
 * `unlinkTransferPair`.
 *
 * That function was built for two real bank rows the matcher wrongly joined,
 * where both rows must survive. Applied to a synthetic mirror it leaves
 * behind a row that (a) has `category_id = NULL` and `transfer_pair_id =
 * NULL`, which is exactly the state the Spine's backlog query counts, (b)
 * still inflates the card balance by the payment, (c) has no correct category
 * — a positive amount in an expense category produces negative `spentCents`,
 * which `resolveRowDisplay`'s `looksLikeIncome` flag exists to complain about
 * — and (d) is now rejection-marked against the checking row, blocking
 * automatic re-pairing.
 *
 * So: clear both links, DELETE the mirror, and write NO rejection marker. The
 * user is undoing their own action, not correcting the matcher. This is also
 * the operation DS61 string 16's 10-second Undo performs, so the marginal
 * cost of the row-menu entry is a second entry point on one function.
 */
export function unmarkCardPayment(
  input: { transactionId: number },
  db: Db = defaultDb,
): ManualWriteResult {
  // Captured inside the transaction so the balance can be re-read from the
  // COMMITTED state afterwards, without smuggling it through the result.
  let cardAccountId: number | null = null;

  const result = db.transaction((tx): ManualWriteResult => {
    const leg = tx
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.transactionId))
      .get();
    if (!leg) return refused("not-found", "That transaction no longer exists.");
    if (leg.transferPairId === null) {
      return { status: "ok", message: "That transaction is not marked as a payment.", transactionId: leg.id, balanceCents: 0 };
    }

    const mirror = tx
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, leg.transferPairId))
      .get();

    // Only ever deletes a row this app synthesised. A real bank row that the
    // matcher paired is unlinked, never removed — that is unlinkTransferPair's
    // job, and deleting one would destroy imported history.
    const isSyntheticMirror =
      mirror !== undefined &&
      mirror.importSource === "manual" &&
      mirror.categoryId === null &&
      mirror.transferPairId === leg.id;

    if (!isSyntheticMirror) {
      return refused(
        "invalid",
        "That pair wasn't created here. Unlink it from the Sync page instead.",
      );
    }

    tx.update(schema.transactions)
      .set({ transferPairId: null })
      .where(eq(schema.transactions.id, leg.id))
      .run();
    // Clear the mirror's own link first: transfer_pair_id is ON DELETE SET
    // NULL, but clearing explicitly keeps the intent readable.
    tx.update(schema.transactions)
      .set({ transferPairId: null })
      .where(eq(schema.transactions.id, mirror.id))
      .run();
    tx.delete(schema.transactions).where(eq(schema.transactions.id, mirror.id)).run();

    // The batch existed only to carry that one row (E21).
    tx.delete(schema.importBatches)
      .where(
        and(
          eq(schema.importBatches.id, mirror.importBatchId),
          eq(schema.importBatches.source, "manual"),
        ),
      )
      .run();

    cardAccountId = mirror.accountId;
    return { status: "ok", message: "", transactionId: leg.id, balanceCents: 0 };
  });

  if (result.status !== "ok" || cardAccountId === null) return result;
  const balanceCents = currentBalanceCents(cardAccountId, db);
  return {
    ...result,
    balanceCents,
    message: `Payment removed. The balance is now ${formatCents(balanceCents)}.`,
  };
}
