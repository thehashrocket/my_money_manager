import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `import/actions.test.ts` mirrors each action's DB pipeline against a
 * `:memory:` database, deliberately minus the Next.js shell. That leaves the
 * shell itself untested — and the shell is where the defect these cases pin
 * lives, so nothing here could have been caught there. Same shape and same
 * reasoning as `accounts/actions.wiring.test.ts`.
 *
 * WHAT IS BEING DEFENDED, and why it is the worst instance in the app:
 *
 *   commitImport() ──▶ rows + batch + snapshot are DURABLE
 *        │
 *        ├── deletePendingImport()  ← the CSV is now gone
 *        │
 *        └── revalidatePath("/import")
 *              └── throws ──▶ redirect never runs ──▶ the boundary for the page
 *                    the form is ON — import/preview/[id]/error.tsx, not
 *                    import/error.tsx:
 *                    "Nothing was written — a preview is read-only. Committing
 *                     the import (a separate step) is the only action that
 *                     writes rows, and it snapshots the database first."
 *
 * Every word of that reassurance is false at that point — the separate step it
 * points at is the one that already ran — and the pending import is already
 * deleted, so the user's only signal is a screen telling them to try again
 * after several hundred rows landed.
 *
 * Deleting `guardRefresh` from `confirmImportAction` makes these fail.
 */

const revalidatePathMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() => vi.fn());
const commitImportMock = vi.hoisted(() => vi.fn());
const readPendingImportMock = vi.hoisted(() => vi.fn());
const deletePendingImportMock = vi.hoisted(() => vi.fn());
const undoImportCategorizationMock = vi.hoisted(() => vi.fn());
const checkAssetAccountMock = vi.hoisted(() => vi.fn());
const anchorUpdateRunMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

// The mock THROWS, because the real `redirect` does — that is how it aborts
// the rest of the action. A plain non-throwing mock let execution run on past
// the `redirect` in the `status: "empty"` branch and into code the real
// framework never reaches, which made a passing assertion there meaningless.
//
// It also sharpens the case these tests exist for: with the guard, the action
// rejects with a `RedirectSignal`; without it, it rejects with
// `revalidatePath blew up` and never reaches the redirect at all. Those are
// distinguishable, where "it rejected" alone would not be.
// Spreads the REAL module and overrides `redirect` only. `guardRefresh` now
// calls `unstable_rethrow` so a `redirect()` slipping inside a guarded callback
// cannot be swallowed — a hand-written stub for it would be a second spelling of
// Next's own control-flow detection, free to drift from the one production uses.
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, redirect: redirectMock };
});

vi.mock("@/lib/importBatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/importBatch")>();
  return { ...actual, commitImport: commitImportMock };
});

vi.mock("@/lib/pendingImport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pendingImport")>();
  return {
    ...actual,
    readPendingImport: readPendingImportMock,
    deletePendingImport: deletePendingImportMock,
  };
});

// `updateAccountAnchorAction`'s only READ. Mocked rather than served from the
// db stub below so the stub keeps its shape: the account lookup and the anchor
// UPDATE are separate concerns, and the redirect case cares only about the
// second one having committed.
vi.mock("@/lib/import/assetAccountGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/import/assetAccountGuard")>();
  return { ...actual, checkAssetAccount: checkAssetAccountMock };
});

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  // As close to `{}` as the file allows: `confirmImportAction` and
  // `undoImportCategorizationAction` reach no query of their own — the one
  // write each performs is mocked above. A query getting through would throw
  // loudly rather than quietly proving nothing.
  //
  // `update` is the one exception, and it is not a loosening: it exists
  // BECAUSE `updateAccountAnchorAction`'s redirect case is only meaningful
  // once the anchor move has actually committed. Nothing else in this file
  // touches it, so an unexpected query still fails the same way.
  return {
    ...actual,
    db: { update: () => ({ set: () => ({ where: () => ({ run: anchorUpdateRunMock }) }) }) },
  };
});

vi.mock("@/lib/categorize/undoImportCategorization", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/categorize/undoImportCategorization")
  >();
  return { ...actual, undoImportCategorization: undoImportCategorizationMock };
});

const { confirmImportAction, undoImportCategorizationAction, updateAccountAnchorAction } =
  await import("./actions");

/** A real 36-char UUID: `validateImportIdInput` requires one, and a short
 *  placeholder made every case here fail on validation before it reached the
 *  refresh under test. */
const PENDING_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const REFRESH_WARNING =
  "Your change was saved, but this page couldn't refresh — reload to see the current state.";

