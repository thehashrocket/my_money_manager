import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  currentMonth,
  todayIso,
  daysAgoIso,
  toLocalIso,
  formatLocalDateTime,
} from "./now";

const ORIGINAL_TZ = process.env.TZ;

function setTz(tz: string) {
  process.env.TZ = tz;
}

describe("now.ts", () => {
  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  describe("under America/Los_Angeles", () => {
    beforeEach(() => {
      setTz("America/Los_Angeles");
      // 2026-09-30T18:00 PT == 2026-10-01T01:00 UTC
      vi.useFakeTimers().setSystemTime(new Date("2026-10-01T01:00:00Z"));
    });

    it("currentMonth reads the local (PT) calendar month", () => {
      expect(currentMonth()).toEqual({ year: 2026, month: 9 });
    });

    it("todayIso reads the local (PT) calendar date", () => {
      expect(todayIso()).toBe("2026-09-30");
    });

    it("daysAgoIso(30) returns the locally-intended oldest day", () => {
      expect(daysAgoIso(30)).toBe("2026-08-31");
    });
  });

  describe("under UTC — same instant, different local date", () => {
    beforeEach(() => {
      setTz("UTC");
      vi.useFakeTimers().setSystemTime(new Date("2026-10-01T01:00:00Z"));
    });

    it("currentMonth reads October, not September", () => {
      expect(currentMonth()).toEqual({ year: 2026, month: 10 });
    });

    it("todayIso reads 2026-10-01", () => {
      expect(todayIso()).toBe("2026-10-01");
    });

    it("daysAgoIso(30) disagrees with the PT answer — this is exactly the bug TZ must fix", () => {
      expect(daysAgoIso(30)).toBe("2026-09-01");
    });
  });

  describe("December → January rollover", () => {
    beforeEach(() => {
      setTz("UTC");
      vi.useFakeTimers().setSystemTime(new Date("2027-01-01T00:30:00Z"));
    });

    it("currentMonth rolls the year forward", () => {
      expect(currentMonth()).toEqual({ year: 2027, month: 1 });
    });

    it("daysAgoIso crosses back into the prior year", () => {
      expect(daysAgoIso(5)).toBe("2026-12-27");
    });
  });

  describe("toLocalIso / formatLocalDateTime on a supplied instant", () => {
    // These take a Date rather than reading the clock: the caller is a bank
    // feed's `balance-date`, not "now".
    const BANK_AS_OF = new Date("2026-09-02T16:52:02Z");

    it("collapses a UTC instant to the local PT calendar date", () => {
      setTz("America/Los_Angeles");
      expect(toLocalIso(BANK_AS_OF)).toBe("2026-09-02");
      expect(formatLocalDateTime(BANK_AS_OF)).toBe("2026-09-02 09:52");
    });

    it("gives the same instant a different local date across the day boundary", () => {
      // 2026-09-03T02:30Z is still the 2nd in PT. Comparing this against
      // date-only ledger rows via `.toISOString()` would read the 3rd and call
      // a stale bank figure current.
      const lateEvening = new Date("2026-09-03T02:30:00Z");
      setTz("America/Los_Angeles");
      expect(toLocalIso(lateEvening)).toBe("2026-09-02");
      setTz("UTC");
      expect(toLocalIso(lateEvening)).toBe("2026-09-03");
    });

    it("zero-pads single-digit months, days, hours and minutes", () => {
      setTz("UTC");
      expect(formatLocalDateTime(new Date("2026-01-05T04:07:00Z"))).toBe(
        "2026-01-05 04:07",
      );
    });
  });

  describe("DST boundary (America/Los_Angeles springs forward 2026-03-08)", () => {
    beforeEach(() => {
      setTz("America/Los_Angeles");
      // 2026-03-09T10:00 PDT
      vi.useFakeTimers().setSystemTime(new Date("2026-03-09T17:00:00Z"));
    });

    it("daysAgoIso(1) lands on the date before the spring-forward, not shifted by the missing hour", () => {
      expect(daysAgoIso(1)).toBe("2026-03-08");
    });
  });
});
