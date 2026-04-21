import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseStarOneCsv } from "./parseCsv";

const CHECKING = path.join(
  import.meta.dirname,
  "__fixtures__/sample-checking.csv",
);
const SAVINGS = path.join(
  import.meta.dirname,
  "__fixtures__/sample-savings.csv",
);

describe("parseStarOneCsv — checking fixture", () => {
  const text = readFileSync(CHECKING, "utf8");
  const { rows, errors } = parseStarOneCsv(text);

  it("parses 10 data rows with no errors", () => {
    expect(errors).toEqual([]);
    expect(rows.length).toBe(10);
  });

  it("preserves pre-correct signs — debits negative, credits positive, never both", () => {
    for (const r of rows) {
      if (r.rawDescription === "WITHDRAWAL") expect(r.amountCents).toBeLessThan(0);
      if (r.rawDescription === "DEPOSIT") expect(r.amountCents).toBeGreaterThan(0);
    }
  });

  it("converts MM/DD/YYYY to ISO YYYY-MM-DD", () => {
    expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("flags the 4 pending rows with bankTransactionNumber=6098 and balance=0 as isPending", () => {
    const pending = rows.filter((r) => r.isPending);
    expect(pending.length).toBe(4);
    expect(pending.every((r) => r.bankTransactionNumber === "6098")).toBe(true);
    expect(pending.every((r) => r.balanceCents === 0)).toBe(true);
  });

  it("preserves leading whitespace in pending Memos for hash stability", () => {
    const pending = rows.filter((r) => r.isPending);
    expect(pending.every((r) => r.rawMemo.startsWith("  "))).toBe(true);
  });

  it("spot-check: first non-pending withdrawal parses correctly", () => {
    const r = rows.find(
      (x) => x.rawDescription === "WITHDRAWAL" && !x.isPending,
    );
    expect(r?.amountCents).toBe(-3713);
    expect(r?.date).toBe("2026-04-16");
    expect(r?.rawMemo).toContain("THE BRASS TAP");
  });

  it("captures check_number when present", () => {
    const checkDeposit = rows.find((r) => r.checkNumber === "1234");
    expect(checkDeposit).toBeDefined();
    expect(checkDeposit?.rawDescription).toBe("DEPOSIT");
  });
});

describe("parseStarOneCsv — savings fixture", () => {
  const text = readFileSync(SAVINGS, "utf8");
  const { rows, errors } = parseStarOneCsv(text);

  it("parses 3 data rows with no errors", () => {
    expect(errors).toEqual([]);
    expect(rows.length).toBe(3);
  });

  it("WITHDRAWAL-OVERDRAFT rows are negative", () => {
    const overdrafts = rows.filter(
      (r) => r.rawMemo.trim() === "WITHDRAWAL-OVERDRAFT",
    );
    expect(overdrafts.length).toBeGreaterThan(0);
    for (const r of overdrafts) expect(r.amountCents).toBeLessThan(0);
  });
});

describe("parseStarOneCsv — error handling", () => {
  it("reports invalid date but keeps parsing subsequent rows", () => {
    const csv = [
      "Transaction Number,Date,Description,Memo,Amount Debit,Amount Credit,Balance,check_number,Fees",
      "123,99/99/9999,WITHDRAWAL,BOGUS,-1.00,,0,,",
      "124,04/16/2026,WITHDRAWAL,VALID,-2.00,,0,,",
    ].join("\n");
    const { rows, errors } = parseStarOneCsv(csv);
    expect(errors.length).toBe(1);
    expect(errors[0].reason).toMatch(/invalid date/);
    expect(rows.length).toBe(1);
    expect(rows[0].rawMemo).toBe("VALID");
  });

  it("rejects rows where both Debit and Credit are populated", () => {
    const csv = [
      "Transaction Number,Date,Description,Memo,Amount Debit,Amount Credit,Balance,check_number,Fees",
      "123,04/16/2026,WITHDRAWAL,BOGUS,-1.00,1.00,0,,",
    ].join("\n");
    const { rows, errors } = parseStarOneCsv(csv);
    expect(rows.length).toBe(0);
    expect(errors[0].reason).toMatch(/both/);
  });
});
