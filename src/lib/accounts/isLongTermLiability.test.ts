import { describe, expect, it } from "vitest";
import { isLongTermLiability } from "./isLongTermLiability";

describe("isLongTermLiability", () => {
  it("is true for a loan", () => {
    expect(isLongTermLiability("loan")).toBe(true);
  });

  it("is false for a credit card (E7)", () => {
    // The bug this closes: DS59 originally derived the muted LONG-TERM
    // treatment from the ABSENCE of credit_limit_cents, which DS64 made
    // optional — so a card added without a limit rendered as a mortgage,
    // losing its bar, its Reconcile action, and its place in the list.
    expect(isLongTermLiability("credit")).toBe(false);
  });

  it("is false for asset types, which never reach the liability renderer anyway", () => {
    expect(isLongTermLiability("checking")).toBe(false);
    expect(isLongTermLiability("savings")).toBe(false);
  });

  it("throws on an unrecognized type rather than guessing", () => {
    expect(() =>
      // @ts-expect-error guarding the runtime boundary, not the type
      isLongTermLiability("investment"),
    ).toThrow(/unrecognized accounts.type/);
  });
});
