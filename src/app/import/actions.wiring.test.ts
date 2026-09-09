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
 *              └── throws ──▶ redirect never runs ──▶ import/error.tsx:
 *                    "Nothing was imported. Every import snapshots the database
 *                     before it writes, and commits happen in a single
 *                     transaction."
 *
 * Every word of that reassurance is false at that point, and the pending
 * import is already deleted, so the user's only signal is a screen telling
 * them to try again — after several hundred rows landed.
 *
 * Deleting `guardRefresh` from `confirmImportAction` makes these fail.
 */

const revalidatePathMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() => vi.fn());
const commitImportMock = vi.hoisted(() => vi.fn());
const readPendingImportMock = vi.hoisted(() => vi.fn());
const deletePendingImportMock = vi.hoisted(() => vi.fn());

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
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

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

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  // `{}` on purpose: `confirmImportAction` reaches no query of its own — the
  // one write it performs is `commitImport`, which is mocked. A query getting
  // through would throw loudly rather than quietly proving nothing.
  return { ...actual, db: {} };
});

const { confirmImportAction } = await import("./actions");

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
    // `import/error.tsx`, whose copy states the ledger is unchanged about a
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
