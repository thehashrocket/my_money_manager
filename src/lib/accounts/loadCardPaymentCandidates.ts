import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type CardPaymentCandidate = {
  id: number;
  date: string;
  amountCents: number;
  rawMemo: string;
};

/**
 * T9 (card-transaction-import plan, D8.2) — the candidate list for the
 * manual cross-date card-payment link, ONE query per importing card rather
 * than one per row on the page.
 *
 * D8.2 explicitly rejected a fuzzy auto-matcher: measured offsets between a
 * Citi payment's card leg and its checking leg were 1, 3, 1 and 1 days, so
 * `matchTransfers`' `(date, |amount|)` bucket key would never auto-pair any
 * of them. The missing piece was an entry point onto the ALREADY-EXISTING
 * `linkTransferPairManually` (whose date guard is scoped entirely inside its
 * same-account branch, so a cross-account pair is date-unchecked already),
 * not a new matching engine — so this returns every unpaired POSITIVE row on
 * the card, unfiltered by date or amount, and the caller (the row menu's
 * picker) narrows to the specific source row's magnitude client-side. That
 * split — one broad per-card query, one row-scoped narrow — is what lets a
 * single page load serve every row's picker with no per-row round trip, at
 * this app's realistic volume (~1.7 card transactions a month).
 *
 * Only POSITIVE rows: a card payment is a CREDIT to the card, so a candidate
 * has to be money arriving there. `transferPairId IS NULL` excludes rows
 * already paired — `linkTransferPairManually` would refuse those anyway
 * (its own "neither already paired" guard), so filtering here means the
 * picker never lists something the link call would then reject.
 */
export function loadCardPaymentCandidates(
  cardAccountId: number,
  db: Db = defaultDb,
): CardPaymentCandidate[] {
  return db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, cardAccountId),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all()
    .filter((row) => row.amountCents > 0)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
