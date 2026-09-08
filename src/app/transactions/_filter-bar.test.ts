import { describe, expect, it } from "vitest";
import { flatten, searchParamsSchema } from "@/lib/transactions/searchParams";
import { buildHref, filterValuesToSearchParams, type TransactionsFilterValues } from "./_filter-bar";

const emptyValues: TransactionsFilterValues = {
  search: undefined,
  accountId: undefined,
  categoryId: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  amountMin: undefined,
  amountMax: undefined,
  pending: undefined,
  includeTransfers: undefined,
  merchant: undefined,
};

describe("filterValuesToSearchParams", () => {
  it("carries every active filter forward (Pagination round-trip)", () => {
    const values: TransactionsFilterValues = {
      search: "amazon",
      accountId: 3,
      categoryId: 7,
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
      amountMin: 500,
      amountMax: 10000,
      pending: "posted",
      includeTransfers: undefined,
      merchant: "AMAZON",
    };
    const params = filterValuesToSearchParams(values);
    expect(params.get("search")).toBe("amazon");
    expect(params.get("accountId")).toBe("3");
    expect(params.get("categoryId")).toBe("7");
    expect(params.get("dateFrom")).toBe("2026-04-01");
    expect(params.get("dateTo")).toBe("2026-04-30");
    expect(params.get("amountMin")).toBe("5.00");
    expect(params.get("amountMax")).toBe("100.00");
    expect(params.get("pending")).toBe("posted");
    expect(params.get("merchant")).toBe("AMAZON");
  });

  it('omits pending when it is "all" (today\'s default)', () => {
    const params = filterValuesToSearchParams({ ...emptyValues, pending: "all" });
    expect(params.has("pending")).toBe(false);
  });

  it("produces no params when nothing is set", () => {
    expect(filterValuesToSearchParams(emptyValues).toString()).toBe("");
  });

  it("categoryId 'none' round-trips as the literal string", () => {
    const params = filterValuesToSearchParams({ ...emptyValues, categoryId: "none" });
    expect(params.get("categoryId")).toBe("none");
  });
});

describe("buildHref", () => {
  it("returns the bare path when no filters are set", () => {
    expect(buildHref(emptyValues)).toBe("/transactions");
  });

  it("overriding dateFrom/dateTo (the 'This month' link) keeps other active filters", () => {
    const href = buildHref({
      ...emptyValues,
      search: "amazon",
      accountId: 3,
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("search")).toBe("amazon");
    expect(url.searchParams.get("accountId")).toBe("3");
    expect(url.searchParams.get("dateFrom")).toBe("2026-04-01");
    expect(url.searchParams.get("dateTo")).toBe("2026-04-30");
  });

  it("the merchant chip's × drops only the merchant, keeping the date range (D18)", () => {
    const active = buildHref({
      ...emptyValues,
      merchant: "AMAZON",
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    expect(new URL(active, "http://localhost").searchParams.get("merchant")).toBe("AMAZON");

    const cleared = buildHref({
      ...emptyValues,
      merchant: undefined,
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    const url = new URL(cleared, "http://localhost");
    expect(url.searchParams.has("merchant")).toBe(false);
    expect(url.searchParams.get("dateFrom")).toBe("2026-04-01");
    expect(url.searchParams.get("dateTo")).toBe("2026-04-30");
  });
});

/**
 * D5 — the regression guard, driven by the KEYS of `TransactionsFilterValues`
 * rather than a hand-written list of them.
 *
 * A filter reaches the URL through two independent gates and has to clear
 * both: `filterValuesToSearchParams` must SERIALIZE it (or page 2 silently
 * drops it — the list reads as filtered while showing all 1,540 rows), and
 * `searchParamsSchema` must ACCEPT it (or the link 404s, since the schema is
 * `.strict()`). This app has now shipped the silent half twice, on `pageSize`
 * and on `includeTransfers`; the previous version of this test hand-enumerated
 * field names, so it could only ever catch the fields someone remembered.
 *
 * The exhaustiveness is a type check, not a convention: `ALL_FILTERS_ACTIVE`
 * is annotated `TransactionsFilterValues`, whose properties are all required,
 * so adding field #11 to that type fails `tsc` here until the fixture sets it
 * — and the loops below then cover it automatically. The `undefined` assertion
 * closes the other half of that door: satisfying the compiler with
 * `newField: undefined` would otherwise pass a test that exercised nothing.
 */
const ALL_FILTERS_ACTIVE: TransactionsFilterValues = {
  search: "amazon",
  accountId: 3,
  categoryId: 7,
  dateFrom: "2026-04-01",
  dateTo: "2026-04-30",
  amountMin: 500,
  amountMax: 10000,
  // "all" is deliberately omitted by the serializer as the default, so the
  // fixture has to use a value that is actually carried.
  pending: "posted",
  includeTransfers: true,
  merchant: "GASCO#00000ANYTWN",
};

describe("buildHref refuses to emit a merchant filter it cannot honour", () => {
  /**
   * A bare `?merchant=` is worse than no link: `flatten()` reads `""` as
   * `undefined`, so the destination drops the filter and shows every row —
   * from a control that promised to narrow to one merchant.
   * `merchantDrilldownHref` returns `null` for this; the per-row link on
   * `/transactions` builds its href through `buildHref` instead, so the guard
   * belongs in the serializer both paths share.
   */
  it("skips an empty merchant key rather than emitting `?merchant=`", () => {
    const href = buildHref({ ...emptyValues, merchant: "" });
    expect(href).not.toContain("merchant");
  });

  it("still emits a non-empty key", () => {
    const href = buildHref({ ...emptyValues, merchant: "AMAZON" });
    expect(new URL(href, "http://x").searchParams.get("merchant")).toBe("AMAZON");
  });
});

describe("every TransactionsFilterValues key survives the URL round trip", () => {
  const keys = Object.keys(ALL_FILTERS_ACTIVE) as (keyof TransactionsFilterValues)[];

  it("the fixture actually populates every field (guards the guard)", () => {
    const unset = keys.filter((k) => ALL_FILTERS_ACTIVE[k] === undefined);
    expect(unset).toEqual([]);
  });

  const params = filterValuesToSearchParams(ALL_FILTERS_ACTIVE);
  const parsed = searchParamsSchema.safeParse(
    flatten(Object.fromEntries(params.entries())),
  );

  it("the serialized query string is accepted by the page's strict schema", () => {
    expect(parsed.success).toBe(true);
  });

  for (const key of keys) {
    it(`${key} is serialized into the query string`, () => {
      expect(params.has(key)).toBe(true);
    });

    /**
     * Value equality, not mere presence. `includeTransfers` parses to `false`
     * when the key is absent entirely (`z.literal("true").optional().transform`),
     * so `.not.toBe(undefined)` passed for a field that was never serialized —
     * the exact silent-drop class this guard exists to catch, on the exact
     * field it has already shipped broken once.
     */
    it(`${key} survives the round trip with its value intact`, () => {
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data[key]).toEqual(ALL_FILTERS_ACTIVE[key]);
    });
  }
});
