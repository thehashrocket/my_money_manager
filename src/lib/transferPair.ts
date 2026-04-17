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
): TransferPair<T>[] {
  const pairs: TransferPair<T>[] = [];
  const used = new Set<string | number>();

  const byDate = new Map<string, T[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }

  for (const sameDay of byDate.values()) {
    for (let i = 0; i < sameDay.length; i++) {
      const a = sameDay[i];
      if (used.has(a.id)) continue;
      const aNum = Number.parseInt(a.bankTransactionNumber, 10);
      if (!Number.isFinite(aNum)) continue;

      for (let j = i + 1; j < sameDay.length; j++) {
        const b = sameDay[j];
        if (used.has(b.id)) continue;
        if (a.accountId === b.accountId) continue;
        if (Math.abs(a.amountCents) !== Math.abs(b.amountCents)) continue;
        if (Math.sign(a.amountCents) === Math.sign(b.amountCents)) continue;
        if (a.amountCents === 0) continue;

        const bNum = Number.parseInt(b.bankTransactionNumber, 10);
        if (!Number.isFinite(bNum)) continue;
        if (Math.abs(aNum - bNum) !== 1) continue;

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
