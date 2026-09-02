import { describe, expect, it } from "vitest";
import {
  validateLinkAccountInput,
  validateResolveTransferInput,
  validateUndoSyncInput,
} from "./validateSyncInputs";

describe("validateLinkAccountInput", () => {
  it("coerces the FormData string accountId to a number", () => {
    const r = validateLinkAccountInput({
      accountId: "7",
      simplefinAccountId: "ACT-abc123",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.accountId).toBe(7);
  });

  it("maps an empty selection to null — this IS the unlink path", () => {
    const r = validateLinkAccountInput({ accountId: "1", simplefinAccountId: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.simplefinAccountId).toBeNull();
  });

  it("rejects a whitespace-only selection rather than reading it as unlink", () => {
    // Fail closed. Only the exact empty string means unlink; silently
    // reinterpreting unexpected input as unlink would stop syncing an account
    // the user never asked to disconnect.
    const r = validateLinkAccountInput({ accountId: "1", simplefinAccountId: "   " });
    expect(r.success).toBe(false);
  });

  it("rejects an account id that isn't a positive integer", () => {
    for (const accountId of ["0", "-1", "1.5", "abc", ""]) {
      expect(validateLinkAccountInput({ accountId, simplefinAccountId: "" }).success).toBe(
        false,
      );
    }
  });

  it("rejects characters outside the provider's id charset", () => {
    for (const id of ["ACT-abc/../etc", "ACT abc", "ACT<script>", "ACT'; DROP--"]) {
      expect(
        validateLinkAccountInput({ accountId: "1", simplefinAccountId: id }).success,
      ).toBe(false);
    }
  });

  it("rejects an over-long id", () => {
    const r = validateLinkAccountInput({
      accountId: "1",
      simplefinAccountId: "A".repeat(201),
    });
    expect(r.success).toBe(false);
  });
});

describe("validateUndoSyncInput", () => {
  it("accepts a positive integer batch id", () => {
    const r = validateUndoSyncInput({ batchId: "12" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.batchId).toBe(12);
  });

  it("rejects zero, negatives and non-numeric batch ids", () => {
    for (const batchId of ["0", "-3", "abc", ""]) {
      expect(validateUndoSyncInput({ batchId }).success).toBe(false);
    }
  });
});

describe("validateResolveTransferInput", () => {
  it("accepts two distinct transaction ids", () => {
    const r = validateResolveTransferInput({ aId: "4", bId: "9" });
    expect(r.success).toBe(true);
    if (r.success) expect([r.data.aId, r.data.bId]).toEqual([4, 9]);
  });

  it("refuses to pair a transaction with itself", () => {
    const r = validateResolveTransferInput({ aId: "4", bId: "4" });
    expect(r.success).toBe(false);
  });

  it("rejects non-positive ids", () => {
    expect(validateResolveTransferInput({ aId: "0", bId: "4" }).success).toBe(false);
    expect(validateResolveTransferInput({ aId: "4", bId: "-1" }).success).toBe(false);
  });
});
