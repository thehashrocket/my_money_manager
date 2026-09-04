import { createHash } from "node:crypto";
import { normalizeMerchant, extractCardLastFour } from "../normalize";
import { parseAmountToCents } from "@/lib/money";
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
