import { describe, expect, it } from "vitest";
import {
  LINK_INTENT,
  REJECT_INTENT,
  RESOLVE_INTENTS,
  validateLinkAccountInput,
  validateResolveReversalInput,
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

describe("validateResolveReversalInput — the intent discriminant", () => {
  // `intent` is the one field on /sync whose two values have OPPOSITE effects
  // on money: "link" pairs two rows (removing both from every spending
  // surface, undoably) and "reject" writes a durable never-ask-again. The
  // schema's own defaulting was previously asserted only two hops away, in
  // src/app/sync/actions.test.ts, through a mocked write layer. These pin it at
  // the boundary that actually decides it.

  it("REFUSES a missing intent rather than defaulting it to either branch", () => {
    // The schema deliberately has no `.default(...)`. An absent `intent` used
    // to mean "link", which made "the user pressed Link" and "the submitter's
    // field was lost" byte-identical on the wire — and the lost-field reading
    // silently removes both rows from every spending surface (CLAUDE.md rule
    // 4). Both buttons name themselves now, so absence is a bug, not an answer.
    const r = validateResolveReversalInput({ aId: "7", bId: "9" });
    expect(r.success).toBe(false);
  });

  it("round-trips LINK_INTENT — the value the primary submitter carries", () => {
    const r = validateResolveReversalInput({ aId: "7", bId: "9", intent: LINK_INTENT });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.intent).toBe(LINK_INTENT);
  });

  it("keeps both intents distinct and spelled the way the buttons emit them", () => {
    // The two constants are what the buttons put on the wire and what the
    // action branches on. A rename that reached only one of the three sites
    // would send a value the enum refuses — loud, which is the point.
    expect(LINK_INTENT).toBe("link");
    expect(REJECT_INTENT).toBe("reject");
    expect(LINK_INTENT).not.toBe(REJECT_INTENT);
    expect([...RESOLVE_INTENTS].sort()).toEqual([LINK_INTENT, REJECT_INTENT].sort());
  });

  it("round-trips REJECT_INTENT — the value the “Not a reversal” submitter carries", () => {
    // The button emits `REJECT_INTENT` and the action branches on
    // `intent === REJECT_INTENT`; if the schema did not ACCEPT that same value
    // the enum would reject it and the whole reject path would 500 on every
    // click, or (worse, were it merely unlisted) fall through to the link
    // default.
    const r = validateResolveReversalInput({ aId: "7", bId: "9", intent: REJECT_INTENT });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.intent).toBe(REJECT_INTENT);
  });

  it("rejects an intent outside the enum rather than silently defaulting it", () => {
    // Fail loudly, not into either branch. A near-miss ("rejec", "REJECT") is
    // what a crafted or half-updated POST looks like, and treating it as the
    // default would make a typo indistinguishable from a deliberate link.
    for (const intent of ["rejec", "REJECT", "", "Link", "delete"]) {
      expect(validateResolveReversalInput({ aId: "7", bId: "9", intent }).success).toBe(
        false,
      );
    }
  });

  it("still carries the shared pair guards through the intersection", () => {
    // `resolveReversalInputSchema` is `resolveTransferInputSchema.and(...)`.
    // An intersection is easy to build in a way that drops the base schema's
    // `.refine`, which is the only thing stopping a row being paired with
    // itself.
    expect(
      validateResolveReversalInput({ aId: "7", bId: "7", intent: "reject" }).success,
    ).toBe(false);
    expect(
      validateResolveReversalInput({ aId: "0", bId: "9", intent: "link" }).success,
    ).toBe(false);
    expect(
      validateResolveReversalInput({ aId: "", bId: "9", intent: "link" }).success,
    ).toBe(false);
  });

  it("coerces both ids the same way the transfer schema does", () => {
    const r = validateResolveReversalInput({
      aId: "1299",
      bId: "1300",
      intent: LINK_INTENT,
    });
    expect(r.success).toBe(true);
    if (r.success) expect([r.data.aId, r.data.bId]).toEqual([1299, 1300]);
  });
});
