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

  it("rejects empty normalizedMerchant", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "",
      categoryId: "1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only normalizedMerchant", () => {
    const result = validateBulkCategorizeInput({
      normalizedMerchant: "   ",
      categoryId: "1",
    });
    expect(result.success).toBe(false);
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
