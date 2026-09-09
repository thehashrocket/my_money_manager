import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `notifyWrite` / `notifyUndo` are pure decision functions that happen to end
 * in a Sonner call, so they are testable in the way a component is not —
 * the same reason `action-status.test.ts` covers `warningOf`/`statusRole`/
 * `statusTone` while their component stays under CLAUDE.md's V1 exclusion.
 *
 * They were three hand-copied inline blocks until the simplification pass, and
 * extraction is only a win if the rule survives it. What they encode is rule 6:
 * ONE toast for a committed write, never a success plus a warning, because
 * `<Toaster>` runs Sonner's collapsed stack and a non-newest toast has its
 * ACTION BUTTON drawn invisible — and that button is the only way back inside
 * the Undo window, for the rows and for a rule a refusal removed.
 *
 * Verified needed: with no test here, changing the success/warning choice to an
 * unconditional `toast.success` left all 1,948 tests green.
 */

const success = vi.hoisted(() => vi.fn());
const warning = vi.hoisted(() => vi.fn());
const plain = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => {
  const toast = Object.assign(plain, { success, warning, error: vi.fn() });
  return { toast };
});

const { notifyWrite, notifyUndo } = await import("./write-toast");

beforeEach(() => {
  success.mockReset();
  warning.mockReset();
  plain.mockReset();
});
afterEach(() => vi.clearAllMocks());

const undo = { onUndo: () => {} };

describe("notifyWrite", () => {
  it("is a SUCCESS when there is nothing else to say", () => {
    notifyWrite("Categorized 3 rows as Groceries.", [], undo);

    expect(success).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
    expect(success.mock.calls[0][0]).toBe("Categorized 3 rows as Groceries.");
  });

  it("is demoted to a WARNING by any note — a warning is not a success", () => {
    notifyWrite("Categorized 3 rows.", ["The rule for K was removed."], undo);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
  });

  it("MERGES every note into the one toast rather than stacking", () => {
    // The whole point: a second toast would have its Undo button drawn
    // invisible behind the first.
    notifyWrite("Filed 3 rows.", ["Rule removed.", "Page couldn't refresh."], undo);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(warning.mock.calls[0][0]).toBe(
      "Filed 3 rows. Rule removed. Page couldn't refresh.",
    );
  });

  it("drops BOTH null and undefined notes", () => {
    // The two sources spell "nothing to say" differently: `ruleRefusal?.message`
    // gives undefined, a nullable server field gives null. Filtering only one
    // put the literal string "null" into a user-facing sentence.
    notifyWrite("Filed 3 rows.", [null, undefined], undo);

    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0][0]).toBe("Filed 3 rows.");
  });

  it("always carries the Undo, on the success and the warning branch alike", () => {
    const onUndo = vi.fn();

    notifyWrite("Filed.", [], { onUndo });
    notifyWrite("Filed.", ["A note."], { onUndo });

    for (const call of [success.mock.calls[0], warning.mock.calls[0]]) {
      expect(call[1]).toMatchObject({ action: { label: "Undo" } });
      // Long enough to read the notice AND press the button — the default is
      // shorter than the window the Undo is worth.
      expect(call[1].duration).toBe(10_000);
    }
  });
});

describe("notifyUndo", () => {
  it("is a PLAIN toast when the undo refreshed cleanly", () => {
    // Not `toast.success`: the undo is a reversal, and the surfaces that call
    // it were already reporting it plainly.
    notifyUndo("Reverted 3 rows.", undefined);

    expect(plain).toHaveBeenCalledWith("Reverted 3 rows.");
    expect(warning).not.toHaveBeenCalled();
  });

  it("is a WARNING carrying the sentence when the undo's own refresh failed", () => {
    // The undo is a committed write too — it restores the rule the refusal
    // removed — so its own failed refresh has to be said.
    notifyUndo("Reverted 3 rows.", "Reload to see the current state.");

    expect(warning).toHaveBeenCalledWith(
      "Reverted 3 rows. Reload to see the current state.",
    );
    expect(plain).not.toHaveBeenCalled();
  });
});
