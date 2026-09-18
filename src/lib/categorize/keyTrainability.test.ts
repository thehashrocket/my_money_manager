import { describe, expect, it } from "vitest";
import {
  classifyKeyTrainability,
  describeRuleAction,
  filedCategoryIdsAfterMove,
  LOSSY_MERCHANT_KEYS,
  resolveRememberUi,
  ruleActionLabel,
  ruleActionSignature,
  type RuleAction,
} from "./keyTrainability";

describe("classifyKeyTrainability — lossy keys", () => {
  it("refuses ONLINE, the live key covering 39 unrelated Star One transfers", () => {
    const verdict = classifyKeyTrainability("ONLINE", [7], 7);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    expect(verdict.reason).toBe("lossy-key");
    expect(verdict.message).toContain("ONLINE");
  });

  it("refuses MOBILE", () => {
    expect(classifyKeyTrainability("MOBILE", [7], 7).trainable).toBe(false);
  });

  it("refuses the empty key with its own wording, not the channel wording", () => {
    const verdict = classifyKeyTrainability("", [], 3);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    expect(verdict.reason).toBe("lossy-key");
    // The channel sentence names the key in quotes; for a blank key that would
    // render as a bare pair of quotes and read like a bug.
    expect(verdict.message).toContain("no merchant name");
    expect(verdict.message).not.toContain('""');
  });

  it("refuses a lossy key even when nothing has ever been filed under it", () => {
    // Distinguishes the lossy branch from the multi-category one: with zero
    // filed categories the second test cannot fire, so a pass here proves the
    // first branch is doing the work.
    expect(classifyKeyTrainability("ONLINE", [], 3).trainable).toBe(false);
  });

  it("does NOT refuse the overdraft keys, which are accurate rather than lossy", () => {
    // Pins the deliberate exclusion documented on LOSSY_MERCHANT_KEYS. These
    // are the two highest-volume single-word keys in the live ledger, so an
    // over-eager addition to the set would show up here first.
    expect(
      classifyKeyTrainability("WITHDRAWAL-OVERDRAFT", [3], 3).trainable,
    ).toBe(true);
    expect(classifyKeyTrainability("DEPOSIT-OVERDRAFT", [3], 3).trainable).toBe(
      true,
    );
  });

  it("matches the key exactly — a real merchant containing a lossy token is fine", () => {
    // `MOBILE DEPOSIT STAR ONE CU` is a live key with 7 rows and a genuine
    // meaning. A substring test instead of set membership would kill it.
    expect(
      classifyKeyTrainability("MOBILE DEPOSIT STAR ONE CU", [3], 3).trainable,
    ).toBe(true);
    expect(LOSSY_MERCHANT_KEYS.has("MOBILE DEPOSIT STAR ONE CU")).toBe(false);
  });
});

