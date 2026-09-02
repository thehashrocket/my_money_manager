/**
 * Transfer-pair matching for SimpleFIN rows.
 *
 * The CSV matcher (src/lib/transferPair.ts) keys on Star One's sequential
 * Transaction Number: |txn_a - txn_b| === 1 uniquely identifies a pair. The
 * SimpleFIN feed has no transaction number and no `extra` object, so that rule
 * cannot be ported — see the "SimpleFIN Star One feed shape" note.
 *
 * What replaces it is a counting argument. Bucket rows by (date, |amount|,
 * opposite sign, cross-account). When a bucket holds N positives and N
 * negatives, EVERY bijection between them excludes exactly the same rows from
 * spending, so which row pairs with which is cosmetic — the budget is identical
 * either way and the bucket can be linked without asking. Only a bucket whose
 * counts do not balance is genuinely undecidable.
 *
 * Measured on a real 90-day pull: 56 pairs auto-link and a single day is left
 * undecidable. Three refinements do that work — excluding ATM cash withdrawals
 * from candidacy (never transfer legs, but they collide on the round amounts
 * sweeps use), counting per account-pair direction rather than across the whole
 * bucket, and refusing to guess when a row has candidate partners in more than
 * one account.
 */
export type TransferCandidate = {
  id: string | number;
  accountId: string | number;
  date: string;
  amountCents: number;
  rawMemo: string;
};

export type MatchedPair<T extends TransferCandidate> = {
  a: T;
  b: T;
  confidence: "certain" | "high";
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
        for (let i = 0; i < positives.length; i++) {
          const a = positives[i];
          const b = ordered[i];
          used.add(a.id);
          used.add(b.id);
          pairs.push({
            a,
            b,
            confidence:
              isOverdraftLabeled(a) || isOverdraftLabeled(b) ? "certain" : "high",
          });
        }
      }
    }
  }

  return { pairs, ambiguous };
}
