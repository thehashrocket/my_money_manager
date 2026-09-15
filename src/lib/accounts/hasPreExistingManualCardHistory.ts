import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";

/**
 * Does this card carry ANY hand-entered charge or payment written before it
 * was ever linked to SimpleFIN?
 *
 * D8.3 (`manualTransaction.ts`) refuses a NEW manual entry the instant
 * `importsTransactions(account)` is true — checked live against the account
 * row, so it fires from the moment the account is linked, before any sync has
 * ever run. That closes the WRITING side. It says nothing about a row already
 * written before the link existed: hand-enter a charge on an unlinked card,
 * then link it, and the bank's real row for the same event arrives on a sync
 * as a SEPARATE transaction — content dedup cannot collapse it against the
 * hand-typed row (a different memo, and very often a different date: Star
 * One's own `posted` field is a SETTLEMENT date, routinely a day or more
 * after the purchase date a person would have hand-typed). That is the exact
 * double-count D8.3 exists to prevent, reached from the opposite direction.
 * See TODOS.md, "a card's PRE-EXISTING manual history".
 *
 * NOT SCOPED TO THE ACCOUNT'S ANCHOR, on purpose — an EARLIER version of this
 * check was, and `/ship`'s own adversarial review (2026-09-15) proved that
 * scoping actively unsafe rather than merely narrow, in two ways: (1) the
 * documented remedy, "Reconcile past the manual row's date", does not close
 * the hole it claims to — the bank's own settlement date can still land AFTER
 * the new anchor even though the event it represents is the SAME one the
 * manual row already recorded, so reconciling forward produced a genuine,
 * warning-free double-count in a live repro. (2) An anchor read once, before
 * `await fetchAccounts(...)`, and never re-verified, is exactly rule 11's
 * "read before await, used after" shape: a Reconcile or Undo landing during
 * the fetch window moves the TRUE anchor while this check still holds the
 * stale one, so `account.startingBalanceDate` is not a value this function
 * may trust across that boundary at all. Removing the anchor from the
 * predicate removes both problems at once rather than patching either: there
 * is no anchor value left to go stale, and no remedy left that looks safe
 * without being safe.
 *
 * The only remedy that actually closes the hole is removing the manual
 * row(s) — `removeCardActivity` already exists for that — which is also why
 * this checks for ANY manual row on the account rather than one in some
 * date range: as long as a manual row exists, the bank can still report a
 * same-event duplicate for it on some future sync, at some settlement date
 * this function has no way to predict.
 *
 * Because D8.3 is live and unconditional, this population can only ever
 * SHRINK once an account is linked — a manual row can be removed via
 * `removeCardActivity`, but a new one can never be added — so, unlike the
 * anchor itself, this IS a stable precondition needing no re-check inside a
 * write transaction the way rule 11's other guards do.
 */
export function hasPreExistingManualCardHistory(accountId: number, db: AnyDb = defaultDb): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(schema.transactions)
    .where(
      and(eq(schema.transactions.accountId, accountId), eq(schema.transactions.importSource, "manual")),
    )
    .limit(1)
    .get();
  return row !== undefined;
}