describe("classifyKeyTrainability — multi-category keys", () => {
  it("allows a key filed consistently to one category", () => {
    expect(classifyKeyTrainability("SAFEWAY", [3, 3, 3], 3).trainable).toBe(
      true,
    );
  });

  it("allows a brand-new key with no filing history", () => {
    expect(classifyKeyTrainability("BLOCK 21 WINERY", [], 3).trainable).toBe(
      true,
    );
  });

  it("refuses a key already split across two categories (live: AMAZON)", () => {
    const verdict = classifyKeyTrainability("AMAZON", [3, 9], 3);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    expect(verdict.reason).toBe("multi-category");
    expect(verdict.message).toContain("2 different categories");
  });

  it("refuses at the moment a second category is introduced by the pending pick", () => {
    // The case the pending argument exists for: history is unanimous, and the
    // category being assigned right now is what makes one exact rule unable to
    // be right. Checking history alone would return trainable here.
    const historyOnly = classifyKeyTrainability("COSTCO WHSE", [3, 3], null);
    expect(historyOnly.trainable).toBe(true);

    const withPendingPick = classifyKeyTrainability("COSTCO WHSE", [3, 3], 9);
    expect(withPendingPick.trainable).toBe(false);
  });

  it("does NOT claim history it does not have when the PICK is the second category", () => {
    // The refusal message is the user's only explanation for a disabled
    // checkbox. Reporting the union's size as history said "already filed under
    // 2 different categories" about a merchant filed under exactly one, and
    // sent the reader looking for a second category's worth of rows that do not
    // exist. The verdict still comes from the union; only the sentence does not.
    const verdict = classifyKeyTrainability("SAFEWAY", [3], 9);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    expect(verdict.reason).toBe("multi-category");
    expect(verdict.message).not.toContain("2 different categories");
    expect(verdict.message).toContain("already filed under a different");
  });

  it("allows a pick that AGREES with the key's single filed category", () => {
    // The confirming gesture. It has to stay trainable, because a refusal here
    // is also what licensed deleting the rule the user was confirming.
    expect(classifyKeyTrainability("AUDIBLE", [3], 3).trainable).toBe(true);
  });

  it("has no sample-size floor — one prior filing agreeing with the pick is trainable", () => {
    // Documents the deliberate absence of a confidence threshold: this
    // function tests contradiction, and one filing cannot contradict anything.
    expect(classifyKeyTrainability("AUDIBLE", [3, 3], 3).trainable).toBe(true);
  });

  it("counts DISTINCT categories, not filings", () => {
    const many = Array.from({ length: 50 }, () => 3);
    expect(classifyKeyTrainability("STARBUCKS", many, 3).trainable).toBe(true);
  });
});

describe("classifyKeyTrainability — what counts as a category id", () => {
  it("ignores a blank pick, which the client hands over as 0", () => {
    // `/categorize` renders the checkbox before a category is chosen, and the
    // combobox's empty value goes through `Number("")` → 0. Counted as a real
    // id it reads as a second category on every already-filed key, disabling
    // Remember with the multi-category sentence before the user has picked
    // anything at all.
    expect(classifyKeyTrainability("SAFEWAY", [3], 0).trainable).toBe(true);
  });

  it("ignores a corrupted parked pick, which arrives as NaN", () => {
    // Defensive: a pending pick reaches this function as a raw string run
    // through `Number(...)`, which can yield NaN for non-numeric input. NaN
    // is distinct from every real id under Set semantics, so it used to
    // count as a category.
    expect(classifyKeyTrainability("SAFEWAY", [3], Number.NaN).trainable).toBe(
      true,
    );
  });

  it("ignores non-positive ids in the FILED list too", () => {
    // Same rule applied to the other argument, so the two sides cannot disagree
    // about what an id is.
    expect(classifyKeyTrainability("SAFEWAY", [3, 0, -1], 3).trainable).toBe(
      true,
    );
  });
});

describe("classifyKeyTrainability — precedence", () => {
  it("reports lossy, not multi-category, when a key is both", () => {
    // ONLINE is filed to two categories on the live ledger as well. The
    // lossy explanation is the actionable one — no rule will ever be right,
    // whereas "already filed under 2 categories" invites the user to go and
    // tidy the filings.
    const verdict = classifyKeyTrainability("ONLINE", [3, 9], 3);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    expect(verdict.reason).toBe("lossy-key");
  });
});

/**
 * Ship review (Codex adversarial + structured, cross-model): mirrors
 * `applyRuleWrite`'s `shouldDelete` exactly (`allowRuleRemoval && existing !==
 * undefined && (reason === "lossy-key" || existing.categoryId !== categoryId)`)
 * — `/categorize` and `/transactions` both pass `allowRuleRemoval: true`
 * unconditionally, so that half of the server condition is a constant here.
 * Each case below is named after the matching branch in `applyRuleWrite.ts`.
 */
