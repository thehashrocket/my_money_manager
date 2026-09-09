import { describe, expect, it } from "vitest";
import { ALL_KINDS, kindsImplyUsed } from "@/lib/budget/kindsImplyUsed";
import {
  assignableKinds,
  isCategoryUsed,
  type CategoryKind,
  type CategoryKindUsage,
  NO_USAGE,
} from "@/lib/budget/categoryKindLock";

/**
 * The three claims `CategoryMenu`'s confirm step rests on.
 *
 * `_category-menu.tsx` decides whether to interpose a "this cannot be undone"
 * dialog with ONE expression — `assignableKinds.length < 3` — and its docblock
 * spells out the chain that makes that sound:
 *
 *   1. three kinds  ⟺  the category is UNUSED (so the change is reversible)
 *   2. fewer than three on a used category  ⇒  the only change on offer is X1
 *   3. X1 is ONE-WAY: income → expense is refused on the same usage
 *
 * Every step of that is a property of `assignableKinds`, not of React — so it
 * is testable here even though the component itself is out of scope under
 * CLAUDE.md's "tests for UI components (categorization logic only)" exclusion.
 * `categoryKindLock.test.ts` pins each case individually; what is NOT pinned
 * anywhere is the chain AS A BICONDITIONAL, which is the thing a menu reading
 * `< 3` actually depends on. Weaken any link and the dialog either stops
 * appearing before an irreversible write or starts appearing on a reversible
 * one, and `tsc` cannot see either.
 */

// The schema enum's own list, not a fourth hand-copy of it.
const KINDS: readonly CategoryKind[] = ALL_KINDS;

/**
 * Every usage shape that can reach `assignableKinds`, including the impossible
 * -looking ones. `negativeTxnCount` is a subset count of `txnCount`, so it is
 * never generated larger; everything else is free.
 */
function usageShapes(): CategoryKindUsage[] {
  const shapes: CategoryKindUsage[] = [];
  for (const txnCount of [0, 1, 4]) {
    for (const negativeTxnCount of [0, 1, 4].filter((n) => n <= txnCount)) {
      for (const periodCount of [0, 1, 3]) {
        shapes.push({ txnCount, negativeTxnCount, periodCount });
      }
    }
  }
  return shapes;
}

describe("the predicate CategoryMenu actually evaluates (`kindsImplyUsed`)", () => {
  it("is the biconditional, through the extracted function rather than the literal", () => {
    // The gap this closes: every other test in this file asserts things about
    // `assignableKinds`, so `kindsImplyUsed`'s body could be changed to
    // `< 2` — silently removing the confirm dialog from the one-way X1 write —
    // and the entire suite stayed green. The module was extracted precisely
    // because the literal was "restated in a component where no test could
    // reach it", and then it was not tested. This is that test.
    for (const usage of usageShapes()) {
      for (const kind of KINDS) {
        expect({ usage, kind, used: kindsImplyUsed(assignableKinds(kind, usage)) }).toEqual({
          usage,
          kind,
          used: isCategoryUsed(usage),
        });
      }
    }
  });

  it("keys off the schema enum's arity, so a fourth kind cannot silently un-gate it", () => {
    // `ALL_KINDS.length` is the whole point: hardcoding 3 meant adding a kind
    // would make an UNUSED category read as used, putting "This cannot be
    // undone" in front of a reversible change.
    expect(ALL_KINDS).toHaveLength(3);
    expect(kindsImplyUsed(ALL_KINDS)).toBe(false);
    expect(kindsImplyUsed(ALL_KINDS.slice(0, 2))).toBe(true);
  });
});

describe("the premise CategoryMenu's confirm step reads (`assignableKinds.length < 3`)", () => {
  it("(1) offers all three kinds if and only if the category is UNUSED", () => {
    // The biconditional, both directions, over every reachable usage shape.
    // The menu inverts this: `< 3` is its test for "used", so a usage that
    // collapsed the list for any OTHER reason would make it confirm a change
    // that is in fact reversible — and, worse, a used category that somehow
    // kept all three would skip the dialog before an irreversible write.
    for (const usage of usageShapes()) {
      for (const kind of KINDS) {
        const offersAllThree = assignableKinds(kind, usage).length === 3;
        expect({ usage, kind, offersAllThree }).toEqual({
          usage,
          kind,
          offersAllThree: !isCategoryUsed(usage),
        });
      }
    }
  });

  it("(2) offers exactly X1 — expense → income — whenever a USED category still offers a change", () => {
    // "On a used category the only change this menu can offer IS X1." If some
    // future transition were added to `assignableKinds` without a matching
    // review of the dialog copy, this fails: the dialog says in as many words
    // that the change cannot be undone, which is true of X1 and need not be
    // true of anything else.
    for (const usage of usageShapes()) {
      if (!isCategoryUsed(usage)) continue;
      for (const kind of KINDS) {
        const offered = assignableKinds(kind, usage);
        const changes = offered.filter((k) => k !== kind);
        if (changes.length === 0) continue;
        expect({ usage, from: kind, changes }).toEqual({
          usage,
          from: "expense" as CategoryKind,
          changes: ["income"],
        });
      }
    }
  });

  it("(3) X1 is one-way: the same usage refuses income → expense, so there is genuinely no undo", () => {
    // The claim the dialog's red line makes. `setCategoryKind` does not change
    // a category's transactions, so the usage that permitted X1 is the usage
    // in force immediately after it — and from `income` that same usage offers
    // nothing but `income`.
    const x1Usage: CategoryKindUsage = { txnCount: 4, negativeTxnCount: 0, periodCount: 0 };

    expect(assignableKinds("expense", x1Usage).sort()).toEqual(["expense", "income"]);
    expect(assignableKinds("income", x1Usage)).toEqual(["income"]);
  });

  it("(3b) a period-ONLY used category offers no change at all, so the dialog is unreachable for it", () => {
    // The `budget_periods` half of `isCategoryUsed`, which v0.23.0's editable
    // FUNDS band made reachable: one `$0` allocation makes a category used
    // with zero transactions.
    //
    // X1 does NOT apply here, and the reason is worth pinning next to the
    // menu's premise. X1's evidence is "every row filed here is positive",
    // which needs rows — a planned row is not that evidence, so the
    // all-positive test is not satisfied vacuously. The list therefore
    // collapses to one entry, `CategoryMenu` renders the locked label instead
    // of any "Set kind" item, and `kindChangeIsIrreversible` is true but never
    // consulted. That is the branch that would silently invert if X1 were ever
    // relaxed to count zero rows as all-positive.
    const periodOnly: CategoryKindUsage = { txnCount: 0, negativeTxnCount: 0, periodCount: 2 };

    for (const kind of KINDS) {
      expect(assignableKinds(kind, periodOnly)).toEqual([kind]);
    }
  });

  it("never offers a reversible-looking single change on an UNUSED category", () => {
    // The complement of (2), and the reason the menu does NOT confirm here: an
    // unused category always offers all three, so every change from it is one
    // of two others and each is freely undoable. A dialog on this path is the
    // friction the docblock deliberately refuses.
    for (const kind of KINDS) {
      const offered = assignableKinds(kind, NO_USAGE);
      expect(offered.sort()).toEqual(["expense", "fund", "income"]);
      expect(offered.filter((k) => k !== kind)).toHaveLength(2);
    }
  });
});
