import { describe, expect, it } from "vitest";
import { validateCreateAccountInput } from "./validateCreateAccountInput";

const valid = {
  name: "Checking",
  type: "checking" as const,
  startingBalance: 1234.56,
  startingBalanceDate: "2026-04-16",
};

describe("validateCreateAccountInput — happy path", () => {
  it("accepts a well-formed input", () => {
    const result = validateCreateAccountInput(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it("coerces FormData-style startingBalance string", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalance: "1234.56",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.startingBalance).toBe(1234.56);
  });

  it("trims name whitespace", () => {
    const result = validateCreateAccountInput({
      ...valid,
      name: "  Checking  ",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Checking");
  });

  it("accepts type = savings", () => {
    const result = validateCreateAccountInput({ ...valid, type: "savings" });
    expect(result.success).toBe(true);
  });

  it("accepts zero starting balance", () => {
    const result = validateCreateAccountInput({ ...valid, startingBalance: 0 });
    expect(result.success).toBe(true);
  });

  it("accepts negative starting balance (overdrawn account)", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalance: -50,
    });
    expect(result.success).toBe(true);
  });
});

describe("validateCreateAccountInput — rejections", () => {
  it("rejects empty name", () => {
    const result = validateCreateAccountInput({ ...valid, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only name", () => {
    const result = validateCreateAccountInput({ ...valid, name: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects invalid type", () => {
    const result = validateCreateAccountInput({ ...valid, type: "credit" });
    expect(result.success).toBe(false);
  });

  it("rejects startingBalance = 1e10 (closes v0.2.0 P3)", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalance: 1e10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects startingBalance below -$1M lower bound", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalance: -10_000_000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-finite startingBalance (Infinity)", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalance: Infinity,
    });
    expect(result.success).toBe(false);
  });

  it("rejects NaN startingBalance string", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalance: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed startingBalanceDate", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalanceDate: "04/16/2026",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty startingBalanceDate", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalanceDate: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateCreateAccountInput(null).success).toBe(false);
    expect(validateCreateAccountInput(undefined).success).toBe(false);
    expect(validateCreateAccountInput("nope").success).toBe(false);
  });
});
