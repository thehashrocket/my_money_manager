/**
 * Transfer-pair matching for SimpleFIN rows.
 *
 * The CSV matcher (src/lib/transferPair.ts) keys on Star One's sequential
 * Transaction Number: |txn_a - txn_b| === 1 uniquely identifies a pair. The
 * SimpleFIN feed has no transaction number and no `extra` object, so that rule
 * cannot be ported — see the "SimpleFIN Star One feed shape" note.
 *
 * What replaces it is a counting argument. Rows are bucketed on (date,
 * |amount|) — the key is only those two fields; opposite sign and
 * cross-account are applied as filters within each bucket below, not as part of
 * the key. When a bucket holds N positives and N negatives, EVERY bijection
 * between them excludes exactly the same rows from spending, so which row pairs
 * with which is cosmetic — the budget is identical either way and the bucket can
 * be linked without asking. Only a bucket whose counts do not balance is
 * genuinely undecidable.
 *
 * Measured on a real 90-day pull: 56 pairs auto-link and a single day is left
 * undecidable. TWO refinements produce that result:
 *   1. ATM cash withdrawals are excluded from candidacy (never transfer legs,
 *      but they collide on the round amounts sweeps use). Removing this takes
 *      the undecidable buckets from 2 to 4.
 *   2. Counts are compared per account-pair direction, not across the whole
 *      bucket.
 *
 * The third guard below — refusing to guess when a row has candidate partners in
 * more than one ACCOUNT — is forward-looking defence, not part of that measured
 * result. It can only fire with 3+ accounts in a single bucket, and this app's
 * checking|savings enum plus the deliberately-unlinked mortgage means only two
 * accounts ever carry rows. Removing it changes nothing on the real data
 * (verified: still 56 pairs, still 1 undecidable day). Keep it, but do not read
 * it as load-bearing today.
 */
export type TransferCandidate = {
  id: string | number;
  accountId: string | number;
  date: string;
  amountCents: number;
  rawMemo: string;
  /**
   * True when the row carries a bank transaction number — i.e. it came from CSV
   * and the ±1 matcher in src/lib/transferPair.ts has ALREADY examined it and
   * declined to pair it. See the cross-source guard below.
   */
  adjudicatedByTxnNumber?: boolean;
};

/**
 * No `confidence` field. The previous one was computed for every pair and read
 * by nothing outside tests, so it asserted a distinction nothing could rely on.
 * The certain/high signal now does real work instead — it decides the
 * cross-source guard below. To surface it in the UI later, persist it as a
 * transfer_confidence column rather than reviving a field with no consumer.
 */
export type MatchedPair<T extends TransferCandidate> = {
  a: T;
  b: T;
};

export type AmbiguousBucket<T extends TransferCandidate> = {
  date: string;
  absAmountCents: number;
  positives: T[];
  negatives: T[];
};

export type MatchResult<T extends TransferCandidate> = {
  pairs: MatchedPair<T>[];
  ambiguous: AmbiguousBucket<T>[];
};

/** Star One labels the SENDING leg of an overdraft sweep reliably. */
const OVERDRAFT_MEMO = /(DEPOSIT|WITHDRAWAL)-OVERDRAFT/i;

/**
 * ATM cash withdrawals are never a transfer leg, but they land on the same
 * round $100 amounts the overdraft sweeps use and so collide in the bucket.
 * Excluding them is what turns two unbalanced buckets back into balanced ones.
 */
const ATM_PREFIX = /^ATM\s+\d{4}\s+\d{4}\s+\d+/i;

export function isOverdraftLabeled(row: TransferCandidate): boolean {
  return OVERDRAFT_MEMO.test(row.rawMemo ?? "");
}

export function isAtmWithdrawal(row: TransferCandidate): boolean {
  return ATM_PREFIX.test((row.rawMemo ?? "").trim());
}