describe("describeRuleAction", () => {
  it("returns train when the verdict is trainable, regardless of any existing rule", () => {
    const verdict = classifyKeyTrainability("SAFEWAY", [], 3);
    const action = describeRuleAction("SAFEWAY", verdict, { categoryId: 9, categoryName: "Gas" }, 3);
    expect(action).toEqual({ kind: "train" });
  });

  it("returns none (with the verdict's message) when untrainable and there is no existing rule to remove", () => {
    const verdict = classifyKeyTrainability("SAFEWAY", [3, 9], 3);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    const action = describeRuleAction("SAFEWAY", verdict, null, 3);
    expect(action).toEqual({ kind: "none", message: verdict.message });
  });

  it("returns none before any category is picked, even with an existing rule pointing elsewhere", () => {
    // pendingCategoryId === null: there is no pick to contradict anything
    // with yet, so offering removal would be a guess.
    const verdict = classifyKeyTrainability("ONLINE", [], null);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    const action = describeRuleAction(
      "ONLINE",
      verdict,
      { categoryId: 9, categoryName: "Gas" },
      null,
    );
    expect(action).toEqual({ kind: "none", message: verdict.message });
  });

  // PR review, test-coverage pass (finding 3): a corrupted pending pick
  // arrives here as NaN, same as it does at `classifyKeyTrainability`'s own
  // `pendingCategoryId` — this function has to reject it the identical way,
  // or a corrupted pick renders "Remove conflicting rule" as ENABLED with no
  // real pick behind it.
  it.each([Number.NaN, 0, -1])(
    "returns none for a non-real pendingCategoryId (%s), even with an existing rule pointing elsewhere",
    (badPending) => {
      // filed=[3, 9] (multi-category) refuses regardless of pending, so the
      // verdict is reliably untrainable for every bad `badPending` value —
      // isolating what's under test: does describeRuleAction itself reject
      // a non-real pending id, the same way classifyKeyTrainability does.
      const verdict = classifyKeyTrainability("SAFEWAY", [3, 9], badPending);
      expect(verdict.trainable).toBe(false);
      if (verdict.trainable) return;
      const action = describeRuleAction(
        "SAFEWAY",
        verdict,
        { categoryId: 9, categoryName: "Gas" },
        badPending,
      );
      expect(action).toEqual({ kind: "none", message: verdict.message });
    },
  );

  it("returns remove-conflicting (reason: lossy-key) for a lossy key with an existing rule, even one pointing at the same pick", () => {
    // `applyRuleWrite`'s shouldDelete is `reason === "lossy-key" || ...` — the
    // OR short-circuits, so a lossy key removes its rule unconditionally,
    // even in the coincidental case where the existing rule already points
    // at the category being picked now.
    const verdict = classifyKeyTrainability("ONLINE", [], 9);
    expect(verdict).toEqual({
      trainable: false,
      reason: "lossy-key",
      message: expect.any(String),
    });
    const action = describeRuleAction(
      "ONLINE",
      verdict,
      { categoryId: 9, categoryName: "Gas" },
      9,
    );
    expect(action.kind).toBe("remove-conflicting");
    if (action.kind !== "remove-conflicting") return;
    expect(action.reason).toBe("lossy-key");
    // Ship review, cycle 2 (Codex adversarial, second pass): the existing
    // rule already points at the category being picked (9 === 9) — the
    // pick does NOT contradict it. The message must blame the LOSSY key,
    // never claim a contradiction that isn't there.
    expect(action.message).toContain("lossy");
    expect(action.message).not.toContain("contradicts");
  });

  it("returns remove-conflicting (reason: contradicted) for multi-category when the existing rule points somewhere else", () => {
    const verdict = classifyKeyTrainability("SAFEWAY", [3, 9], 3);
    expect(verdict).toEqual({
      trainable: false,
      reason: "multi-category",
      message: expect.any(String),
    });
    const action = describeRuleAction(
      "SAFEWAY",
      verdict,
      { categoryId: 9, categoryName: "Gas" },
      3,
    );
    expect(action.kind).toBe("remove-conflicting");
    if (action.kind !== "remove-conflicting") return;
    expect(action.reason).toBe("contradicted");
  });

  it("returns none for multi-category when the existing rule already points at the current pick — confirming, not contradicting", () => {
    // `applyRuleWrite`'s own documented case: "the rule pointed exactly
    // where the user had just pointed, and deleting it left every future K
    // row uncategorized — strictly worse than the rule."
    const verdict = classifyKeyTrainability("SAFEWAY", [3, 9], 9);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    const action = describeRuleAction(
      "SAFEWAY",
      verdict,
      { categoryId: 9, categoryName: "Gas" },
      9,
    );
    expect(action).toEqual({ kind: "none", message: verdict.message });
  });

  it("names the merchant and the existing rule's category in the remove-conflicting message", () => {
    const verdict = classifyKeyTrainability("SAFEWAY", [3, 9], 3);
    const action = describeRuleAction(
      "SAFEWAY",
      verdict,
      { categoryId: 9, categoryName: "Gas" },
      3,
    );
    if (action.kind !== "remove-conflicting") throw new Error("expected remove-conflicting");
    expect(action.message).toContain("Gas");
    expect(action.message).toContain("SAFEWAY");
  });
});

