import { describe, expect, it } from "vitest";
import { AmountParseError, centsToDollarString, formatCents, parseAmountToCents } from "./money";

describe("formatCents", () => {
  it("formats positive integers with two decimals", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(12345)).toBe("$123.45");
  });

  it("wraps negatives in accounting parens", () => {
    expect(formatCents(-1)).toBe("($0.01)");
    expect(formatCents(-100)).toBe("($1.00)");
    expect(formatCents(-4200)).toBe("($42.00)");
  });

  it("does not round halfway values (toFixed banker's-rounding quirks are acceptable here)", () => {
    expect(formatCents(999)).toBe("$9.99");
    expect(formatCents(-999)).toBe("($9.99)");
  });

  it("handles large amounts", () => {
    expect(formatCents(100_000_00)).toBe("$100000.00");
    expect(formatCents(-100_000_00)).toBe("($100000.00)");
  });
});

describe("parseAmountToCents (TC16b)", () => {
  it("parses the signs SimpleFIN actually sends, unmodified", () => {
    // Real values from .context/simplefin-sample.json. Debits arrive negative
    // and credits positive; nothing here negates by description (rule 2).
    expect(parseAmountToCents("-178.97")).toBe(-17897);
    expect(parseAmountToCents("200.00")).toBe(20000);
    expect(parseAmountToCents("-408900.00")).toBe(-40890000);
    expect(parseAmountToCents("5911.45")).toBe(591145);
  });

  it("avoids the binary-float error that `parseFloat(x) * 100` introduces", () => {
    // 0.29 * 100 === 28.999999999999996 in IEEE-754; 1.10 * 100 === 110.00000000000001.
    expect(parseAmountToCents("0.29")).toBe(29);
    expect(parseAmountToCents("1.10")).toBe(110);
    expect(parseAmountToCents("8.87")).toBe(887);
    expect(parseAmountToCents("-0.29")).toBe(-29);
  });

  it("handles shorthand and explicit-positive forms", () => {
    expect(parseAmountToCents("5")).toBe(500);
    expect(parseAmountToCents("1.5")).toBe(150);
    expect(parseAmountToCents("+3.50")).toBe(350);
    expect(parseAmountToCents("0.00")).toBe(0);
    expect(parseAmountToCents("  12.34  ")).toBe(1234);
  });

  it("rounds a third decimal half away from zero rather than truncating", () => {
    expect(parseAmountToCents("1.005")).toBe(101);
    expect(parseAmountToCents("-1.005")).toBe(-101);
    expect(parseAmountToCents("1.004")).toBe(100);
  });

  it("(C4) strips a leading $ and thousands-separator commas, for human-typed dollar input", () => {
    expect(parseAmountToCents("$5.00")).toBe(500);
    expect(parseAmountToCents("1,000.00")).toBe(100000);
    expect(parseAmountToCents("$1,234.56")).toBe(123456);
    expect(parseAmountToCents("-$1,234.56")).toBe(-123456);
  });

  it("rejects anything it cannot parse exactly", () => {
    for (const bad of ["", "abc", "1.2.3", "--1", "1e3", "$", ","]) {
      expect(() => parseAmountToCents(bad)).toThrow(AmountParseError);
    }
    // @ts-expect-error guarding the runtime boundary, not the type
    expect(() => parseAmountToCents(null)).toThrow(AmountParseError);
  });
});

describe("centsToDollarString", () => {
  it("formats zero", () => {
    expect(centsToDollarString(0)).toBe("0.00");
  });

  it("formats whole dollars", () => {
    expect(centsToDollarString(500)).toBe("5.00");
    expect(centsToDollarString(10000)).toBe("100.00");
  });

  it("formats sub-dollar cents", () => {
    expect(centsToDollarString(5)).toBe("0.05");
    expect(centsToDollarString(50)).toBe("0.50");
  });

  it("round-trips through parseAmountToCents", () => {
    for (const cents of [0, 5, 50, 500, 7599, 123456]) {
      expect(parseAmountToCents(centsToDollarString(cents))).toBe(cents);
    }
  });
});
