import { describe, expect, it } from "vitest";
import { resolveBalanceAction } from "./resolveBalanceAction";

const LINKED = { simplefinAccountId: "ACT-d326a3ba-0000" };
const UNLINKED = { simplefinAccountId: null };

describe("resolveBalanceAction", () => {
  it("offers Refresh for a linked account with no rows — the mortgage", () => {
    expect(resolveBalanceAction(LINKED, false)).toBe("refresh");
  });

  it("offers Reconcile for a linked account that has grown rows", () => {
    // A case DS55 only styled: this account kept offering Refresh while
    // D7/D15's zero-row-scoped balance pass silently skipped it every run.
    expect(resolveBalanceAction(LINKED, true)).toBe("reconcile");
  });

  it("offers Reconcile for an unlinked account with no rows — a brand-new card (E4)", () => {
    // The bug: nothing set balance_source at account creation, so a card
    // created today rendered with neither action, and Reconcile is the only
    // way a card balance can be updated at all under D15.
    expect(resolveBalanceAction(UNLINKED, false)).toBe("reconcile");
  });

  it("offers Reconcile for an unlinked account with rows", () => {
    expect(resolveBalanceAction(UNLINKED, true)).toBe("reconcile");
  });

  it("is TOTAL — every combination of both inputs yields exactly one action", () => {
    for (const account of [LINKED, UNLINKED]) {
      for (const hasRows of [true, false]) {
        expect(["refresh", "reconcile"]).toContain(resolveBalanceAction(account, hasRows));
      }
    }
  });

  it("never returns neither, which is the failure DS55 promised could not happen", () => {
    const results = [
      resolveBalanceAction(LINKED, false),
      resolveBalanceAction(LINKED, true),
      resolveBalanceAction(UNLINKED, false),
      resolveBalanceAction(UNLINKED, true),
    ];
    expect(results.every((r) => r === "refresh" || r === "reconcile")).toBe(true);
    expect(results.filter((r) => r === "refresh")).toHaveLength(1);
  });
});
