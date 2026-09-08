import { describe, expect, it } from "vitest";
import { validateBulkCategorizeInput } from "./validateBulkCategorizeInput";

describe("validateBulkCategorizeInput", () => {
  it("accepts a well-formed FormData-style object", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "SAFEWAY",
      categoryId: "42",
      rememberMerchant: "true",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.normalizedMerchant).toBe("SAFEWAY");
    expect(result.data.categoryId).toBe(42);
    expect(result.data.rememberMerchant).toBe(true);
  });

  it("defaults rememberMerchant to false when absent", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "SAFEWAY",
      categoryId: "1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rememberMerchant).toBe(false);
  });

  it("coerces rememberMerchant='false' to false", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "SAFEWAY",
      categoryId: "1",
      rememberMerchant: "false",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rememberMerchant).toBe(false);
  });

  it("ACCEPTS the empty normalizedMerchant, which is a real stored key", () => {
    /* Reversed deliberately. `""` is what a blank bank memo normalizes to —
       `merchantLabel` exists to render it, and `loadMerchantGroups` groups it
       like any other key, so `/categorize` lists that group with a working
       Submit button. `.min(1)` here made that button throw "Invalid bulk
       categorize input" on the one group with no other way to file it. The
       Remember checkbox is still refused for the key (`keyTrainability`); the
       ROWS are not. */
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "",
      categoryId: "1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.normalizedMerchant).toBe("");
  });

  it("normalizes whitespace-only to the empty key rather than rejecting it", () => {
    // Trimming still happens; it just no longer gates. A padded blank memo and
    // a truly blank one are the same key, which is what the normalizer says too.
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "   ",
      categoryId: "1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.normalizedMerchant).toBe("");
  });

  it("trims leading/trailing whitespace", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "  SAFEWAY  ",
      categoryId: "1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.normalizedMerchant).toBe("SAFEWAY");
  });

  it("rejects non-positive categoryId", () => {
    expect(
      validateBulkCategorizeInput({
        normalizedMerchant: "SAFEWAY",
        categoryId: "0",
      }).success,
    ).toBe(false);
    expect(
      validateBulkCategorizeInput({
        normalizedMerchant: "SAFEWAY",
        categoryId: "-5",
      }).success,
    ).toBe(false);
  });

  it("rejects non-numeric categoryId", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "SAFEWAY",
      categoryId: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer categoryId", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "SAFEWAY",
      categoryId: "1.5",
    });
    expect(result.success).toBe(false);
  });
});
