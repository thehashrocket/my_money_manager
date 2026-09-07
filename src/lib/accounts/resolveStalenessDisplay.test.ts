import { describe, expect, it } from "vitest";
import {
  FEED_STALE_AFTER_DAYS,
  MANUAL_STALE_AFTER_DAYS,
  resolveStalenessDisplay,
} from "./resolveStalenessDisplay";

/** Local noon, so nothing here is sensitive to the runner's timezone. */
const TODAY = new Date(2026, 8, 6, 12, 0, 0); // 2026-09-06
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

describe("resolveStalenessDisplay — feed (7-day threshold)", () => {
  it("is fresh the day of, with no age clause", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: at(2026, 9, 6), startingBalanceDate: "2026-01-01", balanceSource: "feed" },
      TODAY,
    );
    expect(r.isStale).toBe(false);
    expect(r.label).toBe("as of Sep 6");
    expect(r.ageDays).toBe(0);
  });

  it("is still fresh at 6 days — the near side of the boundary", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: at(2026, 8, 31), startingBalanceDate: "2026-01-01", balanceSource: "feed" },
      TODAY,
    );
    expect(r.ageDays).toBe(6);
    expect(r.isStale).toBe(false);
  });

  it("goes stale exactly AT 7 days — the far side of the boundary", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: at(2026, 8, 30), startingBalanceDate: "2026-01-01", balanceSource: "feed" },
      TODAY,
    );
    expect(r.ageDays).toBe(FEED_STALE_AFTER_DAYS);
    expect(r.isStale).toBe(true);
  });

  it("renders the DS61 copy-deck string when stale", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: at(2026, 8, 6), startingBalanceDate: "2026-01-01", balanceSource: "feed" },
      TODAY,
    );
    expect(r.label).toBe("as of Aug 6 · 31 days old");
  });
});

describe("resolveStalenessDisplay — manual (35-day threshold)", () => {
  it("is fresh the day of", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: null, startingBalanceDate: "2026-09-06", balanceSource: "manual" },
      TODAY,
    );
    expect(r.isStale).toBe(false);
    expect(r.label).toBe("reconciled Sep 6");
  });

  it("is still fresh at 34 days — a normal monthly cadence keeps its slack", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: null, startingBalanceDate: "2026-08-03", balanceSource: "manual" },
      TODAY,
    );
    expect(r.ageDays).toBe(34);
    expect(r.isStale).toBe(false);
  });

  it("goes stale exactly AT 35 days", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: null, startingBalanceDate: "2026-08-02", balanceSource: "manual" },
      TODAY,
    );
    expect(r.ageDays).toBe(MANUAL_STALE_AFTER_DAYS);
    expect(r.isStale).toBe(true);
    expect(r.label).toBe("reconciled Aug 2 · 35 days ago");
  });

  it("would NOT be stale yet under the feed threshold's copy, and vice versa", () => {
    const twentyDaysAgo = {
      balanceAsOf: at(2026, 8, 17),
      startingBalanceDate: "2026-01-01",
    };
    expect(
      resolveStalenessDisplay({ ...twentyDaysAgo, balanceSource: "manual" }, TODAY).isStale,
    ).toBe(false);
    expect(
      resolveStalenessDisplay({ ...twentyDaysAgo, balanceSource: "feed" }, TODAY).isStale,
    ).toBe(true);
  });
});

describe("resolveStalenessDisplay — the balance_as_of fallback (DS57)", () => {
  it("falls back to startingBalanceDate when balance_as_of is NULL", () => {
    // D10 path 3 sets balance_as_of = NULL on every manual reconcile, and
    // cards are manual-only by D15 — so a rule reading only balance_as_of
    // would be permanently blank on exactly the accounts it exists for.
    const r = resolveStalenessDisplay(
      { balanceAsOf: null, startingBalanceDate: "2026-09-01", balanceSource: "manual" },
      TODAY,
    );
    expect(r.asOfIso).toBe("2026-09-01");
    expect(r.label).toBe("reconciled Sep 1");
  });

  it("prefers balance_as_of over the anchor when both are present", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: at(2026, 9, 4), startingBalanceDate: "2026-01-01", balanceSource: "feed" },
      TODAY,
    );
    expect(r.asOfIso).toBe("2026-09-04");
  });

  it("treats a NULL balance_source as manual — the forgiving threshold", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: null, startingBalanceDate: "2026-08-20", balanceSource: null },
      TODAY,
    );
    expect(r.isStale).toBe(false);
    expect(r.label).toBe("reconciled Aug 20");
  });

  it("never reports a negative age for a future-dated balance", () => {
    const r = resolveStalenessDisplay(
      { balanceAsOf: at(2026, 12, 25), startingBalanceDate: "2026-01-01", balanceSource: "feed" },
      TODAY,
    );
    expect(r.ageDays).toBe(0);
    expect(r.isStale).toBe(false);
  });

  it("reads balance_as_of in LOCAL time, not UTC", () => {
    // A late-evening timestamp must not render as tomorrow for anyone west
    // of Greenwich — the reason src/lib/now.ts exists at all.
    const lateEvening = new Date(2026, 8, 5, 22, 30, 0);
    const r = resolveStalenessDisplay(
      { balanceAsOf: lateEvening, startingBalanceDate: "2026-01-01", balanceSource: "feed" },
      TODAY,
    );
    expect(r.asOfIso).toBe("2026-09-05");
  });
});
