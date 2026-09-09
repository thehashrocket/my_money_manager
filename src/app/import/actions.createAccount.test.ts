import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `createAccountAction` is the ONE `/import` action with a state channel, and
 * therefore the only one on this route that can actually TELL the user a
 * post-commit refresh failed. Its siblings are `Promise<void>` + `redirect`
 * and settle for `guardRefresh`'s `console.error`.
 *
 * That makes it the case worth pinning here rather than in
 * `actions.wiring.test.ts`, which mocks `@/db` as `{}` on the deliberate
 * grounds that nothing it drives may reach a query — this action's whole body
 * is a query, so it gets its own file and its own db mock instead of loosening
 * that one.
 *
 * WHAT IS BEING DEFENDED: the account row is already inserted when
 * `revalidatePath` runs. Reporting `{status:"error"}` there sends the user
 * round the form again, and the second submit creates a SECOND account with
 * the same name — this app has no unique index on `accounts.name` and no
 * account-delete surface anywhere, so the duplicate is permanent and both
 * copies then split the ledger's balances between them.
 */

const revalidatePathMock = vi.hoisted(() => vi.fn());
const insertRunMock = vi.hoisted(() => vi.fn());

const dbMock = vi.hoisted(() => ({
  insert: () => ({ values: () => ({ run: insertRunMock }) }),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
// Spreads the REAL module and overrides `redirect` only. `guardRefresh` now
// calls `unstable_rethrow` so a `redirect()` slipping inside a guarded callback
// cannot be swallowed — a hand-written stub for it would be a second spelling of
// Next's own control-flow detection, free to drift from the one production uses.
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, redirect: vi.fn() };
});

vi.mock("@/db", async () => ({
  db: dbMock,
  schema: await import("@/db/schema"),
}));

const { createAccountAction } = await import("./actions");
const { IDLE_CREATE_ACCOUNT } = await import("./action-state");
const { REFRESH_FAILED_WARNING } = await import("@/lib/revalidateAfterWrite");

beforeEach(() => {
  revalidatePathMock.mockReset();
  insertRunMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

function accountForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("name", "Star One Checking");
  fd.set("type", "checking");
  fd.set("startingBalance", "1250.75");
  fd.set("startingBalanceDate", "2026-01-01");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

describe("createAccountAction", () => {
  it("reports a COMMITTED insert as ok, with a warning, when the refresh throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    const state = await createAccountAction(IDLE_CREATE_ACCOUNT, accountForm());
    logged.mockRestore();

    // The row exists. `error` here is what produces the duplicate account.
    expect(insertRunMock).toHaveBeenCalled();
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toBe("Star One Checking added.");
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("leaves `warning` undefined when the refresh works, so success stays plain", async () => {
    revalidatePathMock.mockImplementation(() => {});

    const state = await createAccountAction(IDLE_CREATE_ACCOUNT, accountForm());

    expect(state).toMatchObject({ status: "ok" });
    if (state.status !== "ok") throw new Error("unreachable");
    // An always-present warning would paint every ordinary save as degraded,
    // and `_create-account-form.tsx` renders it with `role="alert"`.
    expect(state.warning).toBeUndefined();
    expect(revalidatePathMock).toHaveBeenCalledWith("/import");
  });

  it("still returns a FIELD-tagged refusal, and never inserts, on bad input", async () => {
    // The other direction: the guard must not have widened what this accepts.
    // A liability typed with a minus sign is rule 9's corruption path, and the
    // refusal has to reach the right input or the form highlights a field the
    // user got right.
    const state = await createAccountAction(
      IDLE_CREATE_ACCOUNT,
      accountForm({ type: "credit", startingBalance: "-2000" }),
    );

    expect(state).toMatchObject({ status: "error", field: "startingBalance" });
    expect(insertRunMock).not.toHaveBeenCalled();
    // Refused before any refresh — nothing was written to be stale about.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
