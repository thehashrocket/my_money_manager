import { describe, it, expect } from "vitest";
import { transformRow } from "./importBatch";
import { computeImportRowHash } from "./hash";
import type { ParsedRow } from "./parseCsv";

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    rowIndex: 0,
    bankTransactionNumber: "12345",
    date: "2026-04-16",
    rawDescription: "WITHDRAWAL",
    rawMemo: "TST*THE BRASS TAP - Modesto CA Card #:8568",
    amountCents: -3713,
    balanceCents: 10000,
    checkNumber: null,
    fees: null,
    isPending: false,
    ...overrides,
  };
}

describe("transformRow", () => {
  it("computes importRowHash deterministically from the 5 inputs", () => {
    const r = row();
    const result = transformRow(r);
    const expected = computeImportRowHash({
      date: r.date,
      amountCents: r.amountCents,
      rawDescription: r.rawDescription,
      rawMemo: r.rawMemo,
      rowIndex: r.rowIndex,
    });
    expect(result.importRowHash).toBe(expected);
  });

  it("normalizes merchant and extracts card last-four", () => {
    const result = transformRow(row());
    expect(result.normalizedMerchant).toContain("BRASS TAP");
    expect(result.normalizedMerchant).toBe(result.normalizedMerchant.toUpperCase());
    expect(result.cardLastFour).toBe("8568");
  });

  it("returns null cardLastFour when no Card # is present", () => {
    const result = transformRow(row({ rawMemo: "NETFLIX.COM" }));
    expect(result.cardLastFour).toBeNull();
  });

  it("preserves sign, date, and pending flag", () => {
    const deposit = transformRow(
      row({
        rawDescription: "DEPOSIT",
        amountCents: 50000,
        isPending: true,
        bankTransactionNumber: "6098",
      }),
    );
    expect(deposit.amountCents).toBe(50000);
    expect(deposit.rawDescription).toBe("DEPOSIT");
    expect(deposit.isPending).toBe(true);
    expect(deposit.bankTransactionNumber).toBe("6098");
  });

  it("produces distinct hashes for rows that differ only by rowIndex", () => {
    const a = transformRow(row({ rowIndex: 0 }));
    const b = transformRow(row({ rowIndex: 1 }));
    expect(a.importRowHash).not.toBe(b.importRowHash);
  });
});
