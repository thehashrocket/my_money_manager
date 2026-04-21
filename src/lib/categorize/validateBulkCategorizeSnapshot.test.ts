import { describe, expect, it } from "vitest";
import { validateBulkCategorizeSnapshot } from "./validateBulkCategorizeSnapshot";

const validWithoutPrior = {
  normalizedMerchant: "BRASS TAP",
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
  matchValue: "BRASS TAP",
  priority: 100,
  source: "manual" as const,
  createdAt: new Date("2026-04-16T12:00:00Z"),
  updatedAt: new Date("2026-04-16T12:00:00Z"),
};

describe("validateBulkCategorizeSnapshot — happy path", () => {
  it("accepts a snapshot with priorRule = null", () => {
    const result = validateBulkCategorizeSnapshot(validWithoutPrior);
    expect(result.success).toBe(true);
  });

  it("accepts a snapshot with a priorRule", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      priorRule,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty txnIds array (snapshot of a no-op bulk)", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      txnIds: [],
      earliestDate: null,
    });
    expect(result.success).toBe(true);
  });

  it("coerces ISO string dates in priorRule (JSON round-trip)", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
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

  it("accepts earliestDate = null", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      earliestDate: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("validateBulkCategorizeSnapshot — rejections", () => {
  it("rejects insertedRuleId = 0 (must be positive)", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      insertedRuleId: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative insertedRuleId", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      insertedRuleId: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer insertedRuleId", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      insertedRuleId: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty normalizedMerchant", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      normalizedMerchant: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects categoryId = 0", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      categoryId: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer txnIds entry", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      txnIds: [1, 2.5, 3],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative txnIds entry", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      txnIds: [1, -2, 3],
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed earliestDate", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      earliestDate: "04/16/2026",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid priorRule.matchType", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      priorRule: { ...priorRule, matchType: "glob" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid priorRule.source", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      priorRule: { ...priorRule, source: "system" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean ruleTouched", () => {
    const result = validateBulkCategorizeSnapshot({
      ...validWithoutPrior,
      ruleTouched: "true",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateBulkCategorizeSnapshot(null).success).toBe(false);
    expect(validateBulkCategorizeSnapshot("nope").success).toBe(false);
  });
});
