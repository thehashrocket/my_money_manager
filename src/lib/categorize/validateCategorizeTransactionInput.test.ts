import { describe, expect, it } from "vitest";
import { validateCategorizeTransactionInput } from "./validateCategorizeTransactionInput";

describe("validateCategorizeTransactionInput", () => {
  it("accepts a well-formed FormData-style object", () => {
    const result = validateCategorizeTransactionInput({
      transactionId: "99",
      categoryId: "42",
      rememberMerchant: "true",
      applyToPast: "true",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.transactionId).toBe(99);
    expect(result.data.categoryId).toBe(42);
    expect(result.data.rememberMerchant).toBe(true);
    expect(result.data.applyToPast).toBe(true);
  });

  it("defaults both booleans to false when absent", () => {
    const result = validateCategorizeTransactionInput({
      transactionId: "1",
      categoryId: "1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rememberMerchant).toBe(false);
    expect(result.data.applyToPast).toBe(false);
  });

  it("coerces boolean strings 'false' to false", () => {
    const result = validateCategorizeTransactionInput({
      transactionId: "1",
      categoryId: "1",
      rememberMerchant: "false",
      applyToPast: "false",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rememberMerchant).toBe(false);
    expect(result.data.applyToPast).toBe(false);
  });

  it("rejects non-positive transactionId", () => {
    expect(
      validateCategorizeTransactionInput({
        transactionId: "0",
        categoryId: "1",
      }).success,
    ).toBe(false);
    expect(
      validateCategorizeTransactionInput({
        transactionId: "-3",
        categoryId: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects non-positive categoryId", () => {
    const result = validateCategorizeTransactionInput({
      transactionId: "1",
      categoryId: "0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric ids", () => {
    expect(
      validateCategorizeTransactionInput({
        transactionId: "abc",
        categoryId: "1",
      }).success,
    ).toBe(false);
    expect(
      validateCategorizeTransactionInput({
        transactionId: "1",
        categoryId: "xyz",
      }).success,
    ).toBe(false);
  });

  it("rejects non-integer ids", () => {
    expect(
      validateCategorizeTransactionInput({
        transactionId: "1.5",
        categoryId: "1",
      }).success,
    ).toBe(false);
    expect(
      validateCategorizeTransactionInput({
        transactionId: "1",
        categoryId: "2.2",
      }).success,
    ).toBe(false);
  });

  it("rejects missing transactionId or categoryId", () => {
    expect(
      validateCategorizeTransactionInput({ categoryId: "1" }).success,
    ).toBe(false);
    expect(
      validateCategorizeTransactionInput({ transactionId: "1" }).success,
    ).toBe(false);
  });
});
