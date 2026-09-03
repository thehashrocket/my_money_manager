import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateUpdateAnchorInput } from "./validateUpdateAnchorInput";

const valid = {
  accountId: 1,
  startingBalance: 984.12,
  startingBalanceDate: "2026-09-02",
};

describe("validateUpdateAnchorInput — happy path", () => {
  it("accepts a well-formed input", () => {
    const result = validateUpdateAnchorInput(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it("coerces FormData-style strings", () => {
    const result = validateUpdateAnchorInput({
      accountId: "1",
      startingBalance: "984.12",
      startingBalanceDate: "2026-09-02",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accountId).toBe(1);
      expect(result.data.startingBalance).toBe(984.12);
    }
  });

  it("accepts a negative anchor (an overdrawn account is a real balance)", () => {
    const result = validateUpdateAnchorInput({ ...valid, startingBalance: -12.5 });
    expect(result.success).toBe(true);
  });

  it("accepts the exact inclusive bounds", () => {
    expect(
      validateUpdateAnchorInput({ ...valid, startingBalance: -1_000_000 })
        .success,
    ).toBe(true);
    expect(
      validateUpdateAnchorInput({ ...valid, startingBalance: 100_000_000 })
        .success,
    ).toBe(true);
  });
});

describe("validateUpdateAnchorInput — future-date bound", () => {
  // todayIso() reads process.env.TZ (like now.test.ts), so this pins UTC
  // rather than trusting the host's timezone — a +13/+14 offset host would
  // otherwise read "2026-09-03T12:00:00Z" as the 4th, flipping which of
  // these two dates counts as "today" vs. "future".
  const ORIGINAL_TZ = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "UTC";
  });
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  const now = new Date("2026-09-03T12:00:00Z");

  it("accepts today's date", () => {
    const result = validateUpdateAnchorInput(
      { ...valid, startingBalanceDate: "2026-09-03" },
      now,
    );
    expect(result.success).toBe(true);
  });

  it("rejects a date after today — a future anchor would exclude every real transaction", () => {
    const result = validateUpdateAnchorInput(
      { ...valid, startingBalanceDate: "2026-09-04" },
      now,
    );
    expect(result.success).toBe(false);
  });
});

describe("validateUpdateAnchorInput — rejections", () => {
  it("rejects a non-ISO date", () => {
    // The `starting_balance_date` ledger invariant is a string comparison
    // against YYYY-MM-DD transaction dates; any other shape silently breaks it.
    const result = validateUpdateAnchorInput({
      ...valid,
      startingBalanceDate: "09/02/2026",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing account id", () => {
    expect(
      validateUpdateAnchorInput({
        startingBalance: valid.startingBalance,
        startingBalanceDate: valid.startingBalanceDate,
      }).success,
    ).toBe(false);
  });

  it("rejects a zero or negative account id", () => {
    expect(validateUpdateAnchorInput({ ...valid, accountId: 0 }).success).toBe(
      false,
    );
    expect(validateUpdateAnchorInput({ ...valid, accountId: -1 }).success).toBe(
      false,
    );
  });

  it("rejects a non-integer account id", () => {
    expect(
      validateUpdateAnchorInput({ ...valid, accountId: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects a non-finite balance", () => {
    expect(
      validateUpdateAnchorInput({ ...valid, startingBalance: "abc" }).success,
    ).toBe(false);
  });

  it("rejects a balance beyond the $100M bound", () => {
    expect(
      validateUpdateAnchorInput({ ...valid, startingBalance: 1e10 }).success,
    ).toBe(false);
  });

  it("rejects a balance below the -$1M bound", () => {
    expect(
      validateUpdateAnchorInput({ ...valid, startingBalance: -1_000_001 })
        .success,
    ).toBe(false);
  });

  it("rejects a missing starting balance date", () => {
    expect(
      validateUpdateAnchorInput({
        accountId: valid.accountId,
        startingBalance: valid.startingBalance,
      }).success,
    ).toBe(false);
  });
});
