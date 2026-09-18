import { describe, it, expect } from "vitest";
import { buildContentCandidates, claimPendingCandidate } from "./contentCandidates";

const ROW = { date: "2026-09-01", amountCents: -4870, rawMemo: "STARBUCKS STORE 1234" };

describe("buildContentCandidates", () => {
  it("groups rows sharing a signature into one list", () => {
    const candidates = buildContentCandidates([
      { ...ROW, id: 1, isPending: false },
      { ...ROW, id: 2, isPending: false },
      { ...ROW, amountCents: -100, id: 3, isPending: false },
    ]);
    expect(candidates.size).toBe(2);
  });

  it("returns an empty map for no rows", () => {
    expect(buildContentCandidates([]).size).toBe(0);
  });
});

describe("claimPendingCandidate", () => {
  it("claims and removes a pending candidate for the signature", () => {
    const candidates = buildContentCandidates([
      { ...ROW, id: 1, isPending: true },
    ]);
    const claimed = claimPendingCandidate(candidates, "2026-09-01|-4870|STARBUCKS STORE 1234");
    expect(claimed).toEqual({ id: 1, isPending: true });
    // Claimed candidate is removed — a second claim on the same signature finds nothing.
    expect(claimPendingCandidate(candidates, "2026-09-01|-4870|STARBUCKS STORE 1234")).toBeUndefined();
  });

  it("never claims a posted candidate", () => {
    const candidates = buildContentCandidates([{ ...ROW, id: 1, isPending: false }]);
    const sig = "2026-09-01|-4870|STARBUCKS STORE 1234";
    expect(claimPendingCandidate(candidates, sig)).toBeUndefined();
    // The posted candidate is untouched — still there for the caller's own budget accounting.
    expect(candidates.get(sig)).toEqual([{ id: 1, isPending: false }]);
  });

  it("finds the pending candidate among several posted ones sharing a signature", () => {
    const candidates = buildContentCandidates([
      { ...ROW, id: 1, isPending: false },
      { ...ROW, id: 2, isPending: true },
      { ...ROW, id: 3, isPending: false },
    ]);
    const sig = "2026-09-01|-4870|STARBUCKS STORE 1234";
    const claimed = claimPendingCandidate(candidates, sig);
    expect(claimed).toEqual({ id: 2, isPending: true });
    expect(candidates.get(sig)).toHaveLength(2);
  });

  it("returns undefined for a signature with no candidates at all", () => {
    const candidates = buildContentCandidates([]);
    expect(claimPendingCandidate(candidates, "nonexistent")).toBeUndefined();
  });

  it("order among multiple pending candidates sharing a signature is unspecified — only that ONE is claimed", () => {
    // Two identical same-day pending coffees: claiming must remove exactly
    // one, and the caller must not depend on WHICH one comes back.
    const candidates = buildContentCandidates([
      { ...ROW, id: 1, isPending: true },
      { ...ROW, id: 2, isPending: true },
    ]);
    const sig = "2026-09-01|-4870|STARBUCKS STORE 1234";
    const claimed = claimPendingCandidate(candidates, sig);
    expect([1, 2]).toContain(claimed?.id);
    expect(candidates.get(sig)).toHaveLength(1);
  });
});
