import { describe, expect, it } from "vitest";
import { parseScopeParams } from "./scopeParams";

describe("parseScopeParams", () => {
  it("returns undefined (all time) when both params are absent", () => {
    expect(parseScopeParams({})).toBeUndefined();
  });

  it("parses a well-formed year+month pair", () => {
    expect(parseScopeParams({ year: "2026", month: "9" })).toEqual({
      year: 2026,
      month: 9,
    });
  });

  it("falls back to all-time when only year is present", () => {
    expect(parseScopeParams({ year: "2026" })).toBeUndefined();
  });

  it("falls back to all-time when only month is present", () => {
    expect(parseScopeParams({ month: "9" })).toBeUndefined();
  });

  it("falls back to all-time on an out-of-range month, rather than throwing", () => {
    expect(parseScopeParams({ year: "2026", month: "13" })).toBeUndefined();
  });

  it("falls back to all-time on a non-numeric value", () => {
    expect(parseScopeParams({ year: "abc", month: "9" })).toBeUndefined();
  });

  it("falls back to all-time on a repeated query param (string[])", () => {
    expect(
      parseScopeParams({ year: ["2026", "2027"], month: "9" }),
    ).toBeUndefined();
  });

  it("falls back to all-time on a year below the schema's floor (1999)", () => {
    expect(parseScopeParams({ year: "1999", month: "9" })).toBeUndefined();
  });

  it("falls back to all-time on a year above the schema's ceiling (3000)", () => {
    expect(parseScopeParams({ year: "3000", month: "9" })).toBeUndefined();
  });

  it("ignores unrelated query params rather than rejecting the whole request", () => {
    expect(
      parseScopeParams({ year: "2026", month: "9", unrelated: "x" }),
    ).toEqual({ year: 2026, month: 9 });
  });
});
