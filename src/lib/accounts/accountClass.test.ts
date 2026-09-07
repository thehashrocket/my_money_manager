import { describe, expect, it } from "vitest";
import { accountClass } from "./accountClass";

describe("accountClass", () => {
  it("classifies the two asset types", () => {
    expect(accountClass("checking")).toBe("asset");
    expect(accountClass("savings")).toBe("asset");
  });

  it("classifies the two liability types", () => {
    expect(accountClass("credit")).toBe("liability");
    expect(accountClass("loan")).toBe("liability");
  });

  it("is total over the enum — every type maps to exactly one class", () => {
    const types = ["checking", "savings", "credit", "loan"] as const;
    for (const t of types) {
      expect(["asset", "liability"]).toContain(accountClass(t));
    }
  });

  it("throws rather than defaulting to asset on an unrecognized type (F6)", () => {
    // `accounts.type` has no CHECK constraint, so a corrupted or
    // hand-edited row is reachable. Defaulting to "asset" here would fold a
    // debt into the dashboard's Cash figure silently; throwing is the
    // strictly better failure.
    expect(() =>
      // @ts-expect-error guarding the runtime boundary, not the type
      accountClass("investment"),
    ).toThrow(/unrecognized accounts.type/);
  });
});
