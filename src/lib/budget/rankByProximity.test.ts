import { describe, expect, it } from "vitest";
import { rankByProximity } from "./rankByProximity";
import type { LeafRow } from "./loadMonthView";

function leaf(
  name: string,
  opts: { allocated?: number | null; spent?: number; pending?: number },
): LeafRow {
  const allocated = opts.allocated ?? null;
  const spent = opts.spent ?? 0;
  const effective = allocated ?? 0;
  return {
    categoryId: name.length + spent,
    name,
    parentId: null,
    carryoverPolicy: "none",
    allocation:
      allocated === null
        ? null
        : { allocatedCents: allocated, rolloverCents: 0, effectiveCents: allocated },
    spentCents: spent,
    pendingCents: opts.pending ?? 0,
    remainingCents: effective - spent,
    isOverspent: spent > effective,
  };
}

describe("rankByProximity", () => {
  it("produces FOUR DISTINCT positions for the cases barPct alone flattens", () => {
    // The whole reason this function exists. resolveRowDisplay caps barPct at
    // 100 AND flattens zero-allocation overspend to exactly 100, so sorting
    // by it puts these three in arbitrary order.
    const ranked = rankByProximity(
      [
        leaf("Gas", { allocated: 15_000, spent: 11_850 }), // 79%
        leaf("Dining", { allocated: 20_000, spent: 16_000 }), // 80%
        leaf("Groceries", { allocated: 50_000, spent: 60_000 }), // 120%, $100 over
        leaf("Fun money", { allocated: null, spent: 60_000 }), // no budget at all
      ],
      "open",
      5,
    );

    expect(ranked.map((r) => r.name)).toEqual(["Fun money", "Groceries", "Dining", "Gas"]);
  });

  it("puts overflow rows first, ordered by the TRUE overage", () => {
    // barPct is identical (100) for both; only the badge carries the real
    // number, which is why the badge is the primary key.
    const ranked = rankByProximity(
      [
        leaf("Small overage", { allocated: 10_000, spent: 11_000 }), // $10 over
        leaf("Big overage", { allocated: 10_000, spent: 40_000 }), // $300 over
      ],
      "open",
      5,
    );
    expect(ranked.map((r) => r.name)).toEqual(["Big overage", "Small overage"]);
  });

  it("ranks a fully-spent envelope above a nearly-spent one", () => {
    const ranked = rankByProximity(
      [
        leaf("Half", { allocated: 10_000, spent: 5_000 }),
        leaf("Full", { allocated: 10_000, spent: 10_000 }),
        leaf("Most", { allocated: 10_000, spent: 9_000 }),
      ],
      "open",
      5,
    );
    expect(ranked.map((r) => r.name)).toEqual(["Full", "Most", "Half"]);
  });

  it("breaks a barPct tie by the smaller absolute headroom", () => {
    // Both at 50%, but one has $50 of room left and the other $5,000.
    const ranked = rankByProximity(
      [
        leaf("Large", { allocated: 1_000_000, spent: 500_000 }),
        leaf("Small", { allocated: 10_000, spent: 5_000 }),
      ],
      "open",
      5,
    );
    expect(ranked.map((r) => r.name)).toEqual(["Small", "Large"]);
  });

  it("breaks a full tie by name, so the order is stable across renders", () => {
    const ranked = rankByProximity(
      [
        leaf("Zebra", { allocated: 10_000, spent: 5_000 }),
        leaf("Apple", { allocated: 10_000, spent: 5_000 }),
      ],
      "open",
      5,
    );
    expect(ranked.map((r) => r.name)).toEqual(["Apple", "Zebra"]);
  });

  it("drops leaves with neither an allocation nor any spend", () => {
    // Not "close to its limit" — simply unused. Listing it would push a real
    // row off the end of a five-row section.
    const ranked = rankByProximity(
      [
        leaf("Unused", { allocated: null, spent: 0 }),
        leaf("Zero budget, zero spend", { allocated: 0, spent: 0 }),
        leaf("Real", { allocated: 10_000, spent: 1_000 }),
      ],
      "open",
      5,
    );
    expect(ranked.map((r) => r.name)).toEqual(["Real"]);
  });

  it("keeps a budgeted-but-unspent envelope, which is legitimately at 0%", () => {
    const ranked = rankByProximity([leaf("Budgeted", { allocated: 10_000, spent: 0 })], "open", 5);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].display.barPct).toBe(0);
  });

  it("honours the limit — 5 on desktop, 3 on mobile (DS53)", () => {
    const leaves = Array.from({ length: 10 }, (_, i) =>
      leaf(`Cat ${i}`, { allocated: 10_000, spent: i * 1_000 }),
    );
    expect(rankByProximity(leaves, "open", 5)).toHaveLength(5);
    expect(rankByProximity(leaves, "open", 3)).toHaveLength(3);
  });

  it("returns an empty array for an empty month, so the section can be omitted", () => {
    expect(rankByProximity([], "open", 5)).toEqual([]);
  });

  it("carries the display object through, so the renderer adds no rules of its own", () => {
    const [row] = rankByProximity([leaf("Groceries", { allocated: 50_000, spent: 60_000 })], "open", 5);
    expect(row.display.barTone).toBe("amber");
    expect(row.display.badges).toContainEqual({ type: "overflow", amountCents: 10_000 });
    // DS53/DS8': the bar stays amber past 100% — the overflow tick is the red
    // signal, not a redbrown bar.
    expect(row.display.barTone).not.toBe("redbrown");
  });
});
