import { describe, expect, it } from "vitest";
import { validateCardTermsInput } from "./validateCardTermsInput";

/**
 * The repair path for a card's terms. Both fields were write-once at account
 * creation, so a mistyped limit made the utilization bar wrong on every
 * render and the only fix was raw SQL.
 */
describe("validateCardTermsInput", () => {
  it("converts dollars to cents on both fields", () => {
    const parsed = validateCardTermsInput({ creditLimit: "5000", minimumPayment: "50" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.creditLimitCents).toBe(500_000);
      expect(parsed.data.minimumPaymentCents).toBe(5_000);
    }
  });

  // The trap `optionalPositiveDollars` documents on the creation side: an
  // emptied number input posts "", and z.coerce.number() reads that as 0 —
  // which resolveUtilizationDisplay shows as a card at 100% of no borrowing
  // power rather than a card with no limit recorded.
  // `Number(" ")` is 0 too, so a whitespace-only value would slip past the
  // empty-string branch and store a $0 limit — which hides the bar correctly
  // but makes "no limit recorded" and "a $0 limit" indistinguishable in the
  // form, since the field then renders 0.00 instead of the `none` placeholder.
  it.each(["", "   ", "\t", null, undefined])("treats %j as CLEARED, never as zero", (empty) => {
    const parsed = validateCardTermsInput({ creditLimit: empty, minimumPayment: empty });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.creditLimitCents).toBeNull();
      expect(parsed.data.minimumPaymentCents).toBeNull();
    }
  });

  it("keeps an explicit zero distinct from a cleared field", () => {
    const parsed = validateCardTermsInput({ creditLimit: "0", minimumPayment: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.creditLimitCents).toBe(0);
      expect(parsed.data.minimumPaymentCents).toBeNull();
    }
  });

  it("refuses a negative or non-numeric limit", () => {
    expect(validateCardTermsInput({ creditLimit: "-100" }).success).toBe(false);
    expect(validateCardTermsInput({ creditLimit: "banana" }).success).toBe(false);
  });

  // Shared with account creation via STARTING_BALANCE_DOLLARS_MAX, so the two
  // cannot disagree about what magnitude is legal.
  it("refuses a limit above the shared maximum", () => {
    expect(validateCardTermsInput({ creditLimit: "100000001" }).success).toBe(false);
  });

  it("lets one field change while the other is cleared", () => {
    const parsed = validateCardTermsInput({ creditLimit: "7500", minimumPayment: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.creditLimitCents).toBe(750_000);
      expect(parsed.data.minimumPaymentCents).toBeNull();
    }
  });
});
