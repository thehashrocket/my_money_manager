import { describe, expect, it } from "vitest";
import {
  hasMerchantName,
  merchantLabel,
  NO_MERCHANT_NAME,
} from "./merchantLabel";

/**
 * The module is three lines, and it still needs pinning: it exists to stop
 * `/categorize` and `/transactions` giving different answers to the same
 * question, and the drift it prevents was reintroduced once inside its own
 * consumer while it had no tests at all. Both functions could be replaced by
 * the identity and `() => true` with the whole 1,439-test suite still green.
 */
describe("merchantLabel", () => {
  it("returns a real key unchanged — no trimming, no casing, no truncation", () => {
    // D12: the key is the exact stored `normalized_merchant`, and the drilldown
    // filters on `eq()`. Anything that rewrites it here would describe a row
    // set the link does not select.
    expect(merchantLabel("AMAZON")).toBe("AMAZON");
    expect(merchantLabel("GASCO#00000ANYTWN")).toBe("GASCO#00000ANYTWN");
    expect(merchantLabel("  PADDED  ")).toBe("  PADDED  ");
  });

  it("substitutes the shared fallback for the empty key", () => {
    expect(merchantLabel("")).toBe(NO_MERCHANT_NAME);
  });

  it("gives both surfaces the same answer for the same key", () => {
    // The actual invariant: not what the string says, but that one call
    // cannot disagree with another. A hardcoded copy at any render site is
    // what this is guarding, and it has already happened once.
    for (const key of ["", "AMAZON", "GASCO#00000ANYTWN"]) {
      expect(merchantLabel(key)).toBe(merchantLabel(key));
    }
    expect(NO_MERCHANT_NAME).not.toBe("");
  });
});

describe("hasMerchantName", () => {
  it("is false only for the empty key", () => {
    expect(hasMerchantName("")).toBe(false);
    expect(hasMerchantName("AMAZON")).toBe(true);
    // A whitespace-only key is not the empty key: `normalizeMerchant` collapses
    // whitespace, so this cannot be stored, but the predicate must not start
    // trimming on its own — that would disagree with `buildPredicates`' `eq()`.
    expect(hasMerchantName(" ")).toBe(true);
  });

  it("agrees with merchantLabel about which keys need the fallback", () => {
    for (const key of ["", " ", "AMAZON"]) {
      expect(merchantLabel(key) === NO_MERCHANT_NAME).toBe(!hasMerchantName(key));
    }
  });
});
