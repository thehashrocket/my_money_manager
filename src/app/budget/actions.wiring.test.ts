import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `budget/actions.test.ts` exercises the DB-bound pipelines
 * (`upsertAllocation`, `validateAllocateInput`) directly against a
 * `:memory:` DB, mirroring what each Server Action runs — it can't call the
 * actions themselves because they close over the real `@/db` singleton and
 * call `revalidatePath`/`redirect`, same limitation documented in
 * `goals/actions.test.ts`.
 *
 * This file covers the gap that leaves: the glue INSIDE each action wrapper
 * — `upsertBudgetAllocationAction`'s parse-then-fallback-to-zod branch,
 * `setCategoryKindAction`'s zod validation, error-message formatting, and
 * narrowed catch (refusal/not-found downgrade to state, anything else
 * rethrows to `error.tsx`), and `copyPreviousMonthAction`'s bounds — by
 * mocking `next/cache`/`next/navigation` (no live request context in a
 * Vitest run, same fix `sync/actions.test.ts` uses) and the underlying
 * pipeline functions (their own behavior is covered by their dedicated test
 * files: `upsertAllocation.ts`, `setCategoryKind.test.ts`, `copyMonth.test.ts`).
 */

const upsertAllocationMock = vi.hoisted(() => vi.fn());
const setCategoryKindMock = vi.hoisted(() => vi.fn());
const copyPreviousMonthMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());
const createCategoryMock = vi.hoisted(() => vi.fn());
const renameCategoryMock = vi.hoisted(() => vi.fn());
const moveCategoryMock = vi.hoisted(() => vi.fn());
const archiveCategoryMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/db", () => ({
  db: {},
}));

vi.mock("@/lib/budget/upsertAllocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/budget/upsertAllocation")>();
  return { ...actual, upsertAllocation: upsertAllocationMock };
});

vi.mock("@/lib/budget/setCategoryKind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/budget/setCategoryKind")>();
  return { ...actual, setCategoryKind: setCategoryKindMock };
});

vi.mock("@/lib/budget/copyMonth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/budget/copyMonth")>();
  return { ...actual, copyPreviousMonth: copyPreviousMonthMock };
});

// Spread the real modules rather than hand-listing, for the reason
// `sync/actions.test.ts` records: a hand-listed factory silently omits whatever
// is added next, and the first test written for it then fails with "No export
// is defined on the mock" — which reads as a broken test, not a missing one.
vi.mock("@/lib/budget/manageCategories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/budget/manageCategories")>();
  return {
    ...actual,
    createCategory: createCategoryMock,
    renameCategory: renameCategoryMock,
    moveCategory: moveCategoryMock,
  };
});

vi.mock("@/lib/budget/archiveCategory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/budget/archiveCategory")>();
  return { ...actual, archiveCategory: archiveCategoryMock };
});

const {
  upsertBudgetAllocationAction,
  setCategoryKindAction,
  copyPreviousMonthAction,
  revalidateBudgetSurfacesAction,
  createCategoryAction,
  renameCategoryAction,
  archiveCategoryAction,
  moveCategoryAction,
} = await import("./actions");
const { REFRESH_FAILED_WARNING } = await import("@/lib/revalidateAfterWrite");
const { CategoryKindChangeRefusedError, ProtectedCategoryKindError } = await import(
  "@/lib/budget/setCategoryKind"
);
const { CategoryNotFoundError } = await import("@/lib/categoryErrors");