describe("ruleActionLabel", () => {
  it('labels "train" as Remember', () => {
    expect(ruleActionLabel({ kind: "train" })).toBe("Remember");
  });

  it('labels "none" as Remember', () => {
    expect(ruleActionLabel({ kind: "none", message: "unused" })).toBe("Remember");
  });

  it('labels remove-conflicting/lossy-key as "Remove unusable rule", never "conflicting" — the label this function was extracted to fix', () => {
    const verdict = classifyKeyTrainability("ONLINE", [], 9);
    const action = describeRuleAction("ONLINE", verdict, { categoryId: 9, categoryName: "Gas" }, 9);
    expect(ruleActionLabel(action)).toBe("Remove unusable rule");
  });

  it('labels remove-conflicting/contradicted as "Remove conflicting rule"', () => {
    const verdict = classifyKeyTrainability("SAFEWAY", [3, 9], 3);
    const action = describeRuleAction(
      "SAFEWAY",
      verdict,
      { categoryId: 9, categoryName: "Gas" },
      3,
    );
    expect(ruleActionLabel(action)).toBe("Remove conflicting rule");
  });
});

describe("resolveRememberUi", () => {
  it("composes a trainable pick into an enabled, message-less, Remember-labelled action", () => {
    const ui = resolveRememberUi("SAFEWAY", [], null, 9);
    expect(ui.action).toEqual({ kind: "train" });
    expect(ui.enabled).toBe(true);
    expect(ui.message).toBeUndefined();
    expect(ui.label).toBe("Remember");
  });

  it("composes an untrainable pick with no existing rule into a disabled, message-carrying none", () => {
    const ui = resolveRememberUi("ONLINE", [], null, null);
    expect(ui.action.kind).toBe("none");
    expect(ui.enabled).toBe(false);
    expect(ui.message).toContain("ONLINE");
    expect(ui.label).toBe("Remember");
  });

  it("composes a lossy key with an existing rule into an enabled removal, labelled and messaged for it", () => {
    const ui = resolveRememberUi("ONLINE", [], { categoryId: 9, categoryName: "Gas" }, 9);
    expect(ui.action).toEqual({
      kind: "remove-conflicting",
      reason: "lossy-key",
      message: ui.message,
    });
    expect(ui.enabled).toBe(true);
    expect(ui.message).toContain("Gas");
    expect(ui.label).toBe("Remove unusable rule");
  });

  it("composes a contradicted multi-category pick into an enabled removal, labelled and messaged for it", () => {
    const ui = resolveRememberUi("SAFEWAY", [3, 9], { categoryId: 9, categoryName: "Gas" }, 3);
    expect(ui.action.kind).toBe("remove-conflicting");
    expect(ui.enabled).toBe(true);
    expect(ui.message).toContain("Gas");
    expect(ui.label).toBe("Remove conflicting rule");
  });

  /**
   * Testing specialist (ship review): both render sites now call
   * `resolveRememberUi` exclusively rather than `describeRuleAction`
   * directly — a non-real `pendingCategoryId` (0, NaN, negative) was already
   * proven bug-prone at that lower layer (see the `it.each` block above), so
   * the composition itself needs the same proof, not just its ingredients.
   */
  it.each([0, Number.NaN, -1])(
    "never returns remove-conflicting for a non-real pendingCategoryId (%s), even with a contradicting existing rule",
    (pendingCategoryId) => {
      // filed=[3, 9] (multi-category) refuses regardless of pending, isolating
      // what's under test: does the COMPOSITION reject a non-real pending id
      // the same way `describeRuleAction` alone already does (see the
      // `describeRuleAction` suite's own `it.each` of the same shape).
      const ui = resolveRememberUi(
        "SAFEWAY",
        [3, 9],
        { categoryId: 9, categoryName: "Gas" },
        pendingCategoryId,
      );
      expect(ui.action.kind).toBe("none");
    },
  );

  /**
   * Testing specialist (ship review): the "confirming, not contradicting"
   * path has its own dedicated `describeRuleAction` test, but was never
   * exercised through `resolveRememberUi` — the function both components
   * actually call.
   */
  it("composes a pick that agrees with the existing rule into a disabled, unmessaged none — confirming, not contradicting", () => {
    const ui = resolveRememberUi("SAFEWAY", [3, 9], { categoryId: 9, categoryName: "Gas" }, 9);
    expect(ui.action.kind).toBe("none");
    expect(ui.enabled).toBe(false);
    expect(ui.label).toBe("Remember");
  });
});

