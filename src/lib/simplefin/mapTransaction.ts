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
 * Star One stamps every `posted` at exactly 12:00:00 UTC — a date-only
 * convention. Noon is the one hour that lands on the same calendar date in
 * every real timezone, so extracting in UTC is safe here; extracting a
 * midnight-UTC timestamp in US Pacific would shift every row back a day.
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
 * Content signature for cross-source dedup. The 90 days SimpleFIN returns
 * overlap history already imported from CSV, and those rows have no
 * external_id to match on — so they are compared on content instead.
 */
export function contentSignature(r: {
  date: string;
  amountCents: number;
  rawMemo: string;
}): string {
  return `${r.date}|${r.amountCents}|${r.rawMemo}`;
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
