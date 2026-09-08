import { describe, expect, it } from "vitest";
import {
  findSameAccountReversals,
  overlappingRowIds,
} from "./sameAccountReversals";
import type { TransferCandidate } from "./matchTransfers";

/**
 * Fixtures reproduce the real SHAPES measured on the live ledger 2026-09-08 —
 * the bank protocol tokens (`A2AXFER`, `SDAXFER`, `Zelle Transfer Payment ID`)
 * and the memo structure around them are what the matcher keys off, so those
 * are verbatim. Every identifying VALUE is synthetic: member/transfer numbers
 * are zeroed, payment ids are placeholder letters, and the ATM terminal and
 * street are fictional. This repo is public — see the note in CLAUDE.md's test
 * conventions; do not paste a real memo in here.
 *
 * The two coincidence cases are the reason this function has no auto-link path
 * at all, so they are pinned first.
 */

let seq = 0;
function row(
  opts: Partial<TransferCandidate> & { amountCents: number },
): TransferCandidate {
  seq += 1;
  return {
    id: opts.id ?? seq,
    accountId: opts.accountId ?? 1,
    date: opts.date ?? "2026-09-04",
    amountCents: opts.amountCents,
    rawMemo: opts.rawMemo ?? `MEMO-${seq}`,
  };
}

