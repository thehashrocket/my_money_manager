import { describe, expect, it } from "vitest";
import { validateBulkRetargetSnapshot } from "./validateBulkRetargetSnapshot";

const valid = {
  normalizedMerchant: "COSTCO WHSE",
  fromCategoryId: 9,
  categoryId: 4,
  txnIds: [1, 2, 3],
  ruleTouched: true,
  priorRule: null,
  insertedRuleId: 7,
  earliestDate: "2026-04-16",
};

const priorRule = {
  id: 17,
  categoryId: 9,
  matchType: "exact" as const,
  matchValue: "COSTCO WHSE",
  priority: 100,
  source: "manual" as const,
  createdAt: new Date("2026-04-16T12:00:00Z"),
  updatedAt: new Date("2026-04-16T12:00:00Z"),
};

describe("validateBulkRetargetSnapshot — happy path", () => {
  it("accepts a snapshot with priorRule = null", () => {
    expect(validateBulkRetargetSnapshot(valid).success).toBe(true);
  });

  it("accepts a snapshot with a priorRule", () => {
    expect(validateBulkRetargetSnapshot({ ...valid, priorRule }).success).toBe(true);
  });

  it("coerces ISO string dates in priorRule (JSON round-trip)", () => {
    const result = validateBulkRetargetSnapshot({
      ...valid,
      priorRule: {
        ...priorRule,
        createdAt: "2026-04-16T12:00:00Z",
        updatedAt: "2026-04-16T12:00:00Z",
      },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.priorRule) {
      expect(result.data.priorRule.createdAt).toBeInstanceOf(Date);
    }
  });

  /* `""` is a real stored key — a blank bank memo normalizes to it — and it is
     the group with no other repair path, so a `.min(1)` anywhere in this chain
     breaks the undo of the one action that most needs one. */
  it("accepts the empty merchant key", () => {
    expect(validateBulkRetargetSnapshot({ ...valid, normalizedMerchant: "" }).success).toBe(true);
  });

  it("accepts an empty priorRule matchValue for the same reason", () => {
    const result = validateBulkRetargetSnapshot({
      ...valid,
      normalizedMerchant: "",
      priorRule: { ...priorRule, matchValue: "" },
    });
    expect(result.success).toBe(true);
  });
});

describe("validateBulkRetargetSnapshot — trust boundary", () => {
  /* The reason `matchType` is `z.literal("exact")` and not the wide enum:
     `restorePriorRule` INSERTs the snapshot verbatim, so accepting `regex`
     would let a crafted Undo install a catch-all rule. */
  it("rejects a non-exact priorRule matchType", () => {
    const result = validateBulkRetargetSnapshot({
      ...valid,
      priorRule: { ...priorRule, matchType: "regex", matchValue: ".*" },
    });
    expect(result.success).toBe(false);
  });

  /* `bulkRetarget` refuses an empty row set rather than returning one, so
     unlike its sibling this snapshot can never carry a null date. Accepting
     one would mean accepting a snapshot this code cannot produce. */
  it("rejects a null earliestDate", () => {
    expect(validateBulkRetargetSnapshot({ ...valid, earliestDate: null }).success).toBe(false);
  });

  it("rejects a malformed earliestDate", () => {
    expect(validateBulkRetargetSnapshot({ ...valid, earliestDate: "16/04/2026" }).success).toBe(false);
  });

  /* Shape-valid but calendar-invalid. A `^\d{4}-\d{2}-\d{2}$` regex passes
     all of these, and `undoBulkRetarget` hands the value straight to
     `parseIsoMonth` — `2026-13-01` yields month 13, so
     `invalidateForwardRolloverMany` matches no `budget_periods` row and both
     categories keep a stale `effective_allocation_cents` for the rest of the
     year while their rows move back. `z.iso.date()` is what rejects them,
     the same spelling rule 1 mandates on every anchor-writing path. */
  it.each([
    ["month 13", "2026-13-01"],
    ["Feb 31", "2026-02-31"],
    ["Apr 31", "2026-04-31"],
    ["all zeroes", "0000-00-00"],
  ])("rejects a calendar-invalid earliestDate (%s)", (_label, earliestDate) => {
    expect(validateBulkRetargetSnapshot({ ...valid, earliestDate }).success).toBe(false);
  });

  it("still accepts a real leap day", () => {
    expect(validateBulkRetargetSnapshot({ ...valid, earliestDate: "2024-02-29" }).success).toBe(true);
  });

  it.each([
    ["fromCategoryId", { fromCategoryId: 0 }],
    ["categoryId", { categoryId: -1 }],
    ["txnIds", { txnIds: [1, "2"] }],
    ["ruleTouched", { ruleTouched: "yes" }],
    ["insertedRuleId", { insertedRuleId: 0 }],
  ])("rejects a bad %s", (_label, override) => {
    expect(validateBulkRetargetSnapshot({ ...valid, ...override }).success).toBe(false);
  });
});
