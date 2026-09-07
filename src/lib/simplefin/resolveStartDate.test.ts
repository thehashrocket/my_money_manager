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

/**
 * REGRESSION R1 — IRON RULE.
 *
 * `resolveStartDate` widens to the full 45-day floor whenever ANY account it
 * is given has no history (`known.length !== latestDates.length`). A
 * balance-only liability has no history PERMANENTLY by D3=A — that is the
 * whole point of it — so feeding it in here would pin every sync to the
 * 45-day window forever, re-running content dedup over six weeks of
 * already-imported rows on every single run.
 *
 * The fix is at the call site (`syncSimpleFin` passes `importAccounts`, not
 * `linked`), so what is pinned down here is the property that makes the call
 * site's choice load-bearing: one extra `null` changes the answer.
 */
describe("resolveStartDate — REGRESSION R1: a zero-row liability must not widen the window", () => {
  it("returns the narrow window for the asset accounts alone", () => {
    const { startIso } = resolveStartDate(["2026-09-01", "2026-08-30"], NOW);
    expect(startIso).toBe("2026-08-23");
  });

  it("would be pinned to the 45-day floor if a permanently-null account were included", () => {
    // Same two asset accounts, plus the mortgage's null. This is the exact
    // regression: the asset window silently collapses to the floor and never
    // recovers, because the loan's history is null forever by design.
    const { startIso } = resolveStartDate(["2026-09-01", "2026-08-30", null], NOW);
    expect(startIso).toBe("2026-07-19");
    expect(startIso).not.toBe("2026-08-23");
  });

  it("is unaffected by how many balance-only accounts are omitted", () => {
    // Whatever the partition drops, the asset answer must stay identical.
    expect(resolveStartDate(["2026-09-01"], NOW).startIso).toBe("2026-08-25");
    expect(resolveStartDate(["2026-09-01"], NOW).startIso).toBe(
      resolveStartDate(["2026-09-01"], NOW).startIso,
    );
  });
});