beforeEach(() => {
  revalidatePathMock.mockReset();
  redirectMock.mockReset();
  redirectMock.mockImplementation((url: string) => {
    throw new RedirectSignal(url);
  });
  commitImportMock.mockReset();
  readPendingImportMock.mockReset();
  deletePendingImportMock.mockReset();
  undoImportCategorizationMock.mockReset();
  undoImportCategorizationMock.mockReturnValue({ revertedCount: 0, perCategory: [] });
  checkAssetAccountMock.mockReset();
  checkAssetAccountMock.mockReturnValue({ ok: true, name: "Star One Checking" });
  anchorUpdateRunMock.mockReset();
  // The UPDATE matched a row. `changes === 0` is the deleted-account refusal,
  // which is a different case from the one below.
  anchorUpdateRunMock.mockReturnValue({ changes: 1 });

  readPendingImportMock.mockReturnValue({
    id: PENDING_ID,
    accountId: 1,
    filename: "star-one.csv",
    csv: "Date,Memo\n",
  });
  commitImportMock.mockReturnValue({ status: "ok", batchId: 77 });
});

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

/**
 * Awaits an action expected to end in a redirect and returns the destination.
 * Anything else — including the unguarded `revalidatePath` throw these tests
 * are about — is rethrown, so a missed redirect fails loudly rather than
 * returning `undefined` and being asserted against.
 */
async function redirectedTo(run: Promise<void>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("expected a redirect, but the action returned normally");
}

afterEach(() => vi.clearAllMocks());

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("confirmImportAction — a failed refresh must not claim nothing was imported", () => {
  it("still reaches the success page when revalidatePath throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    // The batch id is the whole point of getting here: `/import/success/77` is
    // where the anchor-move and snapshot-degraded warnings live (persisted on
    // `import_batches.snapshot_warning` per rule 5), and it is the only surface
    // that can offer the import-time-categorization undo.
    const url = await redirectedTo(confirmImportAction(formData({ id: PENDING_ID })));
    logged.mockRestore();

    expect(url).toBe("/import/success/77");
  });

  it("does not let the throw escape into error.tsx", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    // The direct statement of the bug. Unguarded, this rejects with
    // `revalidatePath blew up` — and a Server Action rejecting that way renders
    // `import/preview/[id]/error.tsx` (the form lives on the preview page),
    // whose copy states a preview is read-only and nothing was written, about a
    // commit that already happened. Guarded, the only thing that escapes is the
    // redirect signal, which is the framework working.
    await expect(
      confirmImportAction(formData({ id: PENDING_ID })),
    ).rejects.toBeInstanceOf(RedirectSignal);
    logged.mockRestore();
  });

  it("records the failure, since there is no state channel to carry it", async () => {
    // `confirmImportAction` is `Promise<void>` + redirect, so the user is never
    // told. That makes the log the ONLY record, and therefore load-bearing
    // rather than incidental.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    await redirectedTo(confirmImportAction(formData({ id: PENDING_ID })));

    expect(logged).toHaveBeenCalledWith(
      "[/import] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("redirects to the PREVIEW, not the success page, on an empty commit", async () => {
    // The other branch, pinned so the guard cannot be read as "always continue
    // to success". An empty file wrote nothing, so there is nothing to be
    // stale about and no batch to link to.
    commitImportMock.mockReturnValue({ status: "empty" });

    const url = await redirectedTo(confirmImportAction(formData({ id: PENDING_ID })));

    expect(url).toBe(`/import/preview/${PENDING_ID}`);
    // The pending import SURVIVES an empty commit — the user is being sent back
    // to the preview to try again, and deleting it would strand them there.
    // Only meaningful because the redirect mock throws like the real one; a
    // non-throwing mock ran on past it and this assertion failed for a reason
    // the framework would never produce.
    expect(deletePendingImportMock).not.toHaveBeenCalled();
  });
});

describe("confirmImportAction — the ordinary path is unchanged", () => {
  it("commits, clears the pending import, refreshes and redirects", async () => {
    revalidatePathMock.mockImplementation(() => {});

    const url = await redirectedTo(confirmImportAction(formData({ id: PENDING_ID })));
    expect(url).toBe("/import/success/77");

    expect(commitImportMock).toHaveBeenCalledWith({
      accountId: 1,
      filename: "star-one.csv",
      csvText: "Date,Memo\n",
    });
    expect(deletePendingImportMock).toHaveBeenCalledWith(PENDING_ID);
    expect(revalidatePathMock).toHaveBeenCalledWith("/import");
  });
});

