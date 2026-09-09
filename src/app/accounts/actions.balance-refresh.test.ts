import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `revalidateBalanceSurfaces` — the OTHER refresh guard on `/accounts`, and
 * the one that had no test at all.
 *
 * `actions.wiring.test.ts` covers the sibling `revalidateCardActivitySurfaces`
 * thoroughly, and its docblock used to claim it covered this one too. It
 * cannot: every case there drives `addCardActivityAction` /
 * `removeCardActivityAction`, which are that helper's only two callers.
 * Deleting `guardRefresh` from `revalidateBalanceSurfaces` left the whole
 * suite green while `updateLiabilityBalanceAction`,
 * `revertLiabilityBalanceAction`, `updateCardTermsAction` and
 * `refreshLiabilityBalanceAction` went unguarded — four anchor-moving actions
 * pinned by a sentence rather than by an assertion.
 *
 * WHAT IS BEING DEFENDED, and it is rule 9's single undo slot:
 *
 *   UPDATE accounts SET starting_balance_cents = -190000,
 *                       prior_starting_balance_cents = -214832   ← the real prior
 *        │
 *        └── revalidatePath throws ──▶ caught by the action's own outer `catch`
 *              └── {status:"error"} for a write that COMMITTED
 *                    └── the user reconciles again
 *                          └── prior_starting_balance_cents := -190000
 *                                ← the anchor they were one click from restoring
 *                                  is now gone, and there is no second slot.
 *
 * A separate file rather than a case in `actions.wiring.test.ts` because this
 * action's body IS a query: that file mocks `@/db` as `{}` on the deliberate
 * grounds that nothing it drives may reach one, and loosening it would take
 * the loud failure out from under every guard case there. Same split, same
 * reasoning, as `import/actions.createAccount.test.ts`.
 */

const revalidatePathMock = vi.hoisted(() => vi.fn());
const updateRunMock = vi.hoisted(() => vi.fn());
/** Records the column values written, so the prior-anchor claim above is a
 *  fact of this test rather than a story in its docblock. */
const updateSetMock = vi.hoisted(() => vi.fn());

const accountRowMock = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

