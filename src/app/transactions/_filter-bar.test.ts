import { describe, expect, it } from "vitest";
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
});

/**
 * T26/E9 — the toggle has to survive the URL round trip, or page 2 silently
 * turns transfers back off. Both carriers are exercised:
 * `filterValuesToSearchParams` (used by Pagination and by the toggle link
 * itself) and the hidden input in the filter form.
 */
describe("includeTransfers round-trips through the query string", () => {
  const base = {
    search: undefined,
    accountId: undefined,
    categoryId: undefined,
    dateFrom: undefined,
    dateTo: undefined,
    amountMin: undefined,
    amountMax: undefined,
    pending: undefined,
    includeTransfers: undefined,
  } satisfies TransactionsFilterValues;

  it("emits nothing when off, so the default URL stays clean", () => {
    expect(filterValuesToSearchParams(base).has("includeTransfers")).toBe(false);
    expect(
      filterValuesToSearchParams({ ...base, includeTransfers: false }).has("includeTransfers"),
    ).toBe(false);
  });

  it("emits the literal 'true' when on — the only value the page's schema accepts", () => {
    const params = filterValuesToSearchParams({ ...base, includeTransfers: true });
    expect(params.get("includeTransfers")).toBe("true");
  });

  it("survives alongside every other filter", () => {
    const params = filterValuesToSearchParams({
      search: "costco",
      accountId: 3,
      categoryId: 7,
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      amountMin: 1000,
      amountMax: 50000,
      pending: "posted",
      includeTransfers: true,
    });
    expect(params.get("includeTransfers")).toBe("true");
    expect(params.get("search")).toBe("costco");
    expect(params.get("accountId")).toBe("3");
  });

  it("is preserved by buildHref, which Pagination uses for page 2", () => {
    const href = buildHref({ ...base, includeTransfers: true });
    expect(href).toContain("includeTransfers=true");
  });
});
