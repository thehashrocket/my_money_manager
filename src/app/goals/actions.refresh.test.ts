import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/goals`' two actions revalidate AFTER a committed insert/update.
 *
 * `revalidatePath` throws in this Next build, and both ran bare — so the throw
 * escaped into `/goals/error.tsx`, whose copy affirmatively tells the reader
 * nothing was written. Acting on that is worse than a bare stale page: on the
 * create path, re-submitting collides with the name the first attempt already
 * took (`assertNameAvailable`) and reports a second, unrelated-looking error.
 *
 * Companion to `actions.test.ts`, which MIRRORS the actions against a real
 * schema rather than importing them. These import the real modules — the
 * revalidation wiring is the whole subject, and it is not observable in a
 * mirror — so `@/db` is mocked instead (importing it opens the real ledger
 * file). `revalidatePath` must actually THROW or the assertions pass with and
 * without the guard.
 */

const insertRunMock = vi.hoisted(() => vi.fn());
const updateRunMock = vi.hoisted(() => vi.fn());
const categoryRowMock = vi.hoisted(() => ({
  current: {
    id: 4,
    name: "Vacation",
    kind: "fund" as "income" | "expense" | "fund",
    archivedAt: null as Date | null,
  },
}));

const dbMock = vi.hoisted(() => ({
  insert: () => ({ values: () => ({ run: insertRunMock }) }),
  select: () => ({ from: () => ({ where: () => ({ get: () => categoryRowMock.current }) }) }),
  update: () => ({ set: () => ({ where: () => ({ run: updateRunMock }) }) }),
}));

const redirectMock = vi.hoisted(() =>
  vi.fn(() => {
    // The real `redirect` signals by THROWING. Mirrored here so a regression
    // that moves the call inside `guardRefresh`'s callback is caught: the guard
    // would swallow the navigation into a warning, and only a throwing mock can
    // tell that apart from a redirect that never ran.
    throw new Error("NEXT_REDIRECT");
  }),
);

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

vi.mock("@/db", async () => ({
  db: dbMock,
  schema: await import("@/db/schema"),
}));

vi.mock("@/lib/budget/manageCategories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budget/manageCategories")>()),
  assertNameAvailable: vi.fn(),
}));

const { revalidatePath } = await import("next/cache");
const { createGoalAction, updateGoalTargetAction } = await import("./actions");

// Imported, never re-typed. Two hand-maintained copies of this sentence
// already existed in this app and had already diverged in wording, which is
// the whole reason the shared module exists — a local literal here re-creates
// exactly the drift it was extracted to end. It has zero imports, so it is
// safe in this mock graph.
const { REFRESH_FAILED_WARNING } = await import("@/lib/revalidateAfterWrite");

function createForm(): FormData {
  const fd = new FormData();
  fd.set("name", "Vacation");
  fd.set("targetDollars", "500");
  fd.set("carryoverPolicy", "rollover");
  return fd;
}

function targetForm(): FormData {
  const fd = new FormData();
  fd.set("categoryId", "4");
  fd.set("targetDollars", "750");
  return fd;
}

function makeRefreshThrow(): () => void {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(revalidatePath).mockImplementation(() => {
    throw new Error("revalidatePath blew up");
  });
  return () => logged.mockRestore();
}

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  redirectMock.mockClear();
  insertRunMock.mockReset();
  updateRunMock.mockReset();
  categoryRowMock.current = { id: 4, name: "Vacation", kind: "fund", archivedAt: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGoalAction", () => {
  it("redirects on the ordinary path, carrying no warning", async () => {
    // Pins that the redirect is NOT inside the guard's callback: if it were,
    // `guardRefresh` would catch the throw and this would return a warning
    // instead of navigating.
    await expect(createGoalAction({}, createForm())).rejects.toThrow("NEXT_REDIRECT");
    expect(insertRunMock).toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/goals");
  });

  it("reports a COMMITTED create as saved when the refresh throws", async () => {
    const restore = makeRefreshThrow();

    // Not a throw: `/goals/error.tsx` would claim the fund was not created,
    // and the retry that advice invites collides on the unique name.
    const state = await createGoalAction({}, createForm());
    restore();

    expect(insertRunMock).toHaveBeenCalled();
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
    // The redirect is skipped on purpose. It discards the returned state, so
    // navigating would land the user on a page whose cache we just failed to
    // invalidate, with no message anywhere.
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("does not swallow the refresh failure silently", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    await createGoalAction({}, createForm());

    expect(logged).toHaveBeenCalledWith(
      "[/goals] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });
});

describe("updateGoalTargetAction", () => {
  it("carries no warning when the refresh succeeds", async () => {
    const state = await updateGoalTargetAction({}, targetForm());

    expect(updateRunMock).toHaveBeenCalled();
    expect(state.warning).toBeUndefined();
  });

  it("reports a COMMITTED target change as saved when the refresh throws", async () => {
    const restore = makeRefreshThrow();

    const state = await updateGoalTargetAction({}, targetForm());
    restore();

    expect(updateRunMock).toHaveBeenCalled();
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("still refuses a non-fund category, refresh guard or not", async () => {
    // The guard must not have widened what this action accepts: the refusals
    // happen BEFORE any write, so they still throw.
    categoryRowMock.current = { id: 4, name: "Groceries", kind: "expense", archivedAt: null };

    await expect(updateGoalTargetAction({}, targetForm())).rejects.toThrow();
    expect(updateRunMock).not.toHaveBeenCalled();
  });
});
