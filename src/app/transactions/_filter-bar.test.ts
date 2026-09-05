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
