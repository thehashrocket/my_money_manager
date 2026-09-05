import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastDayOfMonth,
  monthBoundary,
  monthPhase,
  nextMonthOf,
  nMonthsBack,
  parseIsoMonth,
  previousMonth,
} from "./monthOfIso";

const ORIGINAL_TZ = process.env.TZ;

function setTz(tz: string) {
  process.env.TZ = tz;
}

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("parseIsoMonth", () => {
  it("extracts numeric year and month from an ISO date string", () => {
    expect(parseIsoMonth("2026-09-04")).toEqual({ year: 2026, month: 9 });
  });
});

describe("previousMonth", () => {
  it("steps back within a year", () => {
    expect(previousMonth(2026, 5)).toEqual({ year: 2026, month: 4 });
  });

  it("rolls the year back at January", () => {
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
  });
});

describe("nextMonthOf", () => {
  it("steps forward within a year", () => {
    expect(nextMonthOf(2026, 5)).toEqual({ year: 2026, month: 6 });
  });

  it("rolls the year forward at December", () => {
    expect(nextMonthOf(2026, 12)).toEqual({ year: 2027, month: 1 });
  });
});

describe("nMonthsBack", () => {
  it("steps back within a year", () => {
    expect(nMonthsBack(2026, 9, 3)).toEqual({ year: 2026, month: 6 });
  });

  it("crosses one year boundary", () => {
    expect(nMonthsBack(2026, 2, 5)).toEqual({ year: 2025, month: 9 });
  });

  it("crosses multiple year boundaries", () => {
    expect(nMonthsBack(2026, 2, 26)).toEqual({ year: 2023, month: 12 });
  });

  it("n=0 returns the same month", () => {
    expect(nMonthsBack(2026, 9, 0)).toEqual({ year: 2026, month: 9 });
  });
});

describe("monthBoundary", () => {
  it("formats and zero-pads", () => {
    expect(monthBoundary(2026, 9)).toBe("2026-09-01");
    expect(monthBoundary(2026, 1)).toBe("2026-01-01");
  });
});

describe("lastDayOfMonth", () => {
  it("an ordinary 30-day month", () => {
    expect(lastDayOfMonth(2026, 4)).toBe("2026-04-30");
  });

  it("an ordinary 31-day month", () => {
    expect(lastDayOfMonth(2026, 1)).toBe("2026-01-31");
  });

  it("February in a non-leap year", () => {
    expect(lastDayOfMonth(2026, 2)).toBe("2026-02-28");
  });

  it("February in a leap year", () => {
    expect(lastDayOfMonth(2028, 2)).toBe("2028-02-29");
  });

  it("December (year-rollover boundary)", () => {
    expect(lastDayOfMonth(2026, 12)).toBe("2026-12-31");
  });
});

describe("monthPhase (TC41, E12)", () => {
  beforeEach(() => setTz("America/Los_Angeles"));

  it("is 'open' at 2026-09-30T23:59 local", () => {
    const now = new Date("2026-10-01T06:59:00Z"); // 2026-09-30T23:59 PDT
    expect(monthPhase(2026, 9, now)).toBe("open");
  });

  it("is 'closed' at 2026-10-01T00:00 local", () => {
    const now = new Date("2026-10-01T07:00:00Z"); // 2026-10-01T00:00 PDT
    expect(monthPhase(2026, 9, now)).toBe("closed");
  });

  it("is 'future' for October while local time is still September 30", () => {
    const now = new Date("2026-10-01T06:59:00Z"); // 2026-09-30T23:59 PDT
    expect(monthPhase(2026, 10, now)).toBe("future");
  });

  it("rolls December -> January: December is closed, January is open, February is future", () => {
    const now = new Date("2027-01-15T20:00:00Z"); // 2027-01-15T12:00 PST
    expect(monthPhase(2026, 12, now)).toBe("closed");
    expect(monthPhase(2027, 1, now)).toBe("open");
    expect(monthPhase(2027, 2, now)).toBe("future");
  });

  it("follows process.env.TZ rather than UTC — the same instant reads differently under UTC", () => {
    const now = new Date("2026-10-01T06:59:00Z"); // 2026-09-30T23:59 PDT, but 2026-10-01T06:59 UTC
    expect(monthPhase(2026, 9, now)).toBe("open"); // PT: still September

    setTz("UTC");
    expect(monthPhase(2026, 9, now)).toBe("closed"); // UTC: already October
    expect(monthPhase(2026, 10, now)).toBe("open");
  });
});
