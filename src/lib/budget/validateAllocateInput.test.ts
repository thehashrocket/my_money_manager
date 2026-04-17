import { describe, expect, it } from "vitest";
import { validateAllocateInput } from "./validateAllocateInput";

const valid = {
  categoryId: 7,
  year: 2026,
  month: 4,
  allocatedCents: 40000,
};

describe("validateAllocateInput — happy path", () => {
  it("accepts a well-formed numeric input", () => {
    const result = validateAllocateInput(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it("coerces FormData-style strings to numbers", () => {
    const result = validateAllocateInput({
      categoryId: "7",
      year: "2026",
      month: "4",
      allocatedCents: "40000",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(valid);
  });

  it("accepts allocatedCents = 0 (explicit zero is distinct from no allocation)", () => {
    const result = validateAllocateInput({ ...valid, allocatedCents: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allocatedCents).toBe(0);
  });

  it("accepts month = 1 (January)", () => {
    const result = validateAllocateInput({ ...valid, month: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts month = 12 (December)", () => {
    const result = validateAllocateInput({ ...valid, month: 12 });
    expect(result.success).toBe(true);
  });

  it("accepts year = 2000 (lower bound)", () => {
    const result = validateAllocateInput({ ...valid, year: 2000 });
    expect(result.success).toBe(true);
  });

  it("accepts year = 2100 (upper bound)", () => {
    const result = validateAllocateInput({ ...valid, year: 2100 });
    expect(result.success).toBe(true);
  });
});

describe("validateAllocateInput — rejections", () => {
  it("rejects negative allocatedCents", () => {
    const result = validateAllocateInput({ ...valid, allocatedCents: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("allocatedCents");
    }
  });

  it("rejects non-integer allocatedCents", () => {
    const result = validateAllocateInput({ ...valid, allocatedCents: 100.5 });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric allocatedCents string", () => {
    const result = validateAllocateInput({ ...valid, allocatedCents: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejects categoryId = 0 (must be positive)", () => {
    const result = validateAllocateInput({ ...valid, categoryId: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("categoryId");
    }
  });

  it("rejects negative categoryId", () => {
    const result = validateAllocateInput({ ...valid, categoryId: -3 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer categoryId", () => {
    const result = validateAllocateInput({ ...valid, categoryId: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects month = 0", () => {
    const result = validateAllocateInput({ ...valid, month: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("month");
    }
  });

  it("rejects month = 13", () => {
    const result = validateAllocateInput({ ...valid, month: 13 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer month", () => {
    const result = validateAllocateInput({ ...valid, month: 4.5 });
    expect(result.success).toBe(false);
  });

  it("rejects year = 1999 (below range)", () => {
    const result = validateAllocateInput({ ...valid, year: 1999 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("year");
    }
  });

  it("rejects year = 2101 (above range)", () => {
    const result = validateAllocateInput({ ...valid, year: 2101 });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields (reports each missing path)", () => {
    const result = validateAllocateInput({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join(".")).sort();
      expect(paths).toEqual([
        "allocatedCents",
        "categoryId",
        "month",
        "year",
      ]);
    }
  });

  it("rejects non-object input", () => {
    expect(validateAllocateInput(null).success).toBe(false);
    expect(validateAllocateInput(undefined).success).toBe(false);
    expect(validateAllocateInput("nope").success).toBe(false);
    expect(validateAllocateInput(42).success).toBe(false);
  });
});
