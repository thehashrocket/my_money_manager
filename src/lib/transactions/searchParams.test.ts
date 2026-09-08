import { describe, expect, it } from "vitest";
import {
  flatten,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  resolveIsPending,
  searchParamsSchema,
} from "./searchParams";

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
    const key = "GASCO#00000ANYTWN";
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: key }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.merchant).toBe(key);
  });

  it("does not trim — a stored key owns its own whitespace, unlike `search`", () => {
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: "  SPACED  " }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.merchant).toBe("  SPACED  ");
  });

  it("drops an empty merchant key in flatten, so it never reaches the schema", () => {
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

/**
 * The tampering surface. `/transactions` routes a `safeParse` failure through
 * `notFound()`, so every rejection below is the difference between Next's 404
 * and a page that renders a plausible-looking row set from a nonsense filter.
 */
describe("searchParamsSchema — bounds and rejections", () => {
  it.each([
    ["categoryId", "0"],
    ["categoryId", "-3"],
    ["categoryId", "1.5"],
    ["accountId", "0"],
    ["page", "0"],
    ["pageSize", "0"],
    ["pending", "maybe"],
    ["dateTo", "2026-02-30"],
  ])("rejects %s=%j", (key, value) => {
    expect(searchParamsSchema.safeParse(flatten({ [key]: value })).success).toBe(false);
  });

  it("accepts the pageSize cap exactly, and page 1", () => {
    const parsed = searchParamsSchema.safeParse(
      flatten({ pageSize: String(MAX_PAGE_SIZE), page: "1" }),
    );
    expect(parsed.success && parsed.data.pageSize).toBe(MAX_PAGE_SIZE);
    expect(parsed.success && parsed.data.page).toBe(1);
  });

  it("treats a whitespace-only amount as no filter rather than an invalid one", () => {
    // `flatten` only drops a "" field; "   " reaches the transform intact.
    const parsed = searchParamsSchema.safeParse(flatten({ amountMin: "   " }));
    expect(parsed.success && parsed.data.amountMin).toBe(undefined);
  });

  it("accepts search at exactly MAX_SEARCH_LENGTH and rejects one character more", () => {
    const atCap = "x".repeat(MAX_SEARCH_LENGTH);
    expect(searchParamsSchema.safeParse(flatten({ search: atCap })).success).toBe(true);
    expect(
      searchParamsSchema.safeParse(flatten({ search: `${atCap}x` })).success,
    ).toBe(false);
  });

  it("the zero-result state's `?search=<key>` recovery link parses for a realistic key", () => {
    // `EmptyState` offers a `?search=<merchant key>` recovery when an exact
    // merchant key matches nothing (rule 10). `merchant` is unbounded by
    // design (D12) but `search` is capped, so the recovery can only carry the
    // whole key while keys stay under the cap. This documents the SHAPE of a
    // long real key (a 64-char personal Zelle string) rather than pinning the
    // normalizer — nothing here fails if the normalizer starts producing
    // longer ones. That case is handled instead of asserted: `EmptyState`
    // truncates to `MAX_SEARCH_LENGTH`, covered by the next test.
    const key = "INSTANT PAY ID: 000000000000000000 (TRANSFER TO SAVINGS) JANE DOE";
    expect(key.length).toBeLessThanOrEqual(MAX_SEARCH_LENGTH);
    const parsed = searchParamsSchema.safeParse(flatten({ search: key }));
    expect(parsed.success && parsed.data.search).toBe(key);
  });

  it("a key at the cap still parses, so the truncated recovery link cannot 404", () => {
    // The recovery link builds `search: merchant.slice(0, MAX_SEARCH_LENGTH)`.
    // This is the boundary that makes that slice sufficient rather than
    // merely shorter: an over-long merchant key used to produce a recovery
    // link the schema rejected, so the one action offered on the empty state
    // 404'd — for exactly the stale-key case the state exists to rescue.
    const overLong = "A".repeat(MAX_SEARCH_LENGTH * 2);
    const truncated = overLong.slice(0, MAX_SEARCH_LENGTH);
    const parsed = searchParamsSchema.safeParse(flatten({ search: truncated }));
    expect(parsed.success && parsed.data.search).toBe(truncated);
  });
});

describe("flatten", () => {
  it("takes the first value of a repeated key", () => {
    expect(flatten({ merchant: ["A", "B"] }).merchant).toBe("A");
  });

  it('drops a "" field so a blank GET-form input is "no filter"', () => {
    expect(flatten({ search: "", dateFrom: "" })).toEqual({});
  });

  it("drops a blank key entirely rather than passing it on as undefined", () => {
    // Load-bearing, and not the same thing as mapping it to `undefined`:
    // `.strict()` raises `unrecognized_keys` for a key it does not know EVEN
    // WHEN that key's value is `undefined`. While `flatten` retained the key,
    // one empty foreign param 404'd a request in which every real filter had
    // parsed fine.
    expect(Object.hasOwn(flatten({ search: "" }), "search")).toBe(false);
  });

  it("drops a key whose value is undefined, not just one that is blank", () => {
    // The guard is `value === "" || value === undefined`, and only the `""`
    // half was pinned. Next's `searchParams` hands back `undefined` for a
    // param it saw but could not resolve, and `Array.isArray(v) ? v[0] : v`
    // yields `undefined` for a repeated-then-emptied param (`[]`). Both plant
    // an own property whose value is `undefined` if the second half regresses
    // — which `.strict()` rejects exactly as loudly as a real foreign value.
    expect(Object.hasOwn(flatten({ ref: undefined }), "ref")).toBe(false);
    expect(Object.hasOwn(flatten({ ref: [] }), "ref")).toBe(false);
  });

  it("an undefined foreign param does not 404 a page whose real filters are fine", () => {
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: "AMAZON", ref: undefined }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.merchant).toBe("AMAZON");
  });

  it("an empty foreign param does not 404 a page whose real filters are fine", () => {
    // `?merchant=AMAZON&ref=` — a mail client, a link shortener or a browser
    // extension will produce this; the user did nothing wrong.
    const parsed = searchParamsSchema.safeParse(flatten({ merchant: "AMAZON", ref: "" }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.merchant).toBe("AMAZON");
  });

  it("a foreign param carrying a real value still 404s (.strict() stays strict)", () => {
    expect(
      searchParamsSchema.safeParse(flatten({ merchant: "AMAZON", ref: "x" })).success,
    ).toBe(false);
  });
});

describe("resolveIsPending", () => {
  // Three-way, and the two boolean branches read backwards from the labels
  // ("posted" → false). Inverting them shows pending rows under "Posted only"
  // — a wrong result on a filter — and while this lived as a nested ternary
  // inside `page.tsx` no test could reach it.
  it('"posted" filters to NOT pending', () => {
    expect(resolveIsPending("posted")).toBe(false);
  });

  it('"pending" filters to pending', () => {
    expect(resolveIsPending("pending")).toBe(true);
  });

  it('"all" does not filter on pending at all', () => {
    expect(resolveIsPending("all")).toBeUndefined();
  });

  it("an absent param does not filter on pending at all", () => {
    expect(resolveIsPending(undefined)).toBeUndefined();
  });
});