describe("ruleActionSignature", () => {
  it("gives the same train signature for the same merchant and pick", () => {
    expect(ruleActionSignature("SAFEWAY", { kind: "train" }, 9)).toBe(
      ruleActionSignature("SAFEWAY", { kind: "train" }, 9),
    );
  });

  /**
   * Codex structured review AND an independent Codex adversarial pass, both
   * against the live PR: a bare `"train"` signature (no `pendingCategoryId`)
   * let stale consent survive a target change with no new click — pick A,
   * tick Remember, then have `_transaction-row.tsx`'s picker auto-resync to
   * B after an unrelated `bulkRetarget` moved this merchant's rows, or
   * simply repick to B by hand. Both renders were "train", so the signature
   * never changed and the box stayed checked while about to submit a
   * different target than the one consented to.
   */
  it("gives two train actions DIFFERENT signatures when the pick differs, even though `kind` stays identical", () => {
    expect(ruleActionSignature("SAFEWAY", { kind: "train" }, 3)).not.toBe(
      ruleActionSignature("SAFEWAY", { kind: "train" }, 9),
    );
  });

  /**
   * A second Codex structured-review pass, re-verifying the fix above:
   * `pnpm db:backfill-merchants` (rule 10) renames a row's
   * `normalized_merchant` in place, and `_transaction-row.tsx`'s
   * transaction-id-keyed component survives that rename — the ONE write
   * path that changes a row's merchant key without changing which row it
   * is. `train:9` for two different merchants used to be the same string.
   */
  it("gives two train actions DIFFERENT signatures when the merchant differs, even with the same pick", () => {
    expect(ruleActionSignature("AMAZON", { kind: "train" }, 9)).not.toBe(
      ruleActionSignature("WALMART", { kind: "train" }, 9),
    );
  });

  it("gives two remove-conflicting actions with the same merchant, message, AND pick the same signature", () => {
    const a = describeRuleAction(
      "SAFEWAY",
      classifyKeyTrainability("SAFEWAY", [3, 9], 3),
      { categoryId: 9, categoryName: "Gas" },
      3,
    );
    const b = describeRuleAction(
      "SAFEWAY",
      classifyKeyTrainability("SAFEWAY", [3, 9], 3),
      { categoryId: 9, categoryName: "Gas" },
      3,
    );
    expect(ruleActionSignature("SAFEWAY", a, 3)).toBe(ruleActionSignature("SAFEWAY", b, 3));
  });

  it("gives two remove-conflicting actions DIFFERENT signatures when the target rule differs, even though `kind` stays identical — the exact bug this exists to catch", () => {
    // Same merchant, same pick, but a sibling row's write repointed the
    // existing rule at a different category — `kind` alone cannot tell
    // these apart, which is exactly what let a stale consent silently
    // survive a retargeted rule before `ruleActionSignature` folded in
    // `message`.
    const pointingAtGas = describeRuleAction(
      "SAFEWAY",
      classifyKeyTrainability("SAFEWAY", [3, 9], 3),
      { categoryId: 9, categoryName: "Gas" },
      3,
    );
    const pointingAtDining = describeRuleAction(
      "SAFEWAY",
      classifyKeyTrainability("SAFEWAY", [3, 12], 3),
      { categoryId: 12, categoryName: "Dining" },
      3,
    );
    expect(pointingAtGas.kind).toBe("remove-conflicting");
    expect(pointingAtDining.kind).toBe("remove-conflicting");
    expect(ruleActionSignature("SAFEWAY", pointingAtGas, 3)).not.toBe(
      ruleActionSignature("SAFEWAY", pointingAtDining, 3),
    );
  });

  it("gives two remove-conflicting actions DIFFERENT signatures when the merchant differs, even with the same message and pick", () => {
    const action: RuleAction = {
      kind: "remove-conflicting",
      reason: "contradicted",
      message: "→ Gas",
    };
    expect(ruleActionSignature("AMAZON", action, 3)).not.toBe(
      ruleActionSignature("WALMART", action, 3),
    );
  });

  it("never collides a train signature with a remove-conflicting or none signature", () => {
    const train = ruleActionSignature("SAFEWAY", { kind: "train" }, 9);
    const removeConflicting = ruleActionSignature(
      "SAFEWAY",
      { kind: "remove-conflicting", reason: "lossy-key", message: "train" },
      9,
    );
    const none = ruleActionSignature("SAFEWAY", { kind: "none", message: "train" }, 9);
    expect(new Set([train, removeConflicting, none]).size).toBe(3);
  });

  /**
   * Testing specialist (ship review): the same rigor applied to
   * `remove-conflicting` above, applied to `none` — harmless in practice
   * today (a disabled checkbox's `onChange` can never fire, so a `"none"`
   * signature can never actually be stored as `consentedSignature`), but the
   * function's own contract is "every `RuleAction` variant gets a distinct
   * signature for a distinct message", and `none` was the one variant never
   * checked against itself.
   */
  it("gives two none actions with different messages different signatures", () => {
    const a = ruleActionSignature("SAFEWAY", { kind: "none", message: "reason A" }, 9);
    const b = ruleActionSignature("SAFEWAY", { kind: "none", message: "reason B" }, 9);
    expect(a).not.toBe(b);
  });
});

describe("filedCategoryIdsAfterMove", () => {
  it("drops the category being moved away from", () => {
    expect(filedCategoryIdsAfterMove([3, 7, 9], 7)).toEqual([3, 9]);
  });

  it("is a no-op when the category isn't in the list at all", () => {
    expect(filedCategoryIdsAfterMove([3, 9], 7)).toEqual([3, 9]);
  });

  it("is a no-op when nothing has been picked as the source yet", () => {
    expect(filedCategoryIdsAfterMove([3, 7, 9], null)).toEqual([3, 7, 9]);
  });

  it("drops every matching entry, not just the first", () => {
    // Not reachable through `loadFiledCategoryIds` today (it's DISTINCT per
    // category), but the function's own contract is a plain filter, not
    // "remove the first match" — pin that directly.
    expect(filedCategoryIdsAfterMove([7, 3, 7, 9], 7)).toEqual([3, 9]);
  });
});
