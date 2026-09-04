import { describe, expect, it } from "vitest";
import {
  isStartingBalanceCentsInBounds,
  STARTING_BALANCE_CENTS_MAX,
  STARTING_BALANCE_CENTS_MIN,
} from "./accountAnchorFields";

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
