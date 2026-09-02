import { describe, it, expect } from "vitest";
import { resolveStartDate } from "./sync";

const NOW = new Date("2026-09-02T17:00:00Z");

describe("resolveStartDate", () => {
  it("starts a week before the oldest account's newest row", () => {
    const { startIso } = resolveStartDate(["2026-09-01", "2026-08-30"], NOW);
    expect(startIso).toBe("2026-08-23");
  });

  it("takes the full window when an account has no history yet", () => {
    const { startIso } = resolveStartDate(["2026-09-01", null], NOW);
    expect(startIso).toBe("2026-07-19");
  });

  it("stays inside SimpleFIN's recommended 45-day range", () => {
    // A stale account would otherwise reach back years, and the provider warns
    // that over-45-day requests may start being capped.
    const { startIso } = resolveStartDate(["2024-01-01"], NOW);
    expect(startIso).toBe("2026-07-19");
  });

  it("returns a unix start aligned to midnight UTC of the ISO date", () => {
    const { startIso, startUnix } = resolveStartDate(["2026-09-01"], NOW);
    expect(new Date(startUnix * 1000).toISOString()).toBe(`${startIso}T00:00:00.000Z`);
  });
});
