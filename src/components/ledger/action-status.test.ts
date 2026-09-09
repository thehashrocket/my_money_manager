import { describe, expect, it } from "vitest";
import {
  statusRole,
  statusTone,
  warningOf,
  type ActionState,
} from "./action-status";

/**
 * The pure half of the shared status line.
 *
 * These are NOT UI-component tests — CLAUDE.md excludes those from V1. They pin
 * three decisions that carry a money invariant, and the invariant is rule 9's:
 * a refresh warning says the write LANDED, so a user who does not hear it
 * resubmits, and a second Reconcile overwrites `prior_starting_balance_cents`
 * with the value the first one stored. That account then has no way back — the
 * prior slot holds a figure that was never current.
 *
 * The helpers exist as exports because `_charge-dialog.tsx` needs the parts
 * without the component (it also decides whether to close on the same state).
 * That coupling is the reason to test them directly: a reviewer found the
 * previous version claimed the dialog reused them while the dialog in fact
 * hard-coded its own copies, so the "one spelling" guarantee was unwired at the
 * single place it named.
 */

const idle: ActionState = { status: "idle" };
const ok: ActionState = { status: "ok", message: "Saved." };
const warned: ActionState = { status: "ok", message: "Saved.", warning: "Reload to see it." };
const err: ActionState = { status: "error", message: "That didn't work." };

describe("warningOf", () => {
  it("reads the warning off a successful outcome", () => {
    expect(warningOf(warned)).toBe("Reload to see it.");
  });

  it("is undefined on a plain success", () => {
    expect(warningOf(ok)).toBeUndefined();
  });

  it("is undefined on error and idle — a warning can only ride on success", () => {
    // Not a style point. Putting one on `error` would send a committed write
    // back down the failure branch, which is the whole defect `guardRefresh`
    // exists to prevent.
    expect(warningOf(err)).toBeUndefined();
    expect(warningOf(idle)).toBeUndefined();
  });
});

describe("statusRole", () => {
  it("is `alert` for a refusal", () => {
    expect(statusRole(err)).toBe("alert");
  });

  it("is `alert` for a WARNED success — the case the invariant is about", () => {
    // A polite live region can be held until the user goes idle. This is the
    // message they must hear BEFORE they decide to resubmit.
    expect(statusRole(warned)).toBe("alert");
  });

  it("is `status` for a plain success only", () => {
    expect(statusRole(ok)).toBe("status");
  });
});

describe("statusTone", () => {
  it("marks a refusal", () => {
    expect(statusTone(err)).toContain("redbrown");
  });

  it("does NOT mark a warned success as an error", () => {
    // The message stays neutral; the amber rides on the warning block. Toning
    // the whole thing as an error would say the write failed.
    expect(statusTone(warned)).toBe(statusTone(ok));
    expect(statusTone(warned)).not.toContain("redbrown");
  });
});
