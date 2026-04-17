import { describe, it, expect } from "vitest";
import { findTransferPairs, type PairCandidate } from "./transferPair";

const row = (overrides: Partial<PairCandidate> & Pick<PairCandidate, "id" | "accountId" | "bankTransactionNumber" | "amountCents">): PairCandidate => ({
  date: "2026-04-10",
  ...overrides,
});

describe("findTransferPairs", () => {
  it("pairs two rows with txn ±1, same date, equal |amount|, opposite signs, different accounts", () => {
    const rows: PairCandidate[] = [
      row({ id: 1, accountId: "checking", bankTransactionNumber: "517780823", amountCents: 10000 }),
      row({ id: 2, accountId: "savings", bankTransactionNumber: "517780822", amountCents: -10000 }),
    ];
    const pairs = findTransferPairs(rows);
    expect(pairs.length).toBe(1);
    expect(pairs[0].a.id).toBe(1);
    expect(pairs[0].b.id).toBe(2);
  });

  it("returns confidence=certain only when at least one memo is *-OVERDRAFT", () => {
    const confirmed = findTransferPairs([
      row({ id: 1, accountId: "checking", bankTransactionNumber: "10", amountCents: 5000, rawMemo: "DEPOSIT-OVERDRAFT" }),
      row({ id: 2, accountId: "savings", bankTransactionNumber: "11", amountCents: -5000, rawMemo: "WITHDRAWAL-OVERDRAFT" }),
    ]);
    expect(confirmed[0].confidence).toBe("certain");

    const unconfirmed = findTransferPairs([
      row({ id: 1, accountId: "checking", bankTransactionNumber: "10", amountCents: 5000, rawMemo: "POS 0325 1536 082706 CHEAPER CIGARETTES MANTECA CA" }),
      row({ id: 2, accountId: "savings", bankTransactionNumber: "11", amountCents: -5000, rawMemo: "WITHDRAWAL-OVERDRAFT" }),
    ]);
    expect(unconfirmed[0].confidence).toBe("certain");

    const neither = findTransferPairs([
      row({ id: 1, accountId: "checking", bankTransactionNumber: "10", amountCents: 5000, rawMemo: "some merchant" }),
      row({ id: 2, accountId: "savings", bankTransactionNumber: "11", amountCents: -5000, rawMemo: "another memo" }),
    ]);
    expect(neither[0].confidence).toBe("high");
  });

  it("does not pair rows on the same account", () => {
    const pairs = findTransferPairs([
      row({ id: 1, accountId: "checking", bankTransactionNumber: "10", amountCents: 5000 }),
      row({ id: 2, accountId: "checking", bankTransactionNumber: "11", amountCents: -5000 }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("does not pair rows with the same sign", () => {
    const pairs = findTransferPairs([
      row({ id: 1, accountId: "checking", bankTransactionNumber: "10", amountCents: 5000 }),
      row({ id: 2, accountId: "savings", bankTransactionNumber: "11", amountCents: 5000 }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("does not pair rows on different dates even if txn ±1 and amounts match", () => {
    const pairs = findTransferPairs([
      row({ id: 1, accountId: "checking", date: "2026-04-10", bankTransactionNumber: "10", amountCents: 5000 }),
      row({ id: 2, accountId: "savings", date: "2026-04-11", bankTransactionNumber: "11", amountCents: -5000 }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("does not pair rows with mismatched |amount|", () => {
    const pairs = findTransferPairs([
      row({ id: 1, accountId: "checking", bankTransactionNumber: "10", amountCents: 5000 }),
      row({ id: 2, accountId: "savings", bankTransactionNumber: "11", amountCents: -5001 }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("does not pair rows with txn difference > 1", () => {
    const pairs = findTransferPairs([
      row({ id: 1, accountId: "checking", bankTransactionNumber: "10", amountCents: 5000 }),
      row({ id: 2, accountId: "savings", bankTransactionNumber: "12", amountCents: -5000 }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("pairs the 80% relabeled case — memo is the triggering POS merchant, not DEPOSIT-OVERDRAFT", () => {
    const pairs = findTransferPairs([
      row({
        id: "checking:1",
        accountId: "checking",
        bankTransactionNumber: "517780823",
        amountCents: 10000,
        rawMemo: "POS 0410 1130 123456 CHEAPER CIGARETTES MANTECA CA",
      }),
      row({
        id: "savings:1",
        accountId: "savings",
        bankTransactionNumber: "517780822",
        amountCents: -10000,
        rawMemo: "WITHDRAWAL-OVERDRAFT",
      }),
    ]);
    expect(pairs.length).toBe(1);
    expect(pairs[0].confidence).toBe("certain");
  });

  it("greedy matching: once a row is paired, it is not used again", () => {
    const pairs = findTransferPairs([
      row({ id: 1, accountId: "a", bankTransactionNumber: "10", amountCents: 5000 }),
      row({ id: 2, accountId: "b", bankTransactionNumber: "11", amountCents: -5000 }),
      row({ id: 3, accountId: "b", bankTransactionNumber: "11", amountCents: -5000 }),
    ]);
    expect(pairs.length).toBe(1);
  });
});
