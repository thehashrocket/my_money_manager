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

const { upsertBudgetAllocationAction, setCategoryKindAction, copyPreviousMonthAction } = await import(
  "./actions"
);
const { CategoryKindChangeRefusedError } = await import("@/lib/budget/setCategoryKind");
const { CategoryNotFoundError } = await import("@/lib/categoryErrors");

beforeEach(() => {
  upsertAllocationMock.mockReset();
  setCategoryKindMock.mockReset();
  copyPreviousMonthMock.mockReset();
  redirectMock.mockReset();
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