beforeEach(() => {
  upsertAllocationMock.mockReset();
  setCategoryKindMock.mockReset();
  copyPreviousMonthMock.mockReset();
  redirectMock.mockReset();
  createCategoryMock.mockReset();
  renameCategoryMock.mockReset();
  moveCategoryMock.mockReset();
  archiveCategoryMock.mockReset();
  // mockRESET, not mockClear: the refresh-failure block below installs a
  // THROWING implementation, and `mockClear` only wipes call history — leaving
  // it in place would make every later test in this file fail for a reason that
  // has nothing to do with what it is testing. Same note `sync/actions.test.ts`
  // carries on its own mock.
  revalidatePathMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("upsertBudgetAllocationAction — dollars-to-cents fallback", () => {
  it("converts allocatedDollars to allocatedCents and upserts", async () => {
    await upsertBudgetAllocationAction(
      formData({ categoryId: "7", year: "2026", month: "4", allocatedDollars: "40.00" }),
    );

    expect(upsertAllocationMock).toHaveBeenCalledWith(
      {},
      { categoryId: 7, year: 2026, month: 4, allocatedCents: 4000 },
    );
    expect(redirectMock).toHaveBeenCalledWith("/budget/2026/4");
  });

  it("leaves allocatedCents unset for a malformed dollar string, and validation reports it as missing", async () => {
    await expect(
      upsertBudgetAllocationAction(
        formData({ categoryId: "7", year: "2026", month: "4", allocatedDollars: "not-a-number" }),
      ),
    ).rejects.toThrow(/allocatedCents/);

    expect(upsertAllocationMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("revalidates both the list and the pattern-form month path, not the literal path", async () => {
    await upsertBudgetAllocationAction(
      formData({ categoryId: "7", year: "2026", month: "4", allocatedDollars: "10.00" }),
    );

    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget/[year]/[month]", "page");
  });
});

describe("setCategoryKindAction — validation and error narrowing", () => {
  it("returns a formatted error state for an invalid categoryId, without calling setCategoryKind", async () => {
    const state = await setCategoryKindAction(
      { status: "idle" },
      formData({ categoryId: "not-a-number", kind: "income" }),
    );

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/Invalid reclassify request/);
    expect(setCategoryKindMock).not.toHaveBeenCalled();
  });

  it("returns ok and revalidates on success", async () => {
    setCategoryKindMock.mockReturnValue({ categoryId: 3, previousKind: "expense", newKind: "income" });

    const state = await setCategoryKindAction({ status: "idle" }, formData({ categoryId: "3", kind: "income" }));

    expect(state).toEqual({ status: "ok", categoryId: 3 });
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget/[year]/[month]", "page");
  });

  it("downgrades CategoryKindChangeRefusedError to error state, inline", async () => {
    setCategoryKindMock.mockImplementation(() => {
      throw new CategoryKindChangeRefusedError(3, "Groceries", 2, "2026-01-01", "2026-02-01");
    });

    const state = await setCategoryKindAction({ status: "idle" }, formData({ categoryId: "3", kind: "income" }));

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/Groceries/);
  });

  it("downgrades CategoryNotFoundError to error state, inline", async () => {
    setCategoryKindMock.mockImplementation(() => {
      throw new CategoryNotFoundError(999);
    });

    const state = await setCategoryKindAction({ status: "idle" }, formData({ categoryId: "999", kind: "income" }));

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/999/);
  });

  it("downgrades ProtectedCategoryKindError to error state, inline", async () => {
    setCategoryKindMock.mockImplementation(() => {
      throw new ProtectedCategoryKindError(1);
    });

    const state = await setCategoryKindAction({ status: "idle" }, formData({ categoryId: "1", kind: "income" }));

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/Uncategorized/);
  });

  it("rethrows anything else — the actual error.tsx backstop, not downgraded to state", async () => {
    setCategoryKindMock.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    await expect(
      setCategoryKindAction({ status: "idle" }, formData({ categoryId: "3", kind: "income" })),
    ).rejects.toThrow("SQLITE_BUSY");
  });
});

describe("copyPreviousMonthAction — bounds", () => {
  it("rejects a month outside 1-12 with a formatted error, without calling copyPreviousMonth", async () => {
    await expect(copyPreviousMonthAction(2026, 13)).rejects.toThrow(/Invalid copy-month request/);
    expect(copyPreviousMonthMock).not.toHaveBeenCalled();
  });

  it("rejects a year below 2000 with a formatted error", async () => {
    await expect(copyPreviousMonthAction(1999, 6)).rejects.toThrow(/Invalid copy-month request/);
    expect(copyPreviousMonthMock).not.toHaveBeenCalled();
  });

  it("calls copyPreviousMonth and revalidates on a valid request", async () => {
    copyPreviousMonthMock.mockReturnValue({ copied: 5, skipped: 1, skippedArchived: 0 });

    const result = await copyPreviousMonthAction(2026, 4);

    expect(copyPreviousMonthMock).toHaveBeenCalledWith({}, 2026, 4);
    expect(result).toEqual({ copied: 5, skipped: 1, skippedArchived: 0 });
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget/[year]/[month]", "page");
  });
});

/**
 * A COMMITTED write whose refresh then fails is still a committed write.
 *
 * v0.26.0 gave `setCategoryKindAction` this treatment and left the other ten
 * actions in the file unguarded — so `revalidatePath` throwing after
 * `copyPreviousMonth`/`createCategory`/`archiveCategory` had already written
 * escaped into `budget/[year]/[month]/error.tsx`, whose copy affirmatively
 * tells the reader nothing was written. These tests install a THROWING
 * `revalidatePath`; without `guardRefresh` every one of them fails with the
 * throw itself rather than an assertion.
 *
 * `console.error` is spied and silenced in each: the log line is the developer
 * half of the guard (asserted in its own test at the end), and letting it
 * through would make a passing run look like a failing one.
 */
describe("post-commit refresh failures come back as warnings, never as failures", () => {
  function throwOnRevalidate() {
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });
    return vi.spyOn(console, "error").mockImplementation(() => {});
  }

  it("still redirects after upsertBudgetAllocationAction, rather than crashing the route", async () => {
    const logged = throwOnRevalidate();

    // Not `.rejects`: an unguarded throw here reaches `error.tsx`, which says
    // "nothing was written" about an `upsertAllocation` that has committed.
    await upsertBudgetAllocationAction(
      formData({ categoryId: "7", year: "2026", month: "4", allocatedDollars: "40.00" }),
    );
    logged.mockRestore();

    expect(upsertAllocationMock).toHaveBeenCalled();
    // The one channel this action HAS. `redirect` signals by throwing, so this
    // also pins it OUTSIDE `guardRefresh`'s callback — inside, the navigation
    // would have been swallowed into a warning string and this would be 0 calls.
    expect(redirectMock).toHaveBeenCalledWith("/budget/2026/4");
  });

  it("returns the real copy counts plus a warning from copyPreviousMonthAction", async () => {
    copyPreviousMonthMock.mockReturnValue({ copied: 5, skipped: 1, skippedArchived: 0 });
    const logged = throwOnRevalidate();

    const result = await copyPreviousMonthAction(2026, 4);
    logged.mockRestore();

    // The counts are FACTS about rows that exist; `_copy-month.tsx` renders
    // them either way and must not report "Copy failed."
    expect(result).toEqual({ copied: 5, skipped: 1, skippedArchived: 0, warning: REFRESH_FAILED_WARNING });
  });

  it("returns the warning from revalidateBudgetSurfacesAction instead of rejecting", async () => {
    const logged = throwOnRevalidate();

    // `<MonthEditor>` fires this as `void ...`; an unguarded rejection here is
    // an unhandled promise rejection with the user told nothing at all.
    const warning = await revalidateBudgetSurfacesAction();
    logged.mockRestore();

    expect(warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("returns ok plus a warning from createCategoryAction — the category exists", async () => {
    createCategoryMock.mockReturnValue({ id: 12, name: "Groceries" });
    const logged = throwOnRevalidate();

    const result = await createCategoryAction({ name: "Groceries", kind: "expense", parentId: null });
    logged.mockRestore();

    expect(result).toEqual({
      status: "ok",
      category: { id: 12, name: "Groceries" },
      warning: REFRESH_FAILED_WARNING,
    });
  });

  it("returns ok plus a warning from renameCategoryAction", async () => {
    renameCategoryMock.mockReturnValue({ id: 4, name: "Rent" });
    const logged = throwOnRevalidate();

    const result = await renameCategoryAction(4, "Rent");
    logged.mockRestore();

    expect(result).toEqual({ status: "ok", categoryId: 4, name: "Rent", warning: REFRESH_FAILED_WARNING });
  });

  it("returns ok plus a warning from archiveCategoryAction", async () => {
    archiveCategoryMock.mockReturnValue({ categoryId: 9, categoryName: "Old" });
    const logged = throwOnRevalidate();

    const result = await archiveCategoryAction(9);
    logged.mockRestore();

    expect(result).toEqual({
      status: "ok",
      categoryId: 9,
      categoryName: "Old",
      warning: REFRESH_FAILED_WARNING,
    });
  });

  it("returns ok plus a warning from moveCategoryAction — its own inline revalidation, guarded too", async () => {
    moveCategoryMock.mockReturnValue({ newPosition: 2, siblingCount: 5 });
    const logged = throwOnRevalidate();

    const result = await moveCategoryAction(4, "up");
    logged.mockRestore();

    expect(result).toEqual({
      status: "ok",
      result: { newPosition: 2, siblingCount: 5 },
      warning: REFRESH_FAILED_WARNING,
    });
  });

  it("does not swallow the refresh failure silently", async () => {
    // The developer-facing half. `upsertBudgetAllocationAction` is the one
    // action with no state channel at all, so this log line is its ONLY record
    // that anything went wrong — which is why it is the case asserted here.
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await upsertBudgetAllocationAction(
      formData({ categoryId: "7", year: "2026", month: "4", allocatedDollars: "40.00" }),
    );

    expect(logged).toHaveBeenCalledWith(
      "[/budget] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });
});
