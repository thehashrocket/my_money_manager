import { describe, expect, it } from "vitest";
import {
  AmountParseError,
  MONEY_TONE_CLASS,
  centsToDollarString,
  formatCents,
  moneyTone,
  moneyToneClass,
  parseAmountToCents,
} from "./money";

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
    // Grouped, matching DESIGN.md's own money-display examples. The bare
    // .toFixed(2) this replaced rendered "$100000.00", which nothing under
    // four figures made visible — and a mortgage balance makes unreadable.
    expect(formatCents(100_000_00)).toBe("$100,000.00");
    expect(formatCents(-100_000_00)).toBe("($100,000.00)");
    expect(formatCents(-30_248_011)).toBe("($302,480.11)");
    expect(formatCents(500_000)).toBe("$5,000.00");
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

describe("moneyTone", () => {
  describe("asset context (the default)", () => {
    it("reads a positive figure as positive", () => {
      expect(moneyTone(1)).toBe("positive");
      expect(moneyTone(200000)).toBe("positive");
    });

    it("reads a negative figure as negative — an overdrawn asset is an alarm", () => {
      expect(moneyTone(-1)).toBe("negative");
      expect(moneyTone(-200000)).toBe("negative");
    });

    it("reads zero as neutral, never red (DESIGN.md money rules)", () => {
      expect(moneyTone(0)).toBe("neutral");
    });

    it("defaults to asset when no options object is passed at all", () => {
      expect(moneyTone(-500)).toBe(moneyTone(-500, { context: "asset" }));
    });
  });

  describe("liability context", () => {
    it("does NOT paint a negative balance alarm-red — owing money is the normal state", () => {
      expect(moneyTone(-200000, { context: "liability" })).toBe("plain");
      expect(moneyTone(-1, { context: "liability" })).toBe("plain");
      expect(MONEY_TONE_CLASS[moneyTone(-200000, { context: "liability" })]).not.toBe(
        MONEY_TONE_CLASS.negative,
      );
    });

    it("reads a positive balance as positive — that is a credit balance in your favour", () => {
      expect(moneyTone(5000, { context: "liability" })).toBe("positive");
    });

    it("reads a paid-off zero as neutral", () => {
      expect(moneyTone(0, { context: "liability" })).toBe("neutral");
    });

    it("never returns 'negative' for any input", () => {
      for (const cents of [-1_000_000, -200000, -1, 0, 1, 200000]) {
        expect(moneyTone(cents, { context: "liability" })).not.toBe("negative");
      }
    });
  });

  it("is total — every tone it returns has a class", () => {
    for (const context of ["asset", "liability"] as const) {
      for (const cents of [-1, 0, 1]) {
        const tone = moneyTone(cents, { context });
        expect(MONEY_TONE_CLASS[tone]).toBeTruthy();
      }
    }
  });
});

describe("moneyToneClass", () => {
  it("preserves the exact classes the three converted call sites emitted before D9", () => {
    // page.tsx:53-57, page.tsx:104-108 and spine.tsx:92-95 all computed these
    // three, so the extraction must be a no-op for asset figures.
    expect(moneyToneClass(100)).toBe("text-money-pos");
    expect(moneyToneClass(-100)).toBe("text-money-neg");
    expect(moneyToneClass(0)).toBe("text-money-zero");
  });

  it("gives a liability's negative balance full-strength ink, not the muted zero token", () => {
    expect(moneyToneClass(-200000, { context: "liability" })).toBe("text-foreground");
  });
});