export function matchTransfers<T extends TransferCandidate>(
  rows: T[],
): MatchResult<T> {
  const buckets = new Map<string, T[]>();
  for (const r of rows) {
    if (r.amountCents === 0) continue;
    if (isAtmWithdrawal(r)) continue;
    const key = `${r.date}|${Math.abs(r.amountCents)}`;
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }

  const pairs: MatchedPair<T>[] = [];
  const ambiguous: AmbiguousBucket<T>[] = [];

  for (const [key, bucket] of buckets) {
    const [date, absStr] = key.split("|");
    const absAmountCents = Number(absStr);

    const accountIds = [...new Set(bucket.map((r) => r.accountId))];
    // A positive and a negative of the same size inside ONE account is a
    // refund, not a transfer.
    if (accountIds.length < 2) continue;

    // With three or more accounts a row can have more than one plausible partner
    // ACCOUNT, and the counting argument stops holding: taking the first
    // direction found would silently guess which account the money moved
    // between. Only a bucket where each side has exactly one candidate
    // counterpart is decidable. Two accounts trading in both directions is
    // still fine — A→B and B→A consume disjoint rows and never compete.
    const positiveAccounts = new Set(
      bucket.filter((r) => r.amountCents > 0).map((r) => r.accountId),
    );
    const negativeAccounts = new Set(
      bucket.filter((r) => r.amountCents < 0).map((r) => r.accountId),
    );
    const counterpartsOf = (id: T["accountId"], others: Set<T["accountId"]>) =>
      [...others].filter((o) => o !== id).length;
    const contested =
      [...positiveAccounts].some((p) => counterpartsOf(p, negativeAccounts) > 1) ||
      [...negativeAccounts].some((n) => counterpartsOf(n, positiveAccounts) > 1);

    if (contested) {
      ambiguous.push({
        date,
        absAmountCents,
        positives: bucket.filter((r) => r.amountCents > 0),
        negatives: bucket.filter((r) => r.amountCents < 0),
      });
      continue;
    }

    const used = new Set<string | number>();

    // Count per (positive account -> negative account) direction, never
    // globally. A charge sitting in the SAME account as an inbound sweep — the
    // purchase that triggered the overdraft — is not a candidate for it, so
    // counting it would wrongly make a balanced bucket look undecidable.
    for (const posAccount of accountIds) {
      for (const negAccount of accountIds) {
        if (posAccount === negAccount) continue;

        const positives = bucket.filter(
          (r) => r.accountId === posAccount && r.amountCents > 0 && !used.has(r.id),
        );
        const negatives = bucket.filter(
          (r) => r.accountId === negAccount && r.amountCents < 0 && !used.has(r.id),
        );
        if (positives.length === 0 || negatives.length === 0) continue;

        if (positives.length !== negatives.length) {
          ambiguous.push({ date, absAmountCents, positives, negatives });
          continue;
        }

        // Counts balance, so every bijection is financially identical. Order the
        // overdraft-labelled legs first purely so the stored pairing reads
        // sensibly to a human later.
        const ordered = [...negatives].sort(
          (x, y) => Number(isOverdraftLabeled(y)) - Number(isOverdraftLabeled(x)),
        );
        const candidates = positives.map((a, i) => ({ a, b: ordered[i] }));

        // Cross-source guard. The counting argument is sound only when the rows
        // in a bucket really are transfer legs; it has no way to tell a genuine
        // pair from a same-day, same-amount coincidence. That is an acceptable
        // risk between two feed rows, which is what the 56-pair result was
        // measured on. It is NOT acceptable when one leg came from CSV and
        // carries a bank transaction number, because the ±1 matcher — a strictly
        // stronger signal — already looked at that row and declined to pair it.
        // Overriding it on a coincidence would silently drop two real
        // transactions out of every spending view.
        //
        // So an uncorroborated cross-source pair asks instead of guessing. The
        // whole direction is diverted, never a subset: linking some pairs and
        // querying others would break the very bijection-equivalence the
        // counting argument rests on.
        const uncorroboratedCrossSource = candidates.some(
          ({ a, b }) =>
            a.adjudicatedByTxnNumber !== b.adjudicatedByTxnNumber &&
            !isOverdraftLabeled(a) &&
            !isOverdraftLabeled(b),
        );
        if (uncorroboratedCrossSource) {
          ambiguous.push({ date, absAmountCents, positives, negatives });
          continue;
        }

        for (const { a, b } of candidates) {
          used.add(a.id);
          used.add(b.id);
          pairs.push({ a, b });
        }
      }
    }
  }

  return { pairs, ambiguous };
}
