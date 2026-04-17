import { describe, expect, it } from "vitest";
import {
  MAX_CSV_BYTES,
  validateUploadCsvInput,
} from "./validateUploadCsvInput";

function makeFile(size: number, name = "export.csv"): File {
  return new File([new Uint8Array(size)], name, { type: "text/csv" });
}

describe("validateUploadCsvInput — happy path", () => {
  it("accepts a small CSV with integer accountId", () => {
    const result = validateUploadCsvInput({
      accountId: 3,
      file: makeFile(1024),
    });
    expect(result.success).toBe(true);
  });

  it("coerces FormData-style accountId string", () => {
    const result = validateUploadCsvInput({
      accountId: "3",
      file: makeFile(1024),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.accountId).toBe(3);
  });

  it("accepts a file right at the MAX_CSV_BYTES limit", () => {
    const result = validateUploadCsvInput({
      accountId: 1,
      file: makeFile(MAX_CSV_BYTES),
    });
    expect(result.success).toBe(true);
  });
});

describe("validateUploadCsvInput — rejections", () => {
  it("rejects accountId = 0", () => {
    const result = validateUploadCsvInput({
      accountId: 0,
      file: makeFile(100),
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative accountId", () => {
    const result = validateUploadCsvInput({
      accountId: -1,
      file: makeFile(100),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-File file field (e.g. string from empty FormData)", () => {
    const result = validateUploadCsvInput({
      accountId: 1,
      file: "not-a-file",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty file (size = 0)", () => {
    const result = validateUploadCsvInput({
      accountId: 1,
      file: makeFile(0),
    });
    expect(result.success).toBe(false);
  });

  it("rejects file over MAX_CSV_BYTES (closes v0.2.0 P3)", () => {
    const result = validateUploadCsvInput({
      accountId: 1,
      file: makeFile(MAX_CSV_BYTES + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/exceeds/);
    }
  });

  it("rejects missing accountId", () => {
    const result = validateUploadCsvInput({ file: makeFile(100) });
    expect(result.success).toBe(false);
  });

  it("rejects missing file", () => {
    const result = validateUploadCsvInput({ accountId: 1 });
    expect(result.success).toBe(false);
  });
});
