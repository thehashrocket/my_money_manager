import { describe, expect, it } from "vitest";
import {
  isStartingBalanceCentsInBounds,
  startingBalanceDateSchema,
  STARTING_BALANCE_CENTS_MAX,
  STARTING_BALANCE_CENTS_MIN,
} from "./accountAnchorFields";

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
