import { describe, expect, it } from "vitest";
import type { AccountType } from "./loadAccountBalances";
import { resolveBalanceAction } from "./resolveBalanceAction";

const FEED = "ACT-d326a3ba-0000";

// The original two fixtures were the MORTGAGE and a brand-new card, which is
// what the six tests below were written about. Typed as loan/credit
// explicitly now that the third input exists, rather than left to infer.
const LINKED = { type: "loan" as AccountType, simplefinAccountId: FEED };
const UNLINKED = { type: "credit" as AccountType, simplefinAccountId: null };

const ALL_TYPES = ["checking", "savings", "credit", "loan"] as const satisfies readonly AccountType[];

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

  it("is TOTAL — every combination of all THREE inputs yields exactly one action", () => {
    for (const type of ALL_TYPES) {
      for (const simplefinAccountId of [FEED, null]) {
        for (const hasRows of [true, false]) {
          expect(["refresh", "reconcile"]).toContain(
            resolveBalanceAction({ type, simplefinAccountId }, hasRows),
          );
        }
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

  describe("D9.2 — an importing card never offers Refresh", () => {
    const IMPORTING_CARD = { type: "credit" as AccountType, simplefinAccountId: FEED };

    it("offers Reconcile even with ZERO rows, which is the whole finding", () => {
      // Before D4.3 this state resolved to "refresh" and the balance pass
      // honoured it. Now the partition steers the card away from that pass, so
      // Refresh would render a button whose only possible outcome is
      // "unchanged". Zero rows is not a corner: it is the state a freshly
      // linked card is in, and the state it RETURNS to after undoing its
      // first import.
      expect(resolveBalanceAction(IMPORTING_CARD, false)).toBe("reconcile");
    });

    it("still offers Reconcile once it has rows", () => {
      expect(resolveBalanceAction(IMPORTING_CARD, true)).toBe("reconcile");
    });

    it("leaves the linked LOAN on Refresh — the change is card-shaped, not liability-shaped", () => {
      // The mortgage is the account this branch was built for and it must not
      // move. Gating on `accountClass === "liability"` instead of the
      // predicate would have taken it out with the card.
      expect(resolveBalanceAction({ type: "loan", simplefinAccountId: FEED }, false)).toBe(
        "refresh",
      );
    });

    it("ALSO stops answering Refresh for a linked zero-row ASSET, which is a real change", () => {
      // Say it plainly: this used to return "refresh" and now returns
      // "reconcile". It is a fix, not collateral damage, and the argument for
      // it was already written down at the call site that had to work around
      // it — `refreshLiabilityBalanceAction` guards
      // `accountClass(type) !== "liability"` and its comment reads
      // "`resolveBalanceAction` answers 'refresh' for ANY zero-row feed-linked
      // account, assets included, but the balance pass only ever considers
      // liabilities."
      //
      // So the old answer was describing a capability the account never had.
      // The new first clause makes the function agree with the pass instead of
      // needing a second guard to disagree with it. Nothing renders
      // differently: `CardControls`, which holds both balance controls, mounts
      // only on a liability row. The server guard stays as belt-and-braces —
      // its message names the account type, which this cannot.
      expect(resolveBalanceAction({ type: "checking", simplefinAccountId: FEED }, false)).toBe(
        "reconcile",
      );
      expect(resolveBalanceAction({ type: "savings", simplefinAccountId: FEED }, false)).toBe(
        "reconcile",
      );
    });

    it("leaves exactly ONE shape answering Refresh: a linked, zero-row LOAN", () => {
      // The whole function, enumerated. Worth pinning as a set rather than as
      // four separate cases: the value of this change is that the surface
      // offering a feed refresh is now exactly the surface the feed pass
      // considers, and that is a statement about the complement.
      const refreshing: string[] = [];
      for (const type of ALL_TYPES) {
        for (const simplefinAccountId of [FEED, null]) {
          for (const hasRows of [true, false]) {
            if (resolveBalanceAction({ type, simplefinAccountId }, hasRows) === "refresh") {
              refreshing.push(`${type}/${simplefinAccountId ? "linked" : "unlinked"}/${hasRows ? "rows" : "empty"}`);
            }
          }
        }
      }
      expect(refreshing).toEqual(["loan/linked/empty"]);
    });
  });
});
