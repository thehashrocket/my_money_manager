import { describe, it, expect } from "vitest";
import {
  mapTransaction,
  postedToIsoDate,
  contentSignature,
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

  it("reuses the existing merchant normalizer unchanged", () => {
    expect(mapTransaction(AIRBNB_CHARGE).normalizedMerchant).toBe(
      "AIRBNB * TA9RWYS3 AIRBNB.COM",
    );
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

  it("maps the overdraft sweep leg intact for the matcher to find", () => {
    const row = mapTransaction(OVERDRAFT_SWEEP);
    expect(row.amountCents).toBe(-10000);
    expect(row.rawMemo).toBe("WITHDRAWAL-OVERDRAFT");
    expect(row.isPending).toBe(false);
  });
});

describe("contentSignature", () => {
  it("collides only on genuinely identical content", () => {
    const row = mapTransaction(AIRBNB_CHARGE);
    expect(contentSignature(row)).toBe(
      contentSignature({ ...row, externalId: "different" } as typeof row),
    );
    expect(contentSignature(row)).not.toBe(
      contentSignature({ ...row, amountCents: -100 }),
    );
  });
});
