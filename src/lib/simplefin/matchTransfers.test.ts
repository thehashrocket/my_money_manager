import { describe, it, expect } from "vitest";
import { matchTransfers, isAtmWithdrawal, isOverdraftLabeled } from "./matchTransfers";

const CHK = 1;
const SAV = 2;

let seq = 0;
function row(
  accountId: number,
  amountCents: number,
  rawMemo: string,
  date = "2026-09-01",
) {
  return { id: ++seq, accountId, date, amountCents, rawMemo };
}

describe("matchTransfers", () => {
  it("links a clean one-to-one overdraft sweep with certainty", () => {
    const sweep = row(SAV, -20000, "WITHDRAWAL-OVERDRAFT");
    const inbound = row(CHK, 20000, "POS 0902 1340 815925 AIRBNB * TA9RWYS3 AIRBNB.COM CA");

    const { pairs, ambiguous } = matchTransfers([sweep, inbound]);

    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
    // The overdraft label is what "certain" used to encode; it now decides the
    // cross-source guard rather than being stored on the pair.
    expect(
      isOverdraftLabeled(pairs[0].a) || isOverdraftLabeled(pairs[0].b),
    ).toBe(true);
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual(
      [sweep.id, inbound.id].sort(),
    );
  });

  it("links a balanced N-vs-N bucket without asking, since every bijection is equivalent", () => {
    // The real 2026-09-01 case: two $100 sweeps against two $100 inbound rows.
    // Which pairs with which is cosmetic — the budget is identical either way.
    const rows = [
      row(SAV, -10000, "WITHDRAWAL-OVERDRAFT"),
      row(SAV, -10000, "WITHDRAWAL-OVERDRAFT"),
      row(CHK, 10000, "POS 0831 2021 718514 COSTCO GAS #1031 MANTECA CA"),
      row(CHK, 10000, "POS 0901 1026 797230 SAVEMART #12 MA MANTECA"),
    ];

    const { pairs, ambiguous } = matchTransfers(rows);

    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(2);
    // Every row got used exactly once.
    expect(new Set(pairs.flatMap((p) => [p.a.id, p.b.id])).size).toBe(4);
  });

  it("excludes ATM cash withdrawals, which rebalances a bucket they collided with", () => {
    // Real 2026-08-22 case: without the ATM exclusion this is 1-vs-2 and needs
    // a human; with it, it is 1-vs-1 and links itself.
    const rows = [
      row(CHK, 20000, "POS 0821 1816 944295 FSP*DYING BRE"),
      row(SAV, -20000, "WITHDRAWAL-OVERDRAFT"),
      row(SAV, -20000, "ATM 0822 0658 043971 1419 J STREET MODESTO CA Ca"),
    ];

    const { pairs, ambiguous } = matchTransfers(rows);

    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a.rawMemo).toContain("FSP*DYING BRE");
    expect(pairs[0].b.rawMemo).toBe("WITHDRAWAL-OVERDRAFT");
  });

  it("surfaces a genuinely unbalanced bucket instead of guessing", () => {
    // Real 2026-07-24 Instant Pay reversal tangle.
    const rows = [
      row(CHK, 10000, "Instant Pay Reversal ID: 688334332", "2026-07-24"),
      row(CHK, 10000, "Instant Pay Reversal ID: 682925323", "2026-07-24"),
      row(SAV, -10000, "Instant Pay ID: 686992392779796737", "2026-07-24"),
    ];

    const { pairs, ambiguous } = matchTransfers(rows);

    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].date).toBe("2026-07-24");
    expect(ambiguous[0].absAmountCents).toBe(10000);
    expect(ambiguous[0].positives).toHaveLength(2);
    expect(ambiguous[0].negatives).toHaveLength(1);
  });

  it("ignores a same-account charge that merely shares the sweep's amount", () => {
    // Real 2026-09-02 case, and the one that broke a global positive-vs-negative
    // count: the -$200 Airbnb charge is the purchase that TRIGGERED the sweep,
    // sitting in checking alongside the +$200 inbound leg. It can never pair
    // with it, so it must not be counted when deciding whether this balances.
    const inbound = row(CHK, 20000, "POS 0902 1340 815925 AIRBNB * TA9RWYS3 AIRBNB.COM CA");
    const charge = row(CHK, -20000, "AIRBNB * TA9RWYS3 AIRBNB.COM CA Card #:8568");
    const sweep = row(SAV, -20000, "WITHDRAWAL-OVERDRAFT");

    const { pairs, ambiguous } = matchTransfers([inbound, charge, sweep]);

    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual([inbound.id, sweep.id].sort());
    // The charge stays unpaired — it is real spending.
    expect(pairs.flatMap((p) => [p.a.id, p.b.id])).not.toContain(charge.id);
  });

  it("links two same-day transfers running in opposite directions", () => {
    const { pairs, ambiguous } = matchTransfers([
      row(CHK, 10000, "POS 0901 1026 797230 SAVEMART #12 MA MANTECA"),
      row(SAV, -10000, "WITHDRAWAL-OVERDRAFT"),
      row(SAV, 10000, "SDAXFER 125506980-1 Ref# 137C2"),
      row(CHK, -10000, "SDAXFER 125506980-2 Ref# A1B24"),
    ]);
    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.a.accountId !== p.b.accountId)).toBe(true);
  });

  it("never pairs a refund inside a single account", () => {
    const rows = [
      row(CHK, 4500, "AMAZON MKTPLACE PMT Amzn.com/bill WA Card #:8568"),
      row(CHK, -4500, "AMAZON MKTPLACE PMT Amzn.com/bill WA Card #:8568"),
    ];

    const { pairs, ambiguous } = matchTransfers(rows);

    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });

  it("does not pair across different dates or different amounts", () => {
    const { pairs } = matchTransfers([
      row(SAV, -10000, "WITHDRAWAL-OVERDRAFT", "2026-09-01"),
      row(CHK, 10000, "POS 0902 1340 111111 SOMETHING", "2026-09-02"),
      row(CHK, 9900, "POS 0901 1340 222222 SOMETHING", "2026-09-01"),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it("marks a balanced pair with no overdraft label as high, not certain", () => {
    const { pairs } = matchTransfers([
      row(SAV, -50000, "Online 08/12/2026 14:51:18 MEMO: House payment Ref# 5AC74"),
      row(CHK, 50000, "SDAXFER 125506980-1 Ref# 137C2"),
    ]);
    expect(pairs).toHaveLength(1);
    // Linked on counting alone, with no memo corroboration on either leg.
    expect(
      isOverdraftLabeled(pairs[0].a) || isOverdraftLabeled(pairs[0].b),
    ).toBe(false);
  });

  it("refuses to guess when a third account makes the partner account ambiguous", () => {
    // A +$100 in checking with matching −$100 in TWO different accounts: the
    // counting argument says nothing about WHICH account the money came from,
    // so this must reach a human rather than silently linking the first one.
    const SAV2 = 3;
    const inbound = row(CHK, 10000, "POS 0901 1026 797230 SAVEMART #12 MA MANTECA");
    const sweepA = row(SAV, -10000, "WITHDRAWAL-OVERDRAFT");
    const sweepB = row(SAV2, -10000, "WITHDRAWAL-OVERDRAFT");

    const { pairs, ambiguous } = matchTransfers([inbound, sweepA, sweepB]);

    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].positives).toHaveLength(1);
    expect(ambiguous[0].negatives).toHaveLength(2);
  });

  it("refuses to guess when two accounts both could have funded one withdrawal", () => {
    // Mirror of the case above with the contest on the other side: a single
    // −$100 with TWO candidate inbound accounts is equally undecidable.
    const CHK2 = 4;
    const { pairs, ambiguous } = matchTransfers([
      row(CHK, 10000, "POS 0901 1026 797230 SAVEMART #12 MA MANTECA"),
      row(CHK2, 10000, "POS 0901 1055 118220 COSTCO GAS #1031 MANTECA CA"),
      row(SAV, -10000, "WITHDRAWAL-OVERDRAFT"),
    ]);

    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].positives).toHaveLength(2);
    expect(ambiguous[0].negatives).toHaveLength(1);
  });

  it("ignores zero-amount rows", () => {
    const { pairs, ambiguous } = matchTransfers([
      row(SAV, 0, "WITHDRAWAL-OVERDRAFT"),
      row(CHK, 0, "POS 0902 1340 815925 SOMETHING"),
    ]);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });
});

