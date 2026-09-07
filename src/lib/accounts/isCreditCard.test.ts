import { describe, expect, it } from "vitest";
import { CARD_TYPES, isCreditCard } from "./isCreditCard";

describe("isCreditCard", () => {
  it("is true for a credit card and false for everything else", () => {
    expect(isCreditCard("credit")).toBe(true);
    expect(isCreditCard("loan")).toBe(false);
    expect(isCreditCard("checking")).toBe(false);
    expect(isCreditCard("savings")).toBe(false);
  });

  it("agrees with the derivation manualTransaction used to spell out by hand", () => {
    // The old `requireCardAccount` guard was
    // `accountClass(t) !== "liability" || isLongTermLiability(t)`. It is
    // equivalent TODAY, which is exactly why the divergence was invisible —
    // pinned here so a future enum member has to break this test rather than
    // silently split the two apart.
    const legacy = (t: "checking" | "savings" | "credit" | "loan") =>
      !(t === "checking" || t === "savings") && t !== "loan";
    for (const t of ["checking", "savings", "credit", "loan"] as const) {
      expect(isCreditCard(t)).toBe(legacy(t));
    }
  });

  it("keeps CARD_TYPES in step with the predicate", () => {
    // The SQL site can't call a function, so this is the one place the fact is
    // duplicated. Assert they say the same thing.
    for (const t of ["checking", "savings", "credit", "loan"] as const) {
      expect(CARD_TYPES.includes(t as (typeof CARD_TYPES)[number])).toBe(isCreditCard(t));
    }
  });
});
