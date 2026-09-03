import { describe, expect, it } from "vitest";
import { validateUndoImportCategorizationInput } from "./validateUndoImportCategorizationInput";

describe("validateUndoImportCategorizationInput", () => {
  it("accepts a positive integer batchId", () => {
    const result = validateUndoImportCategorizationInput({ batchId: 12 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ batchId: 12 });
  });

  it("coerces a FormData-style string batchId", () => {
    const result = validateUndoImportCategorizationInput({ batchId: "12" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.batchId).toBe(12);
  });

  it("rejects a zero or negative batchId", () => {
    expect(validateUndoImportCategorizationInput({ batchId: 0 }).success).toBe(false);
    expect(validateUndoImportCategorizationInput({ batchId: -1 }).success).toBe(false);
  });

  it("rejects a non-integer batchId", () => {
    expect(validateUndoImportCategorizationInput({ batchId: 1.5 }).success).toBe(false);
  });

  it("rejects a non-numeric batchId", () => {
    expect(validateUndoImportCategorizationInput({ batchId: "abc" }).success).toBe(false);
  });

  it("rejects a missing batchId", () => {
    expect(validateUndoImportCategorizationInput({}).success).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateUndoImportCategorizationInput(null).success).toBe(false);
    expect(validateUndoImportCategorizationInput(undefined).success).toBe(false);
    expect(validateUndoImportCategorizationInput("nope").success).toBe(false);
  });
});
