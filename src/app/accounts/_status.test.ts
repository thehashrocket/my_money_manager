import { describe, expect, it } from "vitest";
import { statusRole, statusTone, warningOf, type StatusState } from "./_status";

/**
 * The PURE half of `/accounts`' inline status line. Not a component test —
 * CLAUDE.md excludes those — these three functions take a state object and
 * return a string, and they carry the one decision the component makes.
 *
 * WHAT IS ACTUALLY BEING DEFENDED: a refresh warning is announced with
 * `role="alert"`, never `role="status"`. The docblock on `_status.tsx` spells
 * out why, and it is a money argument rather than an accessibility nicety — the
 * warning says the write LANDED, and a user who does not hear it reads the
 * stale row and resubmits. Under rule 9 a second reconcile spends the account's
 * one `prior_starting_balance_*` slot on the value the first write already
 * stored, so the true prior anchor stops existing anywhere.
 *
 * `warningOf` also owns the narrowing that a warning can only ride on `ok`.
 * `_charge-dialog.tsx` reuses `statusTone`/`statusRole` without the component,
 * so these are a shared contract, not internals.
 */

const OK: StatusState = { status: "ok", message: "Visa is now -$2,148.32." };
const OK_WARNED: StatusState = {
  status: "ok",
  message: "Visa is now -$2,148.32.",
  warning: "Your change was saved, but this page couldn't refresh — reload to see the current state.",
};
const ERROR: StatusState = { status: "error", message: "Enter what you owe as a positive number." };
const IDLE: StatusState = { status: "idle" };

describe("warningOf", () => {
  it("returns the warning on an ok state", () => {
    expect(warningOf(OK_WARNED)).toBe(OK_WARNED.status === "ok" ? OK_WARNED.warning : undefined);
    expect(warningOf(OK_WARNED)).toMatch(/couldn't refresh/);
  });

  it("is undefined for a plain success, an error and idle", () => {
    // An always-truthy answer would paint every ordinary save as degraded, and
    // would flip `statusRole` to `alert` on every single click.
    expect(warningOf(OK)).toBeUndefined();
    expect(warningOf(ERROR)).toBeUndefined();
    expect(warningOf(IDLE)).toBeUndefined();
  });
});

describe("statusRole", () => {
  it("announces a WARNING assertively, exactly like an error", () => {
    // The case this file exists for. `status` is a polite live region that a
    // screen reader may hold until the user goes idle — and on a page of four
    // independent per-row forms, a message nobody hears reads as the click
    // having simply worked.
    expect(statusRole(OK_WARNED)).toBe("alert");
    expect(statusRole(ERROR)).toBe("alert");
  });

  it("keeps a plain success polite", () => {
    expect(statusRole(OK)).toBe("status");
    expect(statusRole(IDLE)).toBe("status");
  });
});

describe("statusTone", () => {
  it("does not paint a committed write in the failure colour", () => {
    // A warned success is NOT an error: the row exists. Reusing the error tone
    // would tell a colour-reading user the opposite of what happened.
    expect(statusTone(ERROR)).toBe("text-redbrown");
    expect(statusTone(OK_WARNED)).not.toBe("text-redbrown");
    expect(statusTone(OK_WARNED)).not.toBe(statusTone(OK));
  });
});
