import type { AmbiguousBucket, TransferCandidate } from "./matchTransfers";

/**
 * Same-account reversals: a transaction and its cancellation, both landing on
 * ONE account.
 *
 * Every other pairing path in this app requires the two legs to span two
 * different accounts — `transferPair.ts:60` (`if (a.accountId === b.accountId)
 * continue`), `matchTransfers.ts` (`if (accountIds.length < 2) continue`), and
 * `linkTransferPairManually` itself. That is correct for a TRANSFER, which is
 * money moving between accounts you own. It leaves a real class unreachable:
 *
 *     A2AXFER 000000000-1 Ref# 7F254            −$250.00   account 2
 *     A2AXFER 000000000-1 Ref# 64590 reverse    +$250.00   account 2
 *
 * Both legs on one account, so no matcher can see them, and there was no UI
 * path to pair them by hand either. They land in whatever spend category the
 * user files them under and stay there.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS NEVER AUTO-LINKS                                           │
 * │                                                                     │
 * │ The shape alone — same account, same date, equal magnitude,         │
 * │ opposite signs — is NOT sufficient evidence. Measured across the    │
 * │ live ledger's 8 months: 15 candidate pairs, of which at least two   │
 * │ are coincidences that would DELETE real spending if auto-linked:    │
 * │                                                                     │
 * │   $3.99   "ATM Surcharge fees refund"  vs  "APPLE.COM/BILL"         │
 * │   $200.00 "Zelle Transfer Payment ID"  vs  "ATM 0605 EXAMPLE ST" │
 * │                                                                     │
 * │ A wrong link silently removes money from every spending surface     │
 * │ (see `unlinkTransferPair`'s docstring). At ~2 candidates a month a  │
 * │ human can classify these instantly — an algorithm provably cannot,  │
 * │ because the distinguishing signal lives in heterogeneous memo text  │
 * │ (`reverse`, `Reversal ID:`, `Provisional Credit`, `TO`/`FRM`, and   │
 * │ identical memos), and CLAUDE.md rule 4 makes memo-independence a    │
 * │ deliberate property of the matchers.                                │
 * │                                                                     │
 * │ So: every bucket goes to review. There is no auto-link path here    │
 * │ and this function returns no `pairs` — only `AmbiguousBucket`s.     │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * A genuine merchandise refund fits the same shape (an AMAZON charge and its
 * AMAZON credit, same day, same amount) and should NOT be paired — under the
 * signed spend convention a refund correctly nets against spend and stays
 * visible in the ledger, where pairing would hide both legs. That is exactly
 * the judgement call this queue puts in front of a person.
 */

/**
 * Groups unpaired rows into same-account reversal candidates.
 *
 * Bucket key is `(accountId, date, |amountCents|)` — one tighter than
 * `matchTransfers`' `(date, |amountCents|)`, because the account is part of
 * what defines this class rather than something to compare across.
 *
 * `isRejected` drops a bucket only when EVERY positive/negative combination in
 * it has already been rejected. A one-vs-one bucket therefore disappears for
 * good the first time the user says "not a transfer" (the refund case above
 * must not nag every month), while a bucket with other live combinations keeps
 * surfacing them — rejecting one pairing is not a statement about the others.
 */
export function findSameAccountReversals<T extends TransferCandidate>(
  rows: T[],
  isRejected: (a: T, b: T) => boolean = () => false,
): AmbiguousBucket<T>[] {
  const buckets = new Map<string, T[]>();

  for (const row of rows) {
    // A zero-amount row would land in a bucket where it is simultaneously its
    // own positive and negative counterpart. Nothing legitimate is lost by
    // skipping it: a $0.00 reversal has no effect on any spending total.
    //
    // Belt-and-braces, and deliberately so: the `> 0` / `< 0` split below
    // already keeps a zero row out of BOTH sides, so removing this line changes
    // no current behavior and no test fails. It stays because that split is one
    // edit away from `>= 0` / `<= 0`, and this is the line that says a zero row
    // is never a candidate rather than leaving it as an emergent property.
    if (row.amountCents === 0) continue;
    const key = `${row.accountId}|${row.date}|${Math.abs(row.amountCents)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const ambiguous: AmbiguousBucket<T>[] = [];

  for (const bucket of buckets.values()) {
    const positives = bucket.filter((r) => r.amountCents > 0);
    const negatives = bucket.filter((r) => r.amountCents < 0);
    if (positives.length === 0 || negatives.length === 0) continue;

    const hasLiveCombination = positives.some((p) =>
      negatives.some((n) => !isRejected(p, n)),
    );
    if (!hasLiveCombination) continue;

    ambiguous.push({
      date: bucket[0].date,
      absAmountCents: Math.abs(bucket[0].amountCents),
      positives,
      negatives,
      reason: "same-account",
    });
  }

  // Sorted newest-first so the review queue leads with what just happened.
  // Ties broken by amount then account so the order is total and stable —
  // a queue that reshuffles between renders is one the user cannot trust.
  return ambiguous.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      b.absAmountCents - a.absAmountCents ||
      String(a.positives[0].accountId).localeCompare(String(b.positives[0].accountId)),
  );
}

/**
 * Row ids claimed by BOTH review queues.
 *
 * The two queues bucket on different keys — `matchTransfers` on
 * `(date, |amount|)`, this module on `(accountId, date, |amount|)` — and
 * `matchTransfers`' same-account exclusion is a per-BUCKET test
 * (`accountIds.length < 2`), not a per-row one. So a date-and-amount holding a
 * same-account +/− pair AND rows on another account passes that guard, and the
 * same transaction id comes out of both. Measured on the live ledger
 * 2026-09-08: 1 of 14 buckets (`2026-09-04 · $10.00`, accounts 2 and 1).
 *
 * This is NOT resolvable by dropping rows from one side. The overlap is a
 * genuine ambiguity, not a bug in the bucketing: account A holding both a `+`
 * and a `−` against account B is EITHER a reversal on A, OR the blessed
 * bidirectional A→B / B→A transfer pair that `matchTransfers` already
 * auto-links correctly (its own comment: "Two accounts trading in both
 * directions is still fine — A→B and B→A consume disjoint rows and never
 * compete"). Stripping same-account pairs before the counting argument was
 * tried and rejected: it deletes all four rows of that shape and kills two real
 * auto-links.
 *
 * So neither queue gets to claim it silently. Both surface it, and the UI says
 * the row is also under the other heading — the ambiguity is the user's to
 * resolve, and pairing it once removes it from both.
 */
export function overlappingRowIds<T extends TransferCandidate>(
  a: AmbiguousBucket<T>[],
  b: AmbiguousBucket<T>[],
): Set<T["id"]> {
  const idsIn = (buckets: AmbiguousBucket<T>[]) =>
    new Set(buckets.flatMap((x) => [...x.positives, ...x.negatives].map((r) => r.id)));
  const inA = idsIn(a);
  const shared = new Set<T["id"]>();
  for (const id of idsIn(b)) if (inA.has(id)) shared.add(id);
  return shared;
}
