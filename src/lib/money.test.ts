import { describe, expect, it } from "vitest";
import { formatCents } from "./money";

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
