import { describe, it, expect } from "vitest";
import { classifyBalanceFreshness } from "./balanceFreshness";

describe("classifyBalanceFreshness", () => {
  it("is conclusive only when the bank figure post-dates every ledger row", () => {
    expect(classifyBalanceFreshness("2026-09-04", "2026-09-03")).toEqual({
      state: "conclusive",
    });
  });

  it("is inconclusive when the bank figure predates the newest ledger row", () => {
    // The real case: MX stopped refreshing on the 2nd, the ledger was brought
    // current from CSV on the 3rd, and the difference was a day of activity.
    expect(classifyBalanceFreshness("2026-09-02", "2026-09-03")).toEqual({
      state: "inconclusive",
      bankAsOfDate: "2026-09-02",
      ledgerAsOfDate: "2026-09-03",
    });
  });

  it("is inconclusive on a same-day bank figure", () => {
    // A snapshot taken at 09:52 has seen some of that day and not the rest, and
    // a day-granular ledger cannot say which rows. Same day proves nothing.
    expect(classifyBalanceFreshness("2026-09-02", "2026-09-02")).toEqual({
      state: "inconclusive",
      bankAsOfDate: "2026-09-02",
      ledgerAsOfDate: "2026-09-02",
    });
  });

  it("is inconclusive when the feed omits balance-date entirely", () => {
    expect(classifyBalanceFreshness(null, "2026-09-03")).toEqual({
      state: "inconclusive",
      bankAsOfDate: null,
      ledgerAsOfDate: "2026-09-03",
    });
  });

  it("compares against the anchor date when no rows follow it", () => {
    // A freshly anchored account with no later rows still has an as-of date;
    // a bank figure older than the anchor cannot adjudicate it either.
    expect(classifyBalanceFreshness("2026-09-01", "2026-09-02")).toEqual({
      state: "inconclusive",
      bankAsOfDate: "2026-09-01",
      ledgerAsOfDate: "2026-09-02",
    });
    expect(classifyBalanceFreshness("2026-09-03", "2026-09-02")).toEqual({
      state: "conclusive",
    });
  });
});
