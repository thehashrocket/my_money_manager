import { describe, it, expect } from "vitest";
import { computeImportRowHash } from "./hash";

const base = {
  date: "2026-04-16",
  amountCents: -3713,
  rawDescription: "WITHDRAWAL",
  rawMemo: "TST*THE BRASS TAP - Modesto CA Card #:8568",
  rowIndex: 4,
};

describe("computeImportRowHash", () => {
  it("is deterministic for identical input", () => {
    expect(computeImportRowHash(base)).toBe(computeImportRowHash(base));
  });

  it("returns a 40-char hex string", () => {
    expect(computeImportRowHash(base)).toMatch(/^[a-f0-9]{40}$/);
  });

  it("changes when any field changes", () => {
    const h0 = computeImportRowHash(base);
    expect(computeImportRowHash({ ...base, date: "2026-04-17" })).not.toBe(h0);
    expect(computeImportRowHash({ ...base, amountCents: -3714 })).not.toBe(h0);
    expect(
      computeImportRowHash({ ...base, rawDescription: "DEPOSIT" }),
    ).not.toBe(h0);
    expect(
      computeImportRowHash({ ...base, rawMemo: base.rawMemo + " " }),
    ).not.toBe(h0);
    expect(computeImportRowHash({ ...base, rowIndex: 5 })).not.toBe(h0);
  });

  it("differentiates the 6098 pending-deposit rows by row index", () => {
    const a = computeImportRowHash({
      date: "2026-04-16",
      amountCents: 19162,
      rawDescription: "DEPOSIT",
      rawMemo: "  COSTCO WHSE #1031  MANTECA  CA",
      rowIndex: 0,
    });
    const b = computeImportRowHash({
      date: "2026-04-16",
      amountCents: 19162,
      rawDescription: "DEPOSIT",
      rawMemo: "  COSTCO WHSE #1031  MANTECA  CA",
      rowIndex: 1,
    });
    expect(a).not.toBe(b);
  });
});
