import { describe, expect, it } from "vitest";
import { resolveUtilizationDisplay } from "./resolveUtilizationDisplay";

describe("resolveUtilizationDisplay", () => {
  it("reports no limit when none is recorded — render no bar", () => {
    expect(resolveUtilizationDisplay(-214800, null)).toEqual({ pct: 0, hasLimit: false });
  });

  it("treats a zero or negative limit as no limit rather than dividing by it", () => {
    expect(resolveUtilizationDisplay(-214800, 0).hasLimit).toBe(false);
    expect(resolveUtilizationDisplay(-214800, -500).hasLimit).toBe(false);
  });

  it("computes the ordinary case off the magnitude of the debt", () => {
    const { pct, hasLimit } = resolveUtilizationDisplay(-214800, 500000);
    expect(hasLimit).toBe(true);
    expect(pct).toBeCloseTo(42.96, 2);
  });

  it("caps an over-limit card at 100 rather than overflowing the bar", () => {
    const { pct } = resolveUtilizationDisplay(-590000, 500000);
    expect(pct).toBe(100);
  });

  it("reports exactly 100 at the limit", () => {
    expect(resolveUtilizationDisplay(-500000, 500000).pct).toBe(100);
  });

  it("reports 0% for a paid-off card, with the bar still present", () => {
    expect(resolveUtilizationDisplay(0, 500000)).toEqual({ pct: 0, hasLimit: true });
  });

  it("reports 0% for an overpaid card rather than a negative bar", () => {
    // A credit balance means the lender owes you; none of the limit is used.
    expect(resolveUtilizationDisplay(5000, 500000)).toEqual({ pct: 0, hasLimit: true });
  });

  it("never returns a pct outside 0-100", () => {
    for (const balance of [-10_000_000, -500000, -1, 0, 1, 5000]) {
      const { pct } = resolveUtilizationDisplay(balance, 500000);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});
