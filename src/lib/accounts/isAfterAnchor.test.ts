import { describe, expect, it } from "vitest";
import { isAfterAnchor } from "./isAfterAnchor";

describe("isAfterAnchor", () => {
  it("is STRICT — the anchor day itself does not count", () => {
    // The whole reason the anchor must be a CLOSE-of-day figure (rule 1).
    // Loosening this to `>=` double-counts every row dated on the anchor.
    expect(isAfterAnchor("2026-09-08", "2026-09-08")).toBe(false);
    expect(isAfterAnchor("2026-09-09", "2026-09-08")).toBe(true);
    expect(isAfterAnchor("2026-09-07", "2026-09-08")).toBe(false);
  });

  it("orders across month and year boundaries", () => {
    expect(isAfterAnchor("2026-10-01", "2026-09-30")).toBe(true);
    expect(isAfterAnchor("2026-01-01", "2025-12-31")).toBe(true);
    expect(isAfterAnchor("2025-12-31", "2026-01-01")).toBe(false);
  });

  it("is the exact complement of createCardActivity's refusal", () => {
    // The server refuses `date <= startingBalanceDate`. Anything this returns
    // true for must be accepted there and vice versa — that equivalence is the
    // reason this module exists, so assert it rather than describe it.
    const serverRefuses = (date: string, anchor: string) => date <= anchor;
    const cases: [string, string][] = [
      ["2026-09-08", "2026-09-08"],
      ["2026-09-09", "2026-09-08"],
      ["2026-08-01", "2026-09-08"],
      ["2027-01-01", "2026-09-08"],
    ];
    for (const [date, anchor] of cases) {
      expect(isAfterAnchor(date, anchor)).toBe(!serverRefuses(date, anchor));
    }
  });

  it("answers the affordance question when asked about TODAY", () => {
    // `chargeableDateExists` is not a fourth rule: the charge dialog caps the
    // date at today, so "is any legal date left" IS "is today after the
    // anchor". Pinned so the two cannot drift apart again.
    expect(isAfterAnchor("2026-09-09", "2026-09-08")).toBe(true);
    expect(isAfterAnchor("2026-09-08", "2026-09-08")).toBe(false);
  });
});