const dbMock = vi.hoisted(() => ({
  select: () => ({ from: () => ({ where: () => ({ get: () => accountRowMock.current }) }) }),
  update: () => ({
    set: (values: unknown) => {
      updateSetMock(values);
      return { where: () => ({ run: updateRunMock }) };
    },
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

vi.mock("@/db", async () => ({
  db: dbMock,
  schema: await import("@/db/schema"),
}));

const { updateLiabilityBalanceAction, revertLiabilityBalanceAction } = await import("./actions");
const { IDLE } = await import("./action-state");
// Imported, never re-typed: two hand-maintained copies of this sentence had
// already diverged before it was extracted. Zero imports, so it is safe here.
const { REFRESH_FAILED_WARNING } = await import("@/lib/revalidateAfterWrite");

/** A card mid-history: an anchor to move, and no prior anchor yet. */
function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Citi Visa",
    type: "credit",
    startingBalanceCents: -214_832,
    startingBalanceDate: "2026-08-01",
    priorStartingBalanceCents: null,
    priorStartingBalanceDate: null,
    ...overrides,
  };
}

function reconcileForm(fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("accountId", "1");
  fd.set("balanceOwed", "1900.00");
  fd.set("asOf", "2026-09-06");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function throwOnRefresh() {
  revalidatePathMock.mockImplementation(() => {
    throw new Error("revalidatePath blew up");
  });
}

beforeEach(() => {
  revalidatePathMock.mockReset();
  updateRunMock.mockReset();
  updateSetMock.mockReset();
  accountRowMock.current = cardRow();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updateLiabilityBalanceAction — a failed refresh must not deny a committed Reconcile", () => {
  it("reports the COMMITTED reconcile as ok, with a warning, not as an error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const state = await updateLiabilityBalanceAction(IDLE, reconcileForm());

    // The UPDATE landed BEFORE the refresh, which is the entire premise.
    expect(updateRunMock).toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startingBalanceCents: -190_000,
        // The value a second, unnecessary submit would overwrite.
        priorStartingBalanceCents: -214_832,
        priorStartingBalanceDate: "2026-08-01",
      }),
    );

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/Citi Visa is now/);
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
    logged.mockRestore();
  });

  it("records the failure, since the warning is aimed at someone who cannot act on it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    await updateLiabilityBalanceAction(IDLE, reconcileForm());

    // The scope tag matters: it is how a `/accounts` refresh failure is told
    // apart from `/import`'s in a log with no other context.
    expect(logged).toHaveBeenCalledWith(
      "[/accounts] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("leaves `warning` undefined when the refresh works, so success stays plain", async () => {
    revalidatePathMock.mockImplementation(() => {});

    const state = await updateLiabilityBalanceAction(IDLE, reconcileForm());

    expect(state).toMatchObject({ status: "ok" });
    if (state.status !== "ok") throw new Error("unreachable");
    // An always-present warning would paint every ordinary reconcile as
    // degraded, and the row renders it with `role="alert"`.
    expect(state.warning).toBeUndefined();
    expect(revalidatePathMock).toHaveBeenCalledWith("/accounts");
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget");
  });

  it("still REFUSES a genuine refusal — the guard must not turn errors into warnings", async () => {
    // The other direction. `/accounts`' balance guards are money guards; a
    // helper that reported every outcome as ok would hide the $0-reconcile
    // refusal, which is the corruption `actions.wiring.test.ts` opens on.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const state = await updateLiabilityBalanceAction(
      IDLE,
      reconcileForm({ balanceOwed: "" }),
    );

    expect(state).toMatchObject({ status: "error", field: "balance" });
    expect(updateRunMock).not.toHaveBeenCalled();
    // Refused before the refresh, so nothing was written to be stale about and
    // no log line was produced. Asserted BEFORE `mockRestore`, which performs a
    // `mockReset` first and would wipe `mock.calls` out from under this.
    expect(logged).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("does not manufacture a warning for a save that changed nothing", async () => {
    // The no-op branch returns before the refresh on purpose — rule 9's undo
    // slot must not be spent on a double-submit. It therefore also has no
    // stale page to warn about.
    throwOnRefresh();

    const state = await updateLiabilityBalanceAction(
      IDLE,
      reconcileForm({ balanceOwed: "2148.32", asOf: "2026-08-01" }),
    );

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/unchanged/);
    expect(state.warning).toBeUndefined();
    expect(updateRunMock).not.toHaveBeenCalled();
  });
});

/**
 * The SECOND caller of the same helper, and the one where an `{status:"error"}`
 * on a committed write is most misleading: the undo has already fired, so the
 * row the user is looking at is the restored one and the message says it
 * failed.
 */
describe("revertLiabilityBalanceAction — same guard, same committed-write promise", () => {
  it("reports the COMMITTED revert as ok, with a warning", async () => {
    accountRowMock.current = cardRow({
      priorStartingBalanceCents: -214_832,
      priorStartingBalanceDate: "2026-08-01",
      startingBalanceCents: -190_000,
      startingBalanceDate: "2026-09-06",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const fd = new FormData();
    fd.set("accountId", "1");
    const state = await revertLiabilityBalanceAction(IDLE, fd);

    expect(updateRunMock).toHaveBeenCalled();
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/back to where it was on 2026-08-01/);
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
    logged.mockRestore();
  });

  it("still names the missing prior anchor rather than warning about a refresh", async () => {
    // Reachable from a stale tab, and it writes nothing — so it must reach the
    // user as the refusal it is.
    throwOnRefresh();

    const fd = new FormData();
    fd.set("accountId", "1");
    const state = await revertLiabilityBalanceAction(IDLE, fd);

    expect(state.status).toBe("error");
    expect(updateRunMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
