import { describe, it, expect } from "vitest";
import {
  mapTransaction,
  postedToIsoDate,
  simplefinRowHash,
} from "./mapTransaction";
import type { SimpleFinTransaction } from "./types";

// Verbatim rows from the live pull in .context/simplefin-sample.json.
const AIRBNB_CHARGE: SimpleFinTransaction = {
  id: "TRN-22a0fa6a-2daf-4eec-955b-91f1510d4a00",
  posted: 1788350400,
  amount: "-200.00",
  description: "AIRBNB * TA9RWYS3 AIRBNB.COM CA Card #:8568",
  payee: "Airbnb",
  memo: "AIRBNB * TA9RWYS3 AIRBNB.COM CA Card #:8568",
  transacted_at: 1788350400,
  mcc: null,
};

const OVERDRAFT_SWEEP: SimpleFinTransaction = {
  id: "TRN-3a29fce2-f09e-4cf6-a68e-1097ae4a26ea",
  posted: 1788350400,
  amount: "-100.00",
  description: "WITHDRAWAL-OVERDRAFT",
  payee: "Overdraft Fee",
  memo: "WITHDRAWAL-OVERDRAFT",
  transacted_at: 1788350400,
  mcc: null,
};

// Verbatim shape from a live SoFi pull (.context/simplefin-sample.json,
// 2026-09-16): memo is a PRESENT but EMPTY string on every row, not null —
// `txn.memo ?? txn.description` never falls through to description for this
// institution.
const SOFI_ACH_WITHDRAWAL: SimpleFinTransaction = {
  id: "TRN-4265a1af-ccdd-40fa-8922-c3afc16a7c4b",
  posted: 1789387200,
  amount: "-30.41",
  description: "ACH: AFFIRM.COM PAYME",
  payee: "Affirm",
  memo: "",
  transacted_at: 1789387200,
  mcc: null,
};

// memo is `nullish()` in the zod schema (null OR undefined), which is a
// distinct case from SoFi's present-but-empty string above: `txn.memo?.trim()`
// short-circuits to `undefined` for either null or omitted, so this pins that
// the optional-chained rewrite still falls through to `description` the way
// the old `txn.memo ?? txn.description` did — a plain `txn.memo.trim()` typo
// (dropping the `?`) would throw on exactly this shape instead of failing a
// visible assertion.
const NULL_MEMO_WITHDRAWAL: SimpleFinTransaction = {
  id: "TRN-8a1cf2f0-2222-4444-8888-abcdefabcdef",
  posted: 1789387200,
  amount: "-12.50",
  description: "SOME BANK MEMO-LESS ROW",
  payee: null,
  memo: null,
  transacted_at: 1789387200,
  mcc: null,
};

const POS_INBOUND: SimpleFinTransaction = {
  id: "TRN-b558e132-0f59-4933-8329-673b388b2345",
  posted: 1788350400,
  amount: "200.00",
  description: "POS 0902 1340 815925 AIRBNB * TA9RWYS3 AIRBNB.COM CA",
  payee: "Airbnb",
  memo: "POS 0902 1340 815925 AIRBNB * TA9RWYS3 AIRBNB.COM CA",
  transacted_at: 1788350400,
  mcc: null,
};

describe("postedToIsoDate", () => {
  it("reads Star One's noon-UTC stamp as the calendar date", () => {
    expect(postedToIsoDate(AIRBNB_CHARGE)).toBe("2026-09-02");
  });

  it("falls back to transacted_at when posted is 0", () => {
    expect(
      postedToIsoDate({ ...AIRBNB_CHARGE, posted: 0, transacted_at: 1788350400 }),
    ).toBe("2026-09-02");
  });

  it("throws rather than silently inventing 1970-01-01", () => {
    expect(() =>
      postedToIsoDate({ ...AIRBNB_CHARGE, posted: 0, transacted_at: null }),
    ).toThrow(/no usable posted/);
  });
});

describe("mapTransaction", () => {
  it("derives raw_description from the sign, since the feed has no such field", () => {
    expect(mapTransaction(AIRBNB_CHARGE).rawDescription).toBe("WITHDRAWAL");
    expect(mapTransaction(POS_INBOUND).rawDescription).toBe("DEPOSIT");
  });

  it("delegates to the shared merchant normalizer rather than reimplementing it", () => {
    // Was "AIRBNB * TA9RWYS3 AIRBNB.COM" before the class 1 brand-first split.
    // The reference token is unique per booking, so the old value could never
    // group and no trained rule could ever match a future Airbnb charge.
    expect(mapTransaction(AIRBNB_CHARGE).normalizedMerchant).toBe("AIRBNB");
    expect(mapTransaction(AIRBNB_CHARGE).cardLastFour).toBe("8568");
  });

  it("normalizes both legs of a transfer to the same merchant", () => {
    // This is what lets a POS-labelled inbound sweep still read as the same
    // merchant as the charge that triggered it.
    expect(mapTransaction(POS_INBOUND).normalizedMerchant).toBe(
      mapTransaction(AIRBNB_CHARGE).normalizedMerchant,
    );
  });

  it("keeps MX's cleaned payee for display without matching on it", () => {
    const row = mapTransaction(POS_INBOUND);
    expect(row.payee).toBe("Airbnb");
    // The rule key stays the raw-derived merchant, so trained category_rules
    // keep matching.
    expect(row.normalizedMerchant).not.toBe(row.payee);
  });

  it("derives a stable, unique import_row_hash from the SimpleFIN id", () => {
    const a = mapTransaction(AIRBNB_CHARGE);
    expect(a.importRowHash).toBe(simplefinRowHash(AIRBNB_CHARGE.id));
    expect(a.importRowHash).toBe(mapTransaction(AIRBNB_CHARGE).importRowHash);
    expect(a.importRowHash).not.toBe(mapTransaction(POS_INBOUND).importRowHash);
  });

  it("falls back to description when memo is present but blank (SoFi shape)", () => {
    // Without the fallback, `rawMemo` (and therefore `normalizedMerchant`)
    // is "" for every SoFi row, and /transactions renders "No merchant name"
    // for all of them.
    const row = mapTransaction(SOFI_ACH_WITHDRAWAL);
    expect(row.rawMemo).toBe("ACH: AFFIRM.COM PAYME");
    // normalize.ts has no PROCESSOR_PREFIXES entry for "ACH:", so this ships
    // unstripped — non-empty and correct, but noisier than Star One's keys.
    // Pinned exactly (not just `.not.toBe("")`) so a future normalize.ts change
    // that alters this is a visible, deliberate decision.
    expect(row.normalizedMerchant).toBe("ACH: AFFIRM.COM PAYME");
  });

  it("still falls back to description when memo is null, not just blank", () => {
    // A distinct case from the SoFi shape above: memo absent entirely
    // (nullish) rather than present-but-empty. `?.` must short-circuit here
    // the same way `??` did before this fix.
    const row = mapTransaction(NULL_MEMO_WITHDRAWAL);
    expect(row.rawMemo).toBe("SOME BANK MEMO-LESS ROW");
    expect(row.normalizedMerchant).toBe("SOME BANK MEMO-LESS ROW");
  });

  it("maps the overdraft sweep leg intact for the matcher to find", () => {
    const row = mapTransaction(OVERDRAFT_SWEEP);
    expect(row.amountCents).toBe(-10000);
    expect(row.rawMemo).toBe("WITHDRAWAL-OVERDRAFT");
    expect(row.isPending).toBe(false);
  });
});
