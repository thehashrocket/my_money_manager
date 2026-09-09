import { describe, expect, it } from "vitest";
import { validateBulkRetargetInput } from "./validateBulkRetargetInput";

/**
 * The pure half of `bulkRetargetAction`'s trust boundary. Mirrors
 * `validateBulkCategorizeInput.test.ts` case for case, plus the one field
 * that has no sibling: `fromCategoryId`.
 *
 * Worth pinning rather than leaning on the DB-bound checks downstream,
 * because two of the coercions decide which of `bulkRetarget`'s refusals a
 * bad post reaches. A `fromCategoryId` that slipped through as `NaN` would
 * match no rows and surface as `NoRowsToRetargetError` — a sentence that
 * tells the user to reload, for input that no reload will fix.
 */
describe("validateBulkRetargetInput", () => {
  it("accepts a well-formed FormData-style object", () => {
    const result = validateBulkRetargetInput({
      normalizedMerchant: "SAFEWAY",
      fromCategoryId: "7",
      categoryId: "42",
      rememberMerchant: "true",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      normalizedMerchant: "SAFEWAY",
      fromCategoryId: 7,
      categoryId: 42,
      rememberMerchant: true,
    });
  });

  it("defaults rememberMerchant to false when the checkbox is absent", () => {
    // An unticked checkbox posts NOTHING, so the default is the common case
    // rather than a defensive one.
    const result = validateBulkRetargetInput({
      normalizedMerchant: "SAFEWAY",
      fromCategoryId: "1",
      categoryId: "2",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rememberMerchant).toBe(false);
  });

  it("coerces rememberMerchant='false' to false", () => {
    const result = validateBulkRetargetInput({
      normalizedMerchant: "SAFEWAY",
      fromCategoryId: "1",
      categoryId: "2",
      rememberMerchant: "false",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rememberMerchant).toBe(false);
  });

  it("ACCEPTS the empty normalizedMerchant, which is a real stored key", () => {
    /* Same reversal `validateBulkCategorizeInput` documents: `""` is what a
       blank bank memo normalizes to, it is a real group on `/transactions`,
       and a `.min(1)` here would make the repair throw on the one group with
       no other way back. Remember is still refused for the key
       (`keyTrainability`); the ROWS are not. */
    const result = validateBulkRetargetInput({
      normalizedMerchant: "",
      fromCategoryId: "1",
      categoryId: "2",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.normalizedMerchant).toBe("");
  });

  it("normalizes whitespace-only to the empty key rather than rejecting it", () => {
    const result = validateBulkRetargetInput({
      normalizedMerchant: "   ",
      fromCategoryId: "1",
      categoryId: "2",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.normalizedMerchant).toBe("");
  });

  it("trims leading/trailing whitespace", () => {
    const result = validateBulkRetargetInput({
      normalizedMerchant: "  SAFEWAY  ",
      fromCategoryId: "1",
      categoryId: "2",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.normalizedMerchant).toBe("SAFEWAY");
  });

  it("rejects a missing fromCategoryId rather than defaulting it", () => {
    // This path moves rows that are already FILED, so there is no "no
    // category" reading of a missing source the way `bulkCategorize` has one.
    const result = validateBulkRetargetInput({
      normalizedMerchant: "SAFEWAY",
      categoryId: "2",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 'none' as a fromCategoryId — uncategorized rows are bulkCategorize's job", () => {
    /* The row form's picker uses the sentinel `"none"`; this control must not
       inherit it. Conflating the two would give one action two different undo
       semantics (reset-to-NULL vs reset-to-source). */
    const result = validateBulkRetargetInput({
      normalizedMerchant: "SAFEWAY",
      fromCategoryId: "none",
      categoryId: "2",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-3"],
    ["non-numeric", "abc"],
    ["non-integer", "1.5"],
  ])("rejects a %s id in EITHER position", (_label, value) => {
    // Both ids get the same `.int().positive()`, and both need it: a
    // `fromCategoryId` of 0 or NaN matches no rows and would surface as
    // `NoRowsToRetargetError`, whose advice ("reload") cannot help.
    expect(
      validateBulkRetargetInput({
        normalizedMerchant: "SAFEWAY",
        fromCategoryId: "1",
        categoryId: value,
      }).success,
    ).toBe(false);
    expect(
      validateBulkRetargetInput({
        normalizedMerchant: "SAFEWAY",
        fromCategoryId: value,
        categoryId: "2",
      }).success,
    ).toBe(false);
  });

  it("rejects source === destination in the PURE layer", () => {
    /* This is a cross-field check with no database in it, so it belongs here —
       the module's contract is that DB-free checks run first. It used to be
       enforced only by `SameCategoryRetargetError`, which fires after the write
       transaction has opened and two SELECTs have run.

       `SameCategoryRetargetError` still exists and is still thrown: it carries
       the category NAME (which needs a lookup, and is why the check was put
       there originally), and a second writer can make source and destination
       collide between this validation and the UPDATE. This closes the common
       case at the cheap layer; that one stays as the backstop. */
    const result = validateBulkRetargetInput({
      normalizedMerchant: "SAFEWAY",
      fromCategoryId: "5",
      categoryId: "5",
    });
    expect(result.success).toBe(false);
  });

  it("still accepts a genuine move between two different categories", () => {
    const result = validateBulkRetargetInput({
      normalizedMerchant: "SAFEWAY",
      fromCategoryId: "5",
      categoryId: "6",
    });
    expect(result.success).toBe(true);
  });
});