describe("the warning string is the shared one", () => {
  it("matches `REFRESH_FAILED_WARNING`, so surfaces cannot drift apart", async () => {
    // Two hand-maintained copies of this sentence already existed and had
    // already diverged in wording. Pinned against the shared module rather than
    // re-typed here.
    const { REFRESH_FAILED_WARNING } = await import("@/lib/revalidateAfterWrite");
    expect(REFRESH_FAILED_WARNING).toBe(REFRESH_WARNING);
  });
});

/**
 * The SECOND redirecting action in this file, and it was the untested half.
 *
 * `confirmImportAction` above pins that the guard does not eat the redirect on
 * the import path. `undoImportCategorizationAction` has the same two-line
 * shape — `guardRefresh(...)` then `redirect(...)` — written from the same
 * comment, and nothing held it there: moving the `redirect` inside `run` (the
 * obvious "tidy these two into one block" edit) compiles, and `guardRefresh`
 * would then catch the navigation signal and return it as a warning string
 * nobody reads. The user stays on the page they submitted from, which is the
 * SAME URL this redirects to, so the only visible symptom is a stale
 * revertible-count — indistinguishable from the undo not having worked, on the
 * one surface that offers it.
 */
describe("undoImportCategorizationAction — the guard must not eat the redirect", () => {
  it("returns to the batch's success page when revalidatePath throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    const url = await redirectedTo(undoImportCategorizationAction(formData({ batchId: "77" })));
    logged.mockRestore();

    // The rows were reverted before this line; an escaping throw would render
    // `import/error.tsx` and claim otherwise.
    expect(undoImportCategorizationMock).toHaveBeenCalled();
    expect(url).toBe("/import/success/77");
  });

  it("revalidates the success page itself, then redirects to it", async () => {
    // The stale-payload case a `/ship` review found: this redirect returns to
    // the exact URL that was just rendered with the PRE-undo count, so the
    // success page has to be in the revalidated set or Next can serve it back
    // unchanged.
    revalidatePathMock.mockImplementation(() => {});

    const url = await redirectedTo(undoImportCategorizationAction(formData({ batchId: "77" })));

    expect(revalidatePathMock).toHaveBeenCalledWith("/import/success/77");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget/[year]/[month]", "page");
    expect(url).toBe("/import/success/77");
  });
});

/**
 * The THIRD redirecting action in this file, and the last of the three
 * `guardRefresh(...)` + `redirect(...)` pairs on this route to get a test.
 *
 * The shape is identical to the two above, and so is the edit that breaks it:
 * folding the `redirect` into `guardRefresh`'s callback compiles, reads as
 * tidier, and hands the navigation signal — which `redirect` raises by
 * THROWING — straight to the guard, which converts it into a warning string.
 * This action is `Promise<void>`, so there is no state channel and nothing
 * anywhere reads that string.
 *
 * What the user sees then is worse here than on the other two. The anchor
 * UPDATE has committed; `/import` never navigates, so the form sits there with
 * the old figure still in it and no message. Rule 1 makes an anchor move
 * forward-only, so the natural response — type it again — cannot walk it back,
 * and this form is the only escape hatch there is.
 */
describe("updateAccountAnchorAction — the guard must not eat the redirect", () => {
  function anchorForm(): FormData {
    return formData({
      accountId: "1",
      startingBalance: "1250.75",
      startingBalanceDate: "2026-01-01",
    });
  }

  it("still redirects to /import when revalidatePath throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    const url = await redirectedTo(updateAccountAnchorAction(anchorForm()));
    logged.mockRestore();

    // The anchor moved BEFORE the refresh, which is what makes swallowing the
    // navigation a lie rather than a cosmetic loss.
    expect(anchorUpdateRunMock).toHaveBeenCalled();
    expect(url).toBe("/import");
  });

  it("records the failure, since `Promise<void>` leaves the log as the only channel", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    await redirectedTo(updateAccountAnchorAction(anchorForm()));

    expect(logged).toHaveBeenCalledWith(
      "[/import] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("refreshes then redirects on the ordinary path", async () => {
    revalidatePathMock.mockImplementation(() => {});

    const url = await redirectedTo(updateAccountAnchorAction(anchorForm()));

    expect(url).toBe("/import");
    expect(revalidatePathMock).toHaveBeenCalledWith("/import");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("throws instead of redirecting when the account is a liability (E18)", async () => {
    // The other direction: the guard must not have widened what this accepts.
    // A liability reaching this raw signed form is rule 9's corruption path,
    // and the refusal happens before any write, so there is nothing to be
    // stale about and no redirect to protect.
    checkAssetAccountMock.mockReturnValue({ ok: false, reason: "Citi Visa is a credit card" });

    await expect(updateAccountAnchorAction(anchorForm())).rejects.toThrow(/credit card/);
    expect(anchorUpdateRunMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
