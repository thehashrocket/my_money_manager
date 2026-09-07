import { describe, expect, it } from "vitest";
import {
  isStartingBalanceCentsInBounds,
  owedDollarsToSignedCents,
  startingBalanceDateSchema,
  STARTING_BALANCE_CENTS_MAX,
  STARTING_BALANCE_CENTS_MIN,
} from "./accountAnchorFields";

/**
 * Rule 9's single negation point had NO direct test. Its two callers were
 * covered only by assertions of the form
 * `expect(parsed.data.startingBalanceCents).toBe(owedDollarsToSignedCents(owed))`
 * — both sides routing through the same function, so reverting the helper's
 * body moved both together and the suite stayed green. Every expectation here
 * is an absolute literal for that reason.
 */
describe("owedDollarsToSignedCents", () => {
  it("negates a whole-dollar balance owed", () => {
    expect(owedDollarsToSignedCents(2000)).toBe(-200_000);
  });

  it("negates a two-decimal balance owed", () => {
    expect(owedDollarsToSignedCents(2148.32)).toBe(-214_832);
  });

  it("ROUNDS BEFORE FLIPPING THE SIGN — the half-cent divergence itself", () => {
    // The whole reason this function exists. `Math.round` breaks half-values
    // toward +Infinity, so rounding the NEGATED figure gives a different
    // answer: `Math.round(-0.125 * 100)` is -12, and `-Math.round(0.125 * 100)`
    // is -13. Account creation did it one way and reconcile the other, and
    // they disagreed by a cent on exactly these inputs.
    expect(owedDollarsToSignedCents(0.125)).toBe(-13);
    expect(owedDollarsToSignedCents(0.135)).toBe(-14);
    expect(owedDollarsToSignedCents(2000.005)).toBe(-200_001);
  });

  it("returns +0 for a paid-off card, never -0", () => {
    // -0 is not Object.is-equal to 0 and survives in memory long enough to
    // fail an equality assertion downstream for a reason nobody would guess.
    const zero = owedDollarsToSignedCents(0);
    expect(zero).toBe(0);
    expect(Object.is(zero, -0)).toBe(false);
  });

  it("returns +0 for an amount that rounds away to nothing", () => {
    // 0.001 rounds to 0 cents, which must take the same -0 guard as an
    // explicit zero rather than producing -0 by arithmetic.
    expect(Object.is(owedDollarsToSignedCents(0.001), -0)).toBe(false);
  });
});

describe("startingBalanceDateSchema", () => {
  it("accepts a well-formed YYYY-MM-DD date", () => {
    expect(startingBalanceDateSchema.safeParse("2026-04-16").success).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(startingBalanceDateSchema.safeParse("04/16/2026").success).toBe(false);
  });

  it("rejects a non-date string", () => {
    expect(startingBalanceDateSchema.safeParse("not a date").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(startingBalanceDateSchema.safeParse("").success).toBe(false);
  });

  it("rejects a calendar-invalid month", () => {
    expect(startingBalanceDateSchema.safeParse("2026-13-40").success).toBe(false);
  });

  it("rejects a calendar-invalid day (Feb 30th)", () => {
    expect(startingBalanceDateSchema.safeParse("2026-02-30").success).toBe(false);
  });
});

describe("isStartingBalanceCentsInBounds", () => {
  it("accepts the exact minimum", () => {
    expect(isStartingBalanceCentsInBounds(STARTING_BALANCE_CENTS_MIN)).toBe(true);
  });

  it("accepts the exact maximum", () => {
    expect(isStartingBalanceCentsInBounds(STARTING_BALANCE_CENTS_MAX)).toBe(true);
  });

  it("rejects one cent below the minimum", () => {
    expect(isStartingBalanceCentsInBounds(STARTING_BALANCE_CENTS_MIN - 1)).toBe(false);
  });

  it("rejects one cent above the maximum", () => {
    expect(isStartingBalanceCentsInBounds(STARTING_BALANCE_CENTS_MAX + 1)).toBe(false);
  });

  it("accepts zero", () => {
    expect(isStartingBalanceCentsInBounds(0)).toBe(true);
  });
});
