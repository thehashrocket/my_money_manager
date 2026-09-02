import { createHash } from "node:crypto";
import { normalizeMerchant, extractCardLastFour } from "../normalize";
import { parseAmountToCents } from "./parseAmount";
import type { SimpleFinTransaction } from "./types";

export type MappedRow = {
  externalId: string;
  date: string;
  rawDescription: "WITHDRAWAL" | "DEPOSIT";
  rawMemo: string;
  normalizedMerchant: string;
  cardLastFour: string | null;
  amountCents: number;
  isPending: boolean;
  importRowHash: string;
  /** MX's cleaned label. Stored for display; never used as a matching key. */
  payee: string | null;
};

/**
 * Extracts in UTC (`toISOString`), never local time, so the calendar date a row
 * lands on is reproducible on any machine rather than depending on the server's
 * timezone.
 *
 * Star One stamps every `posted` at exactly 12:00:00 UTC — verified 576/576 on
 * the live pull — which is a date-only convention, so the UTC date is also the
 * date the user would recognise from their statement. That convention is a
 * convenience, not what makes this correct: the UTC extraction is.
 *
 * Note the noon guarantee is asserted only about `posted`. The `transacted_at`
 * fallback below is unexercised by real data (`transacted_at === posted` on
 * 576/576 rows), so nothing is known about its time-of-day convention.
 */
export function postedToIsoDate(txn: SimpleFinTransaction): string {
  const ts = txn.posted > 0 ? txn.posted : (txn.transacted_at ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error(`Transaction ${txn.id} has no usable posted/transacted_at`);
  }
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * `import_row_hash` is NOT NULL, but the CSV recipe (which needs a row index to
 * break ties between two identical same-day coffees) has no meaning in a JSON
 * feed. SimpleFIN's `id` is already a stable per-account primary key, so derive
 * the hash from it: unique by construction, no tiebreaker needed.
 */
export function simplefinRowHash(externalId: string): string {
  return createHash("sha1").update(`simplefin|${externalId}`).digest("hex");
}

/**
 * Memo whitespace differs by source and must not decide a dedup question.
 * Star One's CSV pads pending-row memos with leading spaces and `parseCsv`
 * preserves them verbatim on purpose (`import_row_hash` is derived from the
 * exact bytes, so trimming there would break hash stability). The feed's memo
 * arrives trimmed. Normalising both sides here — rather than changing either
 * source — keeps that hash contract intact while letting the two representations
 * of one transaction compare equal.
 */
function normalizeMemoForSignature(memo: string): string {
  return memo.trim().replace(/\s+/g, " ");
}

/**
 * Content signature for cross-source dedup. The 90 days SimpleFIN returns
 * overlap history already imported from CSV, and those rows have no
 * external_id to match on — so they are compared on content instead.
 *
 * Without the whitespace normalisation this misses exactly the rows it exists
 * for: a row imported from CSV while pending (padded memo) that later posts and
 * comes back on the feed (trimmed memo) would be inserted a second time.
 */
export function contentSignature(r: {
  date: string;
  amountCents: number;
  rawMemo: string;
}): string {
  return `${r.date}|${r.amountCents}|${normalizeMemoForSignature(r.rawMemo)}`;
}

export function mapTransaction(txn: SimpleFinTransaction): MappedRow {
  // description === memo on 100% of real rows; prefer memo and fall back.
  const rawMemo = (txn.memo ?? txn.description ?? "").trim();
  const amountCents = parseAmountToCents(txn.amount);

  return {
    externalId: txn.id,
    date: postedToIsoDate(txn),
    // There is no source field for this — the CSV's WITHDRAWAL/DEPOSIT column
    // has no SimpleFIN equivalent, so it is derived from the sign. This keeps
    // the subscription-detection exclusion on `raw_description = 'DEPOSIT'`
    // working unchanged.
    rawDescription: amountCents >= 0 ? "DEPOSIT" : "WITHDRAWAL",
    rawMemo,
    normalizedMerchant: normalizeMerchant(rawMemo),
    cardLastFour: extractCardLastFour(rawMemo),
    amountCents,
    isPending: txn.pending === true,
    importRowHash: simplefinRowHash(txn.id),
    payee: txn.payee?.trim() || null,
  };
}
