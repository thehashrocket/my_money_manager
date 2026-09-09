import { and, eq, inArray, or } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";

/**
 * The one place that knows how a rejected pairing is stored.
 *
 * "These two are NOT two halves of one movement" is a fact about a PAIR, and
 * it is now kept in `transfer_pair_rejections` rather than in a column on each
 * leg. The schema comment on `transferPairRejections` has the full argument;
 * the short version is that a column holds one partner, and the same-account
 * reversal queue made writing a marker a one-click act, at which point one
 * slot per row stopped being merely lossy and became load-bearing-wrong in two
 * distinct ways (erasing an unrelated correction, and a review bucket that
 * could never be dismissed).
 *
 * Every read goes through {@link loadRejectedPairs} — ONE query per matcher
 * run, not one per candidate pair. The matchers evaluate this predicate inside
 * their inner loops (`findTransferPairs`' bucket scan,
 * `assignAvoidingRejections`' backtracking), so a per-call query would be an
 * N-squared round trip against a synchronous driver that blocks the event
 * loop.
 */

/** A pair, unordered: `low < high` always, so one probe answers both directions. */
export type PairKey = string;

/**
 * Canonical key for an unordered pair.
 *
 * The old column needed `a.marker === b.id || b.marker === a.id` at every read
 * because the relation was stored twice, once per leg, and the two copies
 * could disagree after an overwrite. Normalising on the way in makes the
 * unique index the enforcement rather than a convention, and makes membership
 * a single exact lookup.
 */
export function pairKey(aId: number, bId: number): PairKey {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

function ordered(aId: number, bId: number): { low: number; high: number } {
  return aId < bId ? { low: aId, high: bId } : { low: bId, high: aId };
}

/**
 * Every rejected pairing that touches one of `rowIds`, as a set of
 * {@link pairKey}s.
 *
 * Scoped to the rows the caller is actually about to consider rather than
 * loading the whole table: the matchers run over a single date's candidates or
 * one review window, and the table grows without bound (nothing prunes a
 * rejection — that is the point of it).
 *
 * An empty `rowIds` short-circuits instead of emitting `IN ()`, which SQLite
 * rejects as a syntax error.
 */
export function loadRejectedPairs(db: AnyDb, rowIds: number[]): Set<PairKey> {
  if (rowIds.length === 0) return new Set();
  const rows = db
    .select({
      low: schema.transferPairRejections.lowTransactionId,
      high: schema.transferPairRejections.highTransactionId,
    })
    .from(schema.transferPairRejections)
    .where(
      or(
        inArray(schema.transferPairRejections.lowTransactionId, rowIds),
        inArray(schema.transferPairRejections.highTransactionId, rowIds),
      ),
    )
    .all();
  return new Set(rows.map((r) => pairKey(r.low, r.high)));
}

/**
 * Builds the `(a, b) => boolean` predicate the matchers take.
 *
 * Returned as a closure over an already-loaded set so the matchers keep their
 * current shape — they accept a pure predicate and must stay testable without
 * a database.
 */
export function rejectionPredicate<T extends { id: number }>(
  rejected: Set<PairKey>,
): (a: T, b: T) => boolean {
  return (a, b) => rejected.has(pairKey(a.id, b.id));
}

/**
 * Records a rejection. Idempotent: re-rejecting an already-rejected pair is a
 * no-op rather than a constraint violation, because a stale tab resubmitting
 * is ordinary use on this surface.
 *
 * Returns whether a new row was actually written, so a caller can tell "I
 * recorded your answer" from "you had already answered this" instead of
 * reporting both as the same success.
 */
export function recordPairRejection(db: AnyDb, aId: number, bId: number): boolean {
  const { low, high } = ordered(aId, bId);
  const already = db
    .select({ id: schema.transferPairRejections.id })
    .from(schema.transferPairRejections)
    .where(
      and(
        eq(schema.transferPairRejections.lowTransactionId, low),
        eq(schema.transferPairRejections.highTransactionId, high),
      ),
    )
    .get();

  // `onConflictDoNothing` regardless of the read above: the read answers "was
  // this already recorded" for the CALLER's message, while the conflict clause
  // is what makes the write itself safe. Reading `.run()`'s `changes` instead
  // would be the obvious one-statement version, but `AnyDb` erases the driver
  // result type (it has to, to accept a transaction handle too), so it comes
  // back as `unknown`.
  db.insert(schema.transferPairRejections)
    .values({ lowTransactionId: low, highTransactionId: high })
    .onConflictDoNothing()
    .run();

  return already === undefined;
}

/**
 * Forgets one rejection — used when the user deliberately links the very pair
 * they had previously rejected ("Link as transfer anyway").
 *
 * Scoped to this pair alone. Under the old column this needed a conditional
 * (`marker === partner ? null : marker`) to avoid destroying a rejection
 * recorded against a THIRD row; with a row per pair that hazard cannot arise,
 * which is the same reason the erasure bug is gone.
 *
 * Returns whether a rejection was actually there to forget. That fact is not
 * bookkeeping: erasing a recorded "not a pair" is the reason CLAUDE.md rule 4
 * says the link branch is NOT the reversible one, and so not a safe default for
 * `intent`. Until v0.22.0 this returned void, so the surface that performs the
 * erasure had no way to mention it and the success message said only "Linked as
 * a reversal" — the user's earlier decision disappeared with no record that it
 * had ever existed.
 */
export function clearPairRejection(db: AnyDb, aId: number, bId: number): boolean {
  const { low, high } = ordered(aId, bId);
  const pair = and(
    eq(schema.transferPairRejections.lowTransactionId, low),
    eq(schema.transferPairRejections.highTransactionId, high),
  );

  // Read-then-delete for the same reason `recordPairRejection` above reads
  // before its insert: `AnyDb` erases the driver result type (it has to, to
  // accept a transaction handle too), so `.run()`'s `changes` comes back as
  // `unknown`. Both callers already hold a transaction, so the read and the
  // delete cannot be interleaved.
  const existing = db
    .select({ lowTransactionId: schema.transferPairRejections.lowTransactionId })
    .from(schema.transferPairRejections)
    .where(pair)
    .get();

  db.delete(schema.transferPairRejections).where(pair).run();

  return existing !== undefined;
}