describe("label helpers", () => {
  it("recognises both overdraft leg labels", () => {
    expect(isOverdraftLabeled({ rawMemo: "WITHDRAWAL-OVERDRAFT" } as never)).toBe(true);
    expect(isOverdraftLabeled({ rawMemo: "DEPOSIT-OVERDRAFT" } as never)).toBe(true);
    expect(isOverdraftLabeled({ rawMemo: "COSTCO GAS MANTECA" } as never)).toBe(false);
  });

  it("recognises the ATM prefix without catching merchants that merely start with ATM", () => {
    expect(
      isAtmWithdrawal({ rawMemo: "ATM 0822 0658 043971 1419 J STREET" } as never),
    ).toBe(true);
    expect(isAtmWithdrawal({ rawMemo: "ATMOSPHERE COFFEE MANTECA CA" } as never)).toBe(
      false,
    );
  });
});

/**
 * The counting argument cannot distinguish a real transfer pair from a same-day,
 * same-amount coincidence. Between two feed rows that risk is accepted (it is
 * what the 56-pair result was measured on). Against a CSV row carrying a bank
 * transaction number it is not: the ±1 matcher is a strictly stronger signal and
 * already declined to pair that row.
 */
describe("cross-source candidacy guard", () => {
  const csv = (accountId: number, amountCents: number, memo: string) => ({
    ...row(accountId, amountCents, memo),
    adjudicatedByTxnNumber: true,
  });
  const feed = (accountId: number, amountCents: number, memo: string) => ({
    ...row(accountId, amountCents, memo),
    adjudicatedByTxnNumber: false,
  });

  it("asks instead of guessing when an uncorroborated pair spans two sources", () => {
    const { pairs, ambiguous } = matchTransfers([
      feed(CHK, -5000, "SAFEWAY 2231 MANTECA CA"),
      csv(SAV, 5000, "DIVIDEND"),
    ]);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
  });

  it("asks instead of guessing when BOTH legs are CSV-adjudicated and uncorroborated — the strongest evidence against, not the weakest", () => {
    // The ±1 matcher already looked at both of these rows and declined to
    // pair them. An XOR guard (`a.adjudicatedByTxnNumber !== b...`) would
    // treat "both adjudicated" the same as "neither adjudicated" and
    // auto-link this — exactly backwards, since two declined rows is a
    // stronger signal against a real transfer than two untouched feed rows.
    const { pairs, ambiguous } = matchTransfers([
      csv(CHK, -5000, "SAFEWAY 2231 MANTECA CA"),
      csv(SAV, 5000, "DIVIDEND"),
    ]);
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
  });

  it("still auto-links a cross-source pair the memo corroborates", () => {
    const { pairs, ambiguous } = matchTransfers([
      feed(CHK, 10000, "POS 0902 1340 AIRBNB.COM CA"),
      csv(SAV, -10000, "WITHDRAWAL-OVERDRAFT"),
    ]);
    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
  });

  it("leaves same-source pairing untouched — this is where 56/58 was measured", () => {
    const { pairs, ambiguous } = matchTransfers([
      feed(CHK, 50000, "SDAXFER 125506980-1 Ref# 137C2"),
      feed(SAV, -50000, "Online 08/12/2026 MEMO: House payment"),
    ]);
    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(1);
  });

  it("treats rows with no flag at all as same-source, so existing callers are unaffected", () => {
    const { pairs } = matchTransfers([
      row(CHK, 2500, "A"),
      row(SAV, -2500, "B"),
    ]);
    expect(pairs).toHaveLength(1);
  });
});

