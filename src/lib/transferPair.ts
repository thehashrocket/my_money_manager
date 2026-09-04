export type PairCandidate = {
  id: string | number;
  accountId: string | number;
  date: string;
  amountCents: number;
  bankTransactionNumber: string;
  rawMemo?: string;
};

export type TransferPair<T extends PairCandidate> = {
  a: T;
  b: T;
  confidence: "certain" | "high";
};

const OVERDRAFT_MEMOS = /^(DEPOSIT-OVERDRAFT|WITHDRAWAL-OVERDRAFT)\s*$/i;

function memoConfirmsOverdraft(row: PairCandidate): boolean {
  return !!row.rawMemo && OVERDRAFT_MEMOS.test(row.rawMemo.trim());
}

export function findTransferPairs<T extends PairCandidate>(
  rows: T[],
  memoConfirms: (row: T) => boolean = memoConfirmsOverdraft,
  // Checked BEFORE committing to a candidate (pushing to pairs / marking
  // used), not after: a `.filter()` over the returned pairs would still let
  // the greedy `used.add()` below consume a row on a rejected match, so a
  // real partner sitting right after it in the same bucket would never even
  // be tried. Default is "nothing is rejected" so every other caller (and
  // every existing test) is unaffected.
  isRejected: (a: T, b: T) => boolean = () => false,
): TransferPair<T>[] {
  const pairs: TransferPair<T>[] = [];
  const used = new Set<string | number>();

  // Bucket by (date, |amount|) so pair candidates share date and absolute amount
  // by construction. Collapses the O(N²) same-day scan to O(N) across buckets
  // of size 2–3 in real data.
  const byDateAndAbsAmount = new Map<string, T[]>();
  for (const r of rows) {
    if (r.amountCents === 0) continue;
    const key = `${r.date}|${Math.abs(r.amountCents)}`;
    const list = byDateAndAbsAmount.get(key) ?? [];
    list.push(r);
    byDateAndAbsAmount.set(key, list);
  }

  for (const bucket of byDateAndAbsAmount.values()) {
    if (bucket.length < 2) continue;

    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      if (used.has(a.id)) continue;
      const aNum = Number.parseInt(a.bankTransactionNumber, 10);
      if (!Number.isFinite(aNum)) continue;

      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        if (used.has(b.id)) continue;
        if (a.accountId === b.accountId) continue;
        if (Math.sign(a.amountCents) === Math.sign(b.amountCents)) continue;

        const bNum = Number.parseInt(b.bankTransactionNumber, 10);
        if (!Number.isFinite(bNum)) continue;
        if (Math.abs(aNum - bNum) !== 1) continue;
        if (isRejected(a, b)) continue;

        const confirmed = memoConfirms(a) || memoConfirms(b);
        pairs.push({ a, b, confidence: confirmed ? "certain" : "high" });
        used.add(a.id);
        used.add(b.id);
        break;
      }
    }
  }

  return pairs;
}
