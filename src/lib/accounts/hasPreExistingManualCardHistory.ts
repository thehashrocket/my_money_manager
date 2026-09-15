import { and, eq, gt, sql } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";

/**
 * Does this card carry a hand-entered charge or payment, dated AFTER its own
 * anchor, written before it was ever linked to SimpleFIN?
 *
 * D8.3 (`manualTransaction.ts`) refuses a NEW manual entry the instant
 * `importsTransactions(account)` is true — checked live against the account
 * row, so it fires from the moment the account is linked, before any sync has
 * ever run. That closes the WRITING side. It says nothing about a row already
 * written before the link existed: hand-enter a charge on an unlinked card,
 * then link it without first reconciling the anchor past that charge's date
 * (D9.1's manual step, T6, documents doing this but nothing enforces it), and
 * the bank's real row for the same event arrives on the first sync as a
 * SEPARATE transaction — content dedup cannot collapse it against the
 * hand-typed row (a different memo, likely a different date too). That is the
 * exact double-count D8.3 exists to prevent, reached from the opposite
 * direction. See TODOS.md, "a card's PRE-EXISTING manual history".
 *
 * Because D8.3 is live and unconditional, this population can only ever
 * SHRINK once an account is linked — a manual row can be removed via
 * `removeCardActivity`, but a new one can never be added — so this needs no
 * re-check inside a write transaction the way rule 11's guards do. It is a
 * stable precondition to test once per sync, not a race.
 *
 * `date > cutoverAnchor`, the same strict comparison `isAfterAnchor` names
 * elsewhere: a manual row ON the anchor date contributes nothing to the
 * balance sum either (rule 1) and the sync cutover already drops a feed row
 * there, so it cannot collide with one.
 */
export function hasPreExistingManualCardHistory(
  accountId: number,
  cutoverAnchor: string,
  db: AnyDb = defaultDb,
): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, accountId),
        eq(schema.transactions.importSource, "manual"),
        gt(schema.transactions.date, cutoverAnchor),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}