// Codex structured review (`/ship` 2026-09-04): a naive post-filter over the
// returned pairs would still let the bijection consume a rejected edge
// before the caller ever sees it, silently dropping an otherwise-valid pair
// for the OTHER rows in the same balanced bucket. isRejected is threaded
// into the matching itself so it can pick a different, non-rejected bijection.
describe("matchTransfers — isRejected", () => {
  it("a 1-vs-1 bucket whose only pairing is rejected becomes ambiguous, not silently dropped", () => {
    const a = row(CHK, -5000, "A");
    const b = row(SAV, 5000, "B");
    const { pairs, ambiguous } = matchTransfers(
      [a, b],
      (x, y) => (x.id === a.id && y.id === b.id) || (x.id === b.id && y.id === a.id),
    );
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].positives.map((r) => r.id)).toEqual([b.id]);
    expect(ambiguous[0].negatives.map((r) => r.id)).toEqual([a.id]);
  });

  it("a 2-vs-2 balanced bucket finds the non-rejected bijection instead of dropping everything", () => {
    // a would naively pair with x (preferred order), but that combination is
    // rejected. The real bijection-avoidance case: a valid assignment still
    // exists (a-y, b-x) and must be found instead of giving up.
    const a = row(CHK, -3000, "A");
    const b = row(CHK, -3000, "B");
    const x = row(SAV, 3000, "X");
    const y = row(SAV, 3000, "Y");
    const { pairs, ambiguous } = matchTransfers(
      [a, b, x, y],
      (p, q) => (p.id === a.id && q.id === x.id) || (p.id === x.id && q.id === a.id),
    );
    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(2);
    const byA = pairs.find((p) => p.a.id === a.id || p.b.id === a.id)!;
    expect([byA.a.id, byA.b.id]).toContain(y.id);
    expect([byA.a.id, byA.b.id]).not.toContain(x.id);
  });

  it("a 2-vs-2 bucket where EVERY bijection hits a rejection becomes fully ambiguous", () => {
    const a = row(CHK, -4000, "A");
    const b = row(CHK, -4000, "B");
    const x = row(SAV, 4000, "X");
    const y = row(SAV, 4000, "Y");
    // a is rejected against BOTH x and y, so neither bijection — (a-x,b-y)
    // nor (a-y,b-x) — has a valid slot left for a.
    const { pairs, ambiguous } = matchTransfers(
      [a, b, x, y],
      (p, q) =>
        (p.id === a.id && (q.id === x.id || q.id === y.id)) ||
        (q.id === a.id && (p.id === x.id || p.id === y.id)),
    );
    expect(pairs).toHaveLength(0);
    expect(ambiguous).toHaveLength(1);
  });

  it("default isRejected (omitted) never rejects anything — existing callers unaffected", () => {
    const { pairs } = matchTransfers([row(CHK, -1000, "A"), row(SAV, 1000, "B")]);
    expect(pairs).toHaveLength(1);
  });

  // The 2-vs-2 test above only exercises a single try-next-candidate step.
  // This exercises real BACKTRACKING: p1's preferred (first-tried) partner
  // works fine locally, but committing to it leaves p2 with no valid partner
  // at all — assignAvoidingRejections must undo that choice (pop the
  // assignment, restore the candidate to `remaining`) and retry p1 against a
  // different negative before the recursion can succeed.
  it("a 3-vs-3 bucket finds a valid assignment that requires backtracking off an initially-successful choice", () => {
    const p1 = row(SAV, 3000, "P1");
    const p2 = row(SAV, 3000, "P2");
    const p3 = row(SAV, 3000, "P3");
    const n1 = row(CHK, -3000, "N1");
    const n2 = row(CHK, -3000, "N2");
    const n3 = row(CHK, -3000, "N3");
    // p2 can ONLY pair with n1 — but greedy preferred order tries p1-n1
    // first, which succeeds locally and must be undone.
    const isRejected = (a: ReturnType<typeof row>, b: ReturnType<typeof row>) =>
      (a.id === p2.id && (b.id === n2.id || b.id === n3.id)) ||
      (b.id === p2.id && (a.id === n2.id || a.id === n3.id));

    const { pairs, ambiguous } = matchTransfers([p1, p2, p3, n1, n2, n3], isRejected);

    expect(ambiguous).toHaveLength(0);
    expect(pairs).toHaveLength(3);
    const byP2 = pairs.find((p) => p.a.id === p2.id || p.b.id === p2.id)!;
    expect([byP2.a.id, byP2.b.id]).toContain(n1.id);
    // p1 was forced off its preferred n1 by the backtrack.
    const byP1 = pairs.find((p) => p.a.id === p1.id || p.b.id === p1.id)!;
    expect([byP1.a.id, byP1.b.id]).not.toContain(n1.id);
  });
});
