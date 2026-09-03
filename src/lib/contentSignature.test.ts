import { describe, it, expect } from "vitest";
import { contentSignature } from "./contentSignature";

describe("contentSignature", () => {
  it("ignores every field outside date, amount and memo", () => {
    const row = {
      date: "2026-09-01",
      amountCents: -4870,
      rawMemo: "AIRBNB * HMZXYQ",
    };
    // Assigned first: an inline literal would trip excess-property checking,
    // which is the opposite of what this asserts — extra fields are the point.
    const fromFeed = { ...row, externalId: "TRN-a", payee: "Airbnb" };
    const fromCsv = { ...row, rowIndex: 41, bankTransactionNumber: "6098" };
    expect(contentSignature(fromFeed)).toBe(contentSignature(fromCsv));
    expect(contentSignature(row)).not.toBe(
      contentSignature({ ...row, amountCents: -100 }),
    );
  });
});

describe("contentSignature — whitespace normalisation", () => {
  it("matches a padded CSV memo against the feed's trimmed one", () => {
    const csv = {
      date: "2026-09-01",
      amountCents: -4870,
      rawMemo: "  STARBUCKS STORE 1234 MANTECA CA",
    };
    const feed = {
      date: "2026-09-01",
      amountCents: -4870,
      rawMemo: "STARBUCKS STORE 1234 MANTECA CA",
    };
    expect(contentSignature(csv)).toBe(contentSignature(feed));
  });

  it("collapses runs of internal whitespace", () => {
    expect(
      contentSignature({
        date: "2026-09-01",
        amountCents: -100,
        rawMemo: "COSTCO WHSE #1031  MANTECA  CA",
      }),
    ).toBe(
      contentSignature({
        date: "2026-09-01",
        amountCents: -100,
        rawMemo: "COSTCO WHSE #1031 MANTECA CA",
      }),
    );
  });

  it("still separates rows that differ on date, amount or merchant", () => {
    const base = { date: "2026-09-01", amountCents: -100, rawMemo: "A B" };
    expect(contentSignature(base)).not.toBe(
      contentSignature({ ...base, date: "2026-09-02" }),
    );
    expect(contentSignature(base)).not.toBe(
      contentSignature({ ...base, amountCents: -101 }),
    );
    expect(contentSignature(base)).not.toBe(
      contentSignature({ ...base, rawMemo: "A C" }),
    );
  });
});
