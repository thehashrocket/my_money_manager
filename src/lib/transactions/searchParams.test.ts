import { describe, expect, it } from "vitest";
import { flatten, MAX_SEARCH_LENGTH, searchParamsSchema } from "./searchParams";

/**
 * D11 — these were unwritable before the extraction: `searchParamsSchema` and
 * `flatten` were module-private inside `app/transactions/page.tsx`, which
 * `vitest` (`environment: "node"`) cannot import.
 *
 * The half these cover is "the schema ACCEPTS it". The other half — "the
 * serializer EMITS it" — lives in `_filter-bar.test.ts`, and D5's round-trip
 * test joins the two.
 */
describe("searchParamsSchema — merchant (D2/D12)", () => {
  it("accepts a merchant key", () => {
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: "AMAZON" }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.merchant).toBe("AMAZON");
  });

  it("preserves URL-hostile characters verbatim — the key is compared byte-for-byte", () => {
    const key = "ARCO#05450AMERI";
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: key }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.merchant).toBe(key);
  });

  it("does not trim — a stored key owns its own whitespace, unlike `search`", () => {
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: "  SPACED  " }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.merchant).toBe("  SPACED  ");
  });

  it("normalizes an empty merchant to undefined via flatten, not to an empty filter", () => {
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: "" }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.merchant).toBe(undefined);
  });

  it("carries no length bound (D12) — the column is unbounded text", () => {
    const long = "X".repeat(MAX_SEARCH_LENGTH * 5);
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: long }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.merchant).toBe(long);
  });

  it("still rejects an unknown key — .strict() is what makes a bad link 404 loudly", () => {
    expect(searchParamsSchema.safeParse(flatten({ merchantt: "AMAZON" })).success).toBe(false);
  });
});

describe("searchParamsSchema — the pre-existing contract still holds", () => {
  it("accepts an empty object (no filters)", () => {
    expect(searchParamsSchema.safeParse(flatten({})).success).toBe(true);
  });

  it('coerces categoryId, and keeps "none" as the literal', () => {
    const numeric = searchParamsSchema.safeParse(flatten({ categoryId: "7" }));
    expect(numeric.success && numeric.data.categoryId).toBe(7);
    const none = searchParamsSchema.safeParse(flatten({ categoryId: "none" }));
    expect(none.success && none.data.categoryId).toBe("none");
  });

  it("rejects a calendar-invalid date rather than passing it to a lexicographic comparison", () => {
    expect(searchParamsSchema.safeParse(flatten({ dateFrom: "2026-13-40" })).success).toBe(false);
  });

  it("parses an amount to cents and drops its sign", () => {
    const parsed = searchParamsSchema.safeParse(flatten({ amountMin: "-5.00" }));
    expect(parsed.success && parsed.data.amountMin).toBe(500);
  });

  it("rejects an unparseable amount", () => {
    expect(searchParamsSchema.safeParse(flatten({ amountMax: "abc" })).success).toBe(false);
  });

  it("trims search and treats whitespace-only as no filter", () => {
    const parsed = searchParamsSchema.safeParse(flatten({ search: "  amazon  " }));
    expect(parsed.success && parsed.data.search).toBe("amazon");
    const blank = searchParamsSchema.safeParse(flatten({ search: "   " }));
    expect(blank.success && blank.data.search).toBe(undefined);
  });

  it('accepts only the literal "true" for includeTransfers', () => {
    const on = searchParamsSchema.safeParse(flatten({ includeTransfers: "true" }));
    expect(on.success && on.data.includeTransfers).toBe(true);
    expect(searchParamsSchema.safeParse(flatten({ includeTransfers: "1" })).success).toBe(false);
  });

  it("rejects a pageSize above the cap", () => {
    expect(searchParamsSchema.safeParse(flatten({ pageSize: "5000" })).success).toBe(false);
  });
});

describe("flatten", () => {
  it("takes the first value of a repeated key", () => {
    expect(flatten({ merchant: ["A", "B"] }).merchant).toBe("A");
  });

  it('maps "" to undefined so a blank GET-form field is "no filter"', () => {
    expect(flatten({ search: "", dateFrom: "" })).toEqual({
      search: undefined,
      dateFrom: undefined,
    });
  });
});
