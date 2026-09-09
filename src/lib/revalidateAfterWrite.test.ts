import { afterEach, describe, expect, it, vi } from "vitest";
import { REFRESH_FAILED_WARNING, guardRefresh } from "./revalidateAfterWrite";

/**
 * The shared guard's own contract, pinned once so the eight route action files
 * that now depend on it do not each have to re-establish it.
 *
 * What is actually being defended: `revalidatePath` throws, and it runs AFTER
 * the write. An unguarded throw makes an action either report a refusal for a
 * commit that landed (when the call sits inside the write's `try`) or crash the
 * route into an `error.tsx` that says nothing was written. Both are false, and
 * this repo has shipped both — `/sync` in v0.22.0, `/budget` in v0.26.0.
 */

afterEach(() => vi.restoreAllMocks());

describe("guardRefresh", () => {
  it("returns undefined when the refresh succeeds, so `ok` stays plain", () => {
    // The `undefined` matters as much as the absence of a throw: callers spread
    // this straight into `{ status: "ok", warning }`, and a truthy sentinel here
    // would paint every successful write as a warning.
    expect(guardRefresh("/test", () => {})).toBeUndefined();
  });

  it("runs the callback exactly once", () => {
    const run = vi.fn();
    guardRefresh("/test", run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("SWALLOWS a throw and returns the warning instead", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warning = guardRefresh("/test", () => {
      throw new Error("revalidatePath blew up");
    });
    expect(warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("NEVER rethrows — that is the whole guarantee callers rely on", () => {
    // Load-bearing. Every `/accounts` action wraps its entire body, this call
    // included, in one `try` whose `catch` returns `{status:"error"}`. If this
    // ever rethrew, a committed reconcile would report as failed, the user
    // would resubmit, and the second write would overwrite
    // `prior_starting_balance_cents` with the value the first one stored —
    // spending rule 9's single undo slot on a figure that was never current.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      guardRefresh("/test", () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
  });

  it("logs the failure, tagged with the caller's scope", () => {
    // The developer-facing half. A failing `revalidatePath` is a bug in this
    // app rather than a user error, and the returned warning goes to someone
    // who cannot act on it — so the log is the only actionable record.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    guardRefresh("/accounts", () => {
      throw new Error("boom");
    });
    expect(logged).toHaveBeenCalledWith(
      "[/accounts] revalidation failed after a committed write",
      expect.any(Error),
    );
  });

  it("swallows a non-Error throw too", () => {
    // `revalidatePath` is framework code; nothing guarantees what it throws.
    // A `catch` that assumed `Error` would let a string escape as a route crash.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(guardRefresh("/test", () => {
      throw "a string";
    })).toBe(REFRESH_FAILED_WARNING);
  });
});
