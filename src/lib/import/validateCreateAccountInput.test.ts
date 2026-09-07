import { describe, expect, it } from "vitest";
import { validateCreateAccountInput } from "./validateCreateAccountInput";

const valid = {
  name: "Checking",
  type: "checking" as const,
  startingBalance: 1234.56,
  startingBalanceDate: "2026-04-16",
};

describe("validateCreateAccountInput — happy path", () => {
  it("accepts a well-formed input and emits signed cents", () => {
    const result = validateCreateAccountInput(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 123_456,
        startingBalanceDate: "2026-04-16",
        creditLimitCents: null,
        minimumPaymentCents: null,
      });
    }
  });

  it("coerces FormData-style startingBalance string", () => {
    const result = validateCreateAccountInput({
      ...valid,
      startingBalance: "1234.56",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.startingBalanceCents).toBe(123_456);
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

  it("rejects a type outside the enum", () => {
    expect(validateCreateAccountInput({ ...valid, type: "brokerage" }).success).toBe(false);
    expect(validateCreateAccountInput({ ...valid, type: "" }).success).toBe(false);
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

describe("validateCreateAccountInput — liability accounts (DS64, T15)", () => {
  const card = {
    name: "Visa",
    type: "credit" as const,
    startingBalance: 2000,
    startingBalanceDate: "2026-09-06",
  };

  it("NEGATES a card's positive 'Balance owed' — the ledger-corruption path", () => {
    // Before this, typing 2000 for a $2,000 Visa stored a POSITIVE anchor:
    // the dashboard added $2,000 to Cash and net worth was wrong by $4,000,
    // with no error and a number that looked entirely plausible. This single
    // assertion is why T15 was raised from P2 to P1.
    const result = validateCreateAccountInput(card);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.startingBalanceCents).toBe(-200_000);
  });

  it("negates a loan's balance owed the same way", () => {
    const result = validateCreateAccountInput({
      ...card,
      name: "Mortgage",
      type: "loan",
      startingBalance: 302_480.11,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.startingBalanceCents).toBe(-30_248_011);
  });

  it("leaves an asset account's sign alone", () => {
    const result = validateCreateAccountInput({ ...card, type: "savings" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.startingBalanceCents).toBe(200_000);
  });

  it("accepts a $0 balance owed — a paid-off card is a legitimate starting point", () => {
    const result = validateCreateAccountInput({ ...card, startingBalance: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.startingBalanceCents).toBe(0);
  });

  it("REFUSES a negative balance owed rather than double-negating it", () => {
    // The user never types a minus sign (DS61). A negative here is sign
    // confusion, and silently flipping it to a credit balance would be the
    // same class of invisible wrong number the negation exists to prevent.
    const result = validateCreateAccountInput({ ...card, startingBalance: -2000 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Enter what you owe as a positive number.");
    }
  });

  it("still allows an overdrawn asset account to be created negative", () => {
    const result = validateCreateAccountInput({
      ...card,
      type: "checking",
      startingBalance: -50,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.startingBalanceCents).toBe(-5_000);
  });
});

describe("validateCreateAccountInput — credit limit and minimum payment (E3, D2=A)", () => {
  const card = {
    name: "Visa",
    type: "credit" as const,
    startingBalance: 2000,
    startingBalanceDate: "2026-09-06",
  };

  it("accepts both as optional positive dollars on a card", () => {
    const result = validateCreateAccountInput({
      ...card,
      creditLimit: "5000",
      minimumPayment: "50",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.creditLimitCents).toBe(500_000);
      expect(result.data.minimumPaymentCents).toBe(5_000);
    }
  });

  it("treats an untouched form field ('') as absent, not as zero", () => {
    const result = validateCreateAccountInput({
      ...card,
      creditLimit: "",
      minimumPayment: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // NULL, not 0: `hasLimit: false` means "render no bar", while a 0 limit
      // would be an account with no borrowing power at 100% utilization.
      expect(result.data.creditLimitCents).toBeNull();
      expect(result.data.minimumPaymentCents).toBeNull();
    }
  });

  it("rejects a negative credit limit (E3 bounds)", () => {
    expect(validateCreateAccountInput({ ...card, creditLimit: "-5000" }).success).toBe(false);
  });

  it("rejects a negative minimum payment (E3 bounds)", () => {
    expect(validateCreateAccountInput({ ...card, minimumPayment: "-50" }).success).toBe(false);
  });

  it("rejects either field on a LOAN — D2=A makes both cards-only", () => {
    // DS59 renders a mortgage muted, with no bar and no actions; storing a
    // limit or a minimum payment there would persist a number nothing reads.
    expect(
      validateCreateAccountInput({ ...card, type: "loan", creditLimit: "5000" }).success,
    ).toBe(false);
    expect(
      validateCreateAccountInput({ ...card, type: "loan", minimumPayment: "50" }).success,
    ).toBe(false);
  });

  it("rejects either field on an asset account", () => {
    expect(
      validateCreateAccountInput({ ...card, type: "checking", creditLimit: "5000" }).success,
    ).toBe(false);
  });

  it("accepts a loan with both fields simply absent", () => {
    expect(validateCreateAccountInput({ ...card, type: "loan" }).success).toBe(true);
  });
});
