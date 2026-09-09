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
// Spreads the REAL module and overrides `redirect` only. `guardRefresh` now
// calls `unstable_rethrow` so a `redirect()` slipping inside a guarded callback
// cannot be swallowed — a hand-written stub for it would be a second spelling of
// Next's own control-flow detection, free to drift from the one production uses.
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, redirect: redirectMock };
});

vi.mock("@/db", async () => ({
  db: dbMock,
  schema: await import("@/db/schema"),
}));

const assertNameAvailableMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/budget/manageCategories", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budget/manageCategories")>()),
  assertNameAvailable: assertNameAvailableMock,
}));

const { revalidatePath } = await import("next/cache");
const { IDLE_GOALS } = await import("./action-state");
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
  // Available by default; the collision case opts in.
  assertNameAvailableMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGoalAction", () => {
  it("redirects on the ordinary path, carrying no warning", async () => {
    // Pins that the redirect is NOT inside the guard's callback: if it were,
    // `guardRefresh` would catch the throw and this would return a warning
    // instead of navigating.
    await expect(createGoalAction(IDLE_GOALS, createForm())).rejects.toThrow("NEXT_REDIRECT");
    expect(insertRunMock).toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/goals");
  });

  it("reports a COMMITTED create as saved when the refresh throws", async () => {
    const restore = makeRefreshThrow();

    // Not a throw: `/goals/error.tsx` would claim the fund was not created,
    // and the retry that advice invites collides on the unique name.
    const state = await createGoalAction(IDLE_GOALS, createForm());
    restore();

    expect(insertRunMock).toHaveBeenCalled();
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
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

    await createGoalAction(IDLE_GOALS, createForm());

    expect(logged).toHaveBeenCalledWith(
      "[/goals] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });
});

describe("updateGoalTargetAction", () => {
  it("carries no warning when the refresh succeeds", async () => {
    const state = await updateGoalTargetAction(IDLE_GOALS, targetForm());

    expect(updateRunMock).toHaveBeenCalled();
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.warning).toBeUndefined();
  });

  it("reports a COMMITTED target change as saved when the refresh throws", async () => {
    const restore = makeRefreshThrow();

    const state = await updateGoalTargetAction(IDLE_GOALS, targetForm());
    restore();

    expect(updateRunMock).toHaveBeenCalled();
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("still refuses a non-fund category, refresh guard or not", async () => {
    // The guard must not have widened what this action accepts: the refusals
    // happen BEFORE any write, so they still throw.
    categoryRowMock.current = { id: 4, name: "Groceries", kind: "expense", archivedAt: null };

    await expect(updateGoalTargetAction(IDLE_GOALS, targetForm())).rejects.toThrow();
    expect(updateRunMock).not.toHaveBeenCalled();
  });
});

/**
 * A duplicate name is ORDINARY USE, not an exceptional condition.
 *
 * Both adversarial reviewers found this independently. It was survivable while
 * `createGoalAction` always redirected on success — but once it began STAYING
 * PUT on a refresh warning (so the user is told the fund exists), the form is
 * still mounted with the same name in it, and the obvious second click threw
 * `CategoryNameTakenError` out of the action and took `/goals` down. The warning
 * that exists to prevent a blind resubmit was creating the crash the resubmit
 * runs into.
 */
describe("createGoalAction — a name collision is returned, not thrown", () => {
  it("returns `error` instead of taking the route out", async () => {
    const { CategoryNameTakenError } = await import("@/lib/categoryErrors");
    assertNameAvailableMock.mockImplementation(() => {
      throw new CategoryNameTakenError("Vacation");
    });

    const fd = new FormData();
    fd.set("name", "Vacation");
    fd.set("targetDollars", "500");
    fd.set("carryoverPolicy", "rollover");

    const state = await createGoalAction(IDLE_GOALS, fd);

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toBeTruthy();
    // The write never ran, so there is nothing to report as saved.
    expect(insertRunMock).not.toHaveBeenCalled();
    // And crucially it did NOT redirect or throw — the two shapes that lose the
    // message.
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

/**
 * Only the DESTINATION's own failure holds the user on the form.
 *
 * `revalidateAfterFundWrite` invalidates `/goals` first, then `/budget`,
 * `/budget/[year]/[month]` and `/budget/categories`. Guarding them as one call
 * meant a failure on any secondary surface suppressed the redirect — stranding
 * the user on the create form over staleness on a page they were not going to.
 * Found by the Codex structured review.
 */
describe("createGoalAction — which refresh failure holds the redirect", () => {
  function goodForm() {
    const fd = new FormData();
    fd.set("name", "Vacation");
    fd.set("targetDollars", "500");
    fd.set("carryoverPolicy", "rollover");
    return fd;
  }

  it("STILL redirects when only a secondary surface fails to refresh", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(revalidatePath).mockImplementation((path: string) => {
      // `/goals` is fine; the budget surfaces are not.
      if (path !== "/goals") throw new Error("revalidatePath blew up");
    });

    await expect(createGoalAction(IDLE_GOALS, goodForm())).rejects.toThrow("NEXT_REDIRECT");

    expect(insertRunMock).toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/goals");
    logged.mockRestore();
  });

  it("holds the user on the form when /goals ITSELF fails to refresh", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(revalidatePath).mockImplementation((path: string) => {
      if (path === "/goals") throw new Error("revalidatePath blew up");
    });

    const state = await createGoalAction(IDLE_GOALS, goodForm());

    // No redirect: the page they would land on may not list the new fund, and
    // a redirect discards the state that would say so.
    expect(redirectMock).not.toHaveBeenCalled();
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
    logged.mockRestore();
  });
});

/**
 * The update-target form reports its successes.
 *
 * It could not, under the old `{ warning?; error? }` shape: the happy path
 * returned `{ warning: undefined }`, structurally identical to `IDLE_GOALS`,
 * so the renderer could not tell a completed write from a form that had never
 * run. The button went "Saving…" → "Save" and nothing else changed, on the one
 * route where every sibling surface announces its writes. Found by the type
 * review; the `status` discriminant is what makes it expressible.
 */
describe("updateGoalTargetAction — success is distinguishable from idle", () => {
  function targetForm() {
    const fd = new FormData();
    fd.set("categoryId", "4");
    fd.set("targetDollars", "750");
    return fd;
  }

  it("returns an `ok` with a message, not an empty object", async () => {
    vi.mocked(revalidatePath).mockImplementation(() => {});

    const state = await updateGoalTargetAction(IDLE_GOALS, targetForm());

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toBeTruthy();
    expect(state.warning).toBeUndefined();
    // The distinction the old shape could not make.
    expect(state).not.toEqual(IDLE_GOALS);
    expect(updateRunMock).toHaveBeenCalled();
  });

  it("still carries the warning when the refresh throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    const state = await updateGoalTargetAction(IDLE_GOALS, targetForm());

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
    logged.mockRestore();
  });
});
