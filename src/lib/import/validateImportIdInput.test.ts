import { describe, expect, it } from "vitest";
import { validateImportIdInput } from "./validateImportIdInput";

describe("validateImportIdInput", () => {
  it("accepts a UUID v4", () => {
    const result = validateImportIdInput({
      id: "12345678-abcd-4ef0-8123-456789abcdef",
    });
    expect(result.success).toBe(true);
  });

  it("accepts uppercase hex", () => {
    const result = validateImportIdInput({
      id: "12345678-ABCD-4EF0-8123-456789ABCDEF",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty id", () => {
    expect(validateImportIdInput({ id: "" }).success).toBe(false);
  });

  it("rejects id with path traversal characters", () => {
    expect(
      validateImportIdInput({ id: "../../etc/passwd" }).success,
    ).toBe(false);
  });

  it("rejects id with wrong length", () => {
    expect(validateImportIdInput({ id: "abc" }).success).toBe(false);
    expect(
      validateImportIdInput({
        id: "12345678-abcd-4ef0-8123-456789abcdefX",
      }).success,
    ).toBe(false);
  });

  it("rejects id with non-hex characters", () => {
    expect(
      validateImportIdInput({
        id: "zzzzzzzz-abcd-4ef0-8123-456789abcdef",
      }).success,
    ).toBe(false);
  });

  it("rejects missing id", () => {
    expect(validateImportIdInput({}).success).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateImportIdInput(null).success).toBe(false);
    expect(validateImportIdInput(undefined).success).toBe(false);
    expect(validateImportIdInput("nope").success).toBe(false);
  });
});