describe("findSameAccountReversals — the class no other matcher can see", () => {
  it("surfaces a same-account, same-day, equal-magnitude, opposite-sign pair", () => {
    const out = findSameAccountReversals([
      row({ id: 1300, accountId: 2, date: "2026-09-01", amountCents: -25000, rawMemo: "A2AXFER 000000000-1 Ref# 7F254" }),
      row({ id: 1299, accountId: 2, date: "2026-09-01", amountCents: 25000, rawMemo: "A2AXFER 000000000-1 Ref# 64590 reverse" }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("same-account");
    expect(out[0].date).toBe("2026-09-01");
    expect(out[0].absAmountCents).toBe(25000);
    expect(out[0].positives.map((r) => r.id)).toEqual([1299]);
    expect(out[0].negatives.map((r) => r.id)).toEqual([1300]);
  });

  it("ignores a cross-account pair — that is matchTransfers' job, not this one", () => {
    const out = findSameAccountReversals([
      row({ accountId: 1, amountCents: -25000 }),
      row({ accountId: 2, amountCents: 25000 }),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores a same-account pair on different dates", () => {
    const out = findSameAccountReversals([
      row({ accountId: 1, date: "2026-09-01", amountCents: -25000 }),
      row({ accountId: 1, date: "2026-09-02", amountCents: 25000 }),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores a same-account same-day pair whose magnitudes differ", () => {
    const out = findSameAccountReversals([
      row({ accountId: 1, amountCents: -25000 }),
      row({ accountId: 1, amountCents: 24000 }),
    ]);
    expect(out).toEqual([]);
  });

  it("ignores a bucket that is all one sign", () => {
    const out = findSameAccountReversals([
      row({ accountId: 1, amountCents: -1000 }),
      row({ accountId: 1, amountCents: -1000 }),
    ]);
    expect(out).toEqual([]);
  });

  it("does not pair a zero-amount row with itself", () => {
    const out = findSameAccountReversals([
      row({ accountId: 1, amountCents: 0 }),
      row({ accountId: 1, amountCents: 0 }),
    ]);
    expect(out).toEqual([]);
  });
});

describe("findSameAccountReversals — never auto-links, because the shape lies", () => {
  it("surfaces the $3.99 coincidence rather than linking it (real ledger, 2026-03-02)", () => {
    // "ATM Surcharge fees refund" against a genuine APPLE.COM/BILL charge of
    // the same amount on the same day. Auto-linking would delete a real $3.99
    // subscription charge from every spending surface.
    const out = findSameAccountReversals([
      row({ id: 982, accountId: 1, date: "2026-03-02", amountCents: 399, rawMemo: "ATM Surcharge fees refund" }),
      row({ id: 985, accountId: 1, date: "2026-03-02", amountCents: -399, rawMemo: "APPLE.COM/BILL CA" }),
    ]);

    // Returned for REVIEW — the function's whole contract is that it decides
    // nothing. There is no `pairs` field to accidentally consume.
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("same-account");
    expect(out[0]).not.toHaveProperty("pairs");
  });

  it("surfaces the $200 ATM coincidence rather than linking it (real ledger, 2026-06-05)", () => {
    const out = findSameAccountReversals([
      row({ id: 493, accountId: 1, date: "2026-06-05", amountCents: 20000, rawMemo: "Zelle Transfer Payment ID : AAAAAAAAAA" }),
      row({ id: 494, accountId: 1, date: "2026-06-05", amountCents: -20000, rawMemo: "ATM 0605 0000 000000 100 EXAMPLE ST" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].positives[0].id).toBe(493);
    expect(out[0].negatives[0].id).toBe(494);
  });

  it("surfaces a genuine merchandise refund too — pairing it would be wrong, and that is the user's call", () => {
    // Under the signed spend convention a refund correctly nets against spend
    // and stays visible. Pairing hides both legs. The queue must offer it and
    // must accept "no" as a durable answer (see the rejection test below).
    const out = findSameAccountReversals([
      row({ id: 1, accountId: 1, date: "2026-09-03", amountCents: 1175, rawMemo: "AMAZON MKTPLACE PMT Amzn.com/bill" }),
      row({ id: 1529, accountId: 1, date: "2026-09-03", amountCents: -1175, rawMemo: "AMAZON MKTPL*5Q7K15 Amzn.com/bill WA" }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("findSameAccountReversals — rejection is durable, but scoped to the pairing", () => {
  it("drops a one-vs-one bucket once its only pairing is rejected, so it stops nagging", () => {
    const a = row({ id: 1, accountId: 1, amountCents: 1175 });
    const b = row({ id: 2, accountId: 1, amountCents: -1175 });
    const isRejected = (x: TransferCandidate, y: TransferCandidate) =>
      (x.id === 1 && y.id === 2) || (x.id === 2 && y.id === 1);

    expect(findSameAccountReversals([a, b])).toHaveLength(1);
    expect(findSameAccountReversals([a, b], isRejected)).toEqual([]);
  });

  it("keeps a bucket alive when only ONE of several combinations is rejected", () => {
    // The real 2026-09-04 cluster: id 1531 is a candidate against 1532, 1533
    // and 1535 at $10.00. Rejecting one pairing says nothing about the others.
    const p = row({ id: 1531, accountId: 2, amountCents: 1000, rawMemo: "A2AXFER 000000000-1 Ref# BFA33 reverse" });
    const n1 = row({ id: 1532, accountId: 2, amountCents: -1000, rawMemo: "A2AXFER 000000000-1 Ref# 0AA08" });
    const n2 = row({ id: 1533, accountId: 2, amountCents: -1000, rawMemo: "Zelle Transfer Payment ID : BBBBBBBBBB" });
    const rejectedOnly1533 = (x: TransferCandidate, y: TransferCandidate) =>
      (x.id === 1531 && y.id === 1533) || (x.id === 1533 && y.id === 1531);

    const out = findSameAccountReversals([p, n1, n2], rejectedOnly1533);
    expect(out).toHaveLength(1);
    // Both negatives stay selectable — the queue offers the choice, the
    // rejection only rules out committing that one combination.
    expect(out[0].negatives.map((r) => r.id).sort()).toEqual([1532, 1533]);
  });

  it("drops the bucket only when EVERY combination is rejected", () => {
    const p = row({ id: 1, accountId: 1, amountCents: 1000 });
    const n1 = row({ id: 2, accountId: 1, amountCents: -1000 });
    const n2 = row({ id: 3, accountId: 1, amountCents: -1000 });
    const all = () => true;
    expect(findSameAccountReversals([p, n1, n2], all)).toEqual([]);
  });
});

describe("findSameAccountReversals — bucketing and ordering", () => {
  it("keys buckets by account, so two accounts with the same date and amount stay separate", () => {
    const out = findSameAccountReversals([
      row({ id: 1, accountId: 1, date: "2026-09-04", amountCents: 1000 }),
      row({ id: 2, accountId: 1, date: "2026-09-04", amountCents: -1000 }),
      row({ id: 3, accountId: 2, date: "2026-09-04", amountCents: 1000 }),
      row({ id: 4, accountId: 2, date: "2026-09-04", amountCents: -1000 }),
    ]);
    expect(out).toHaveLength(2);
    for (const bucket of out) {
      const accounts = new Set([
        ...bucket.positives.map((r) => r.accountId),
        ...bucket.negatives.map((r) => r.accountId),
      ]);
      expect(accounts.size).toBe(1);
    }
  });

  it("returns newest first, with a total order so the queue does not reshuffle", () => {
    const rows = [
      row({ id: 1, accountId: 1, date: "2026-09-01", amountCents: 500 }),
      row({ id: 2, accountId: 1, date: "2026-09-01", amountCents: -500 }),
      row({ id: 3, accountId: 1, date: "2026-09-04", amountCents: 1000 }),
      row({ id: 4, accountId: 1, date: "2026-09-04", amountCents: -1000 }),
      row({ id: 5, accountId: 1, date: "2026-09-04", amountCents: 9000 }),
      row({ id: 6, accountId: 1, date: "2026-09-04", amountCents: -9000 }),
    ];
    const expected = findSameAccountReversals(rows).map(
      (b) => `${b.date}|${b.absAmountCents}`,
    );

    expect(expected).toEqual(["2026-09-04|9000", "2026-09-04|1000", "2026-09-01|500"]);
    // Stable regardless of input order — a queue whose order depends on row
    // arrival is one the user cannot build a habit around.
    expect(
      findSameAccountReversals([...rows].reverse()).map(
        (b) => `${b.date}|${b.absAmountCents}`,
      ),
    ).toEqual(expected);
  });
});

describe("findSameAccountReversals — the remaining bucket shapes", () => {
  it("ignores a bucket that is all POSITIVE, not just all negative", () => {
    // Two credits of the same size on one day (a duplicated refund) is a real
    // shape, and the `negatives.length === 0` half of the guard is the only
    // thing stopping it being offered as a pairing with nothing to pair to.
    const out = findSameAccountReversals([
      row({ accountId: 1, amountCents: 1000 }),
      row({ accountId: 1, amountCents: 1000 }),
    ]);
    expect(out).toEqual([]);
  });

  it("skips a zero-amount row without disturbing a real bucket sharing its account and date", () => {
    // The zero skip happens before bucketing, so it must not take the day's
    // genuine candidates with it.
    const out = findSameAccountReversals([
      row({ id: 1, accountId: 1, date: "2026-09-04", amountCents: 0 }),
      row({ id: 2, accountId: 1, date: "2026-09-04", amountCents: 2500 }),
      row({ id: 3, accountId: 1, date: "2026-09-04", amountCents: -2500 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].absAmountCents).toBe(2500);
    expect([...out[0].positives, ...out[0].negatives].map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it("breaks a date+amount tie on account, so two accounts never reshuffle between renders", () => {
    // Same date, same amount, different accounts — the third sort key, which
    // nothing else reaches. It is a String compare (a stability device, not a
    // numeric ordering: account 10 sorts before account 2), and the contract
    // is only that it is TOTAL and input-order-independent.
    const rows = [
      row({ id: 1, accountId: 2, date: "2026-09-04", amountCents: 1000 }),
      row({ id: 2, accountId: 2, date: "2026-09-04", amountCents: -1000 }),
      row({ id: 3, accountId: 10, date: "2026-09-04", amountCents: 1000 }),
      row({ id: 4, accountId: 10, date: "2026-09-04", amountCents: -1000 }),
    ];

    const order = (input: TransferCandidate[]) =>
      findSameAccountReversals(input).map((b) => b.positives[0].accountId);

    expect(order(rows)).toEqual([10, 2]);
    expect(order([...rows].reverse())).toEqual([10, 2]);
  });

  it("returns buckets carrying every candidate, so the queue can offer the choice", () => {
    // One credit against three same-amount debits: the function must NOT pick
    // one. Every candidate has to reach the select or the user is choosing
    // from a shortlist someone else made on evidence that does not exist.
    const p = row({ id: 100, accountId: 1, amountCents: 1000 });
    const negs = [201, 202, 203].map((id) => row({ id, accountId: 1, amountCents: -1000 }));

    const out = findSameAccountReversals([p, ...negs]);
    expect(out).toHaveLength(1);
    expect(out[0].positives.map((r) => r.id)).toEqual([100]);
    expect(out[0].negatives.map((r) => r.id).sort()).toEqual([201, 202, 203]);
  });

  it("returns an empty list for an empty input", () => {
    expect(findSameAccountReversals([])).toEqual([]);
  });
});

/**
 * The two review queues bucket on different keys, and `matchTransfers`'
 * same-account exclusion is a per-BUCKET test rather than a per-row one, so one
 * transaction can legitimately be claimed by both. Measured live 2026-09-08:
 * 1 of 14 buckets. That overlap is NOT resolvable by dropping rows from either
 * side (see the docstring), so it is surfaced instead — and these pin that the
 * detection is exact rather than approximate.
 */
describe("overlappingRowIds", () => {
  const bucket = (positives: TransferCandidate[], negatives: TransferCandidate[]) => ({
    date: positives[0]?.date ?? negatives[0].date,
    absAmountCents: Math.abs((positives[0] ?? negatives[0]).amountCents),
    positives,
    negatives,
    reason: "unbalanced" as const,
  });

  it("returns the ids claimed by both queues and nothing else", () => {
    const shared = row({ id: 900, accountId: 1, amountCents: 1000 });
    const onlyA = row({ id: 901, accountId: 2, amountCents: -1000 });
    const onlyB = row({ id: 902, accountId: 1, amountCents: -1000 });

    const out = overlappingRowIds(
      [bucket([shared], [onlyA])],
      [bucket([shared], [onlyB])],
    );

    expect([...out]).toEqual([900]);
  });

  it("is empty when the queues are disjoint", () => {
    const a = row({ id: 910, accountId: 1, amountCents: 1000 });
    const b = row({ id: 911, accountId: 2, amountCents: -1000 });
    const c = row({ id: 912, accountId: 3, amountCents: 2000 });
    const d = row({ id: 913, accountId: 3, amountCents: -2000 });

    expect([...overlappingRowIds([bucket([a], [b])], [bucket([c], [d])])]).toEqual([]);
  });

  it("matches on row id, not on bucket identity — the two queues bucket differently", () => {
    // The live shape: one date+amount where account 1 holds a +/- pair AND
    // account 2 contributes a row. The transfers queue sees one 3-row bucket;
    // the reversals queue sees a 2-row bucket keyed by account. Different
    // buckets, overlapping rows.
    const p1 = row({ id: 920, accountId: 1, amountCents: 1000 });
    const n1 = row({ id: 921, accountId: 1, amountCents: -1000 });
    const n2 = row({ id: 922, accountId: 2, amountCents: -1000 });

    const out = overlappingRowIds(
      [bucket([p1], [n1, n2])], // transfers queue: whole date+amount
      [bucket([p1], [n1])], //     reversals queue: account 1 only
    );

    expect([...out].sort((x, y) => String(x).localeCompare(String(y)))).toEqual([920, 921]);
    expect(out.has(922)).toBe(false);
  });
});
