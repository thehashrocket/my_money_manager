import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `revalidateBalanceSurfaces` — the OTHER refresh guard on `/accounts`, and
 * the one that had no test at all.
 *
 * `actions.wiring.test.ts` covers the sibling `revalidateCardActivitySurfaces`
 * thoroughly, and its docblock used to claim it covered this one too. It
 * cannot: every case there drives `addCardActivityAction` /
 * `removeCardActivityAction`, two of that helper's four callers (the two
 * card-payment actions are driven by no test in the repo).
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
/** `refreshLiabilityBalanceAction`'s two collaborators beyond the account
 *  row select above. `hasAnyTransactionRows` runs its own EXISTS query this
 *  file's generic `dbMock.select` chain does not shape-match (`.limit(1)`,
 *  a different table) — mocking it directly, rather than widening the db
 *  mock, keeps `updateLiabilityBalanceAction`/`revertLiabilityBalanceAction`
 *  above untouched. `refreshLiabilityBalancesOnly` is the whole feed round
 *  trip; nothing about this wrapper's own branching needs it to be real. */
const hasAnyTransactionRowsMock = vi.hoisted(() => vi.fn());
const refreshLiabilityBalancesOnlyMock = vi.hoisted(() => vi.fn());

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

vi.mock("@/lib/accounts/hasAnyTransactionRows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounts/hasAnyTransactionRows")>();
  return { ...actual, hasAnyTransactionRows: hasAnyTransactionRowsMock };
});

vi.mock("@/lib/simplefin/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/simplefin/sync")>();
  return { ...actual, refreshLiabilityBalancesOnly: refreshLiabilityBalancesOnlyMock };
});

const {
  updateLiabilityBalanceAction,
  revertLiabilityBalanceAction,
  refreshLiabilityBalanceAction,
} = await import("./actions");
const { IDLE } = await import("./action-state");
// Imported, never re-typed: two hand-maintained copies of this sentence had
// already diverged before it was extracted. The zero-import module is
// `@/lib/refreshWarning`; this one re-exports it and pulls `next/navigation`
// for `unstable_rethrow`, which is left real here.
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
  hasAnyTransactionRowsMock.mockReset();
  refreshLiabilityBalancesOnlyMock.mockReset();
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

/**
 * `refreshLiabilityBalanceAction` — the third named caller of
 * `revalidateBalanceSurfaces`, and the one this file's own docblock lists
 * without ever driving: `refreshLiabilityBalancesOnly` is the whole feed
 * round trip, and this describe block mocks it away entirely, leaving only
 * this wrapper's own branching under test.
 *
 * As of v1.1.0/D9.2, `importsTransactions` is true for any LINKED
 * checking/savings/credit account, so `resolveBalanceAction` answers
 * "reconcile" for a linked card unconditionally — "refresh" is reachable
 * ONLY for a linked, zero-row LOAN today. `loanRow` below is that shape;
 * `cardRow` (above) is reused for the "this is not eligible" refusal.
 */
describe("refreshLiabilityBalanceAction", () => {
  function loanRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 3,
      name: "Fixed Rate 1st Mortgage",
      type: "loan",
      simplefinAccountId: "ACT-mortgage",
      startingBalanceCents: -408_900_00,
      startingBalanceDate: "2026-08-27",
      priorStartingBalanceCents: null,
      priorStartingBalanceDate: null,
      ...overrides,
    };
  }

  function refreshForm(accountId = "3"): FormData {
    const fd = new FormData();
    fd.set("accountId", accountId);
    return fd;
  }

  it("REFUSES a non-integer accountId before touching the db", async () => {
    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm("abc"));

    expect(state).toMatchObject({ status: "error" });
    expect(hasAnyTransactionRowsMock).not.toHaveBeenCalled();
    expect(refreshLiabilityBalancesOnlyMock).not.toHaveBeenCalled();
  });

  /**
   * Ship's pre-landing review (cycle 2) found this action had weaker
   * coercion coverage than its `readPositiveIntField` siblings
   * (`markAsCardPaymentAction`, `linkCardPaymentAction` in
   * `actions.wiring.test.ts`) for the exact defect class cycle 1's fix
   * addressed — this action used to parse `accountId` with a bare `Number()`
   * and was switched to the shared helper, but only the "abc" case above was
   * ever pinned for it. Mirrors that file's own case table rather than
   * inventing a new one.
   */
  it.each([
    ["zero", "0"],
    ["a negative integer", "-1"],
    ["hex notation", "0x10"],
    ["exponential notation", "1e3"],
    ["a decimal", "3.5"],
    ["whitespace only", "   "],
    ["a plus-signed integer", "+7"],
  ])("REFUSES accountId=%s, matching readPositiveIntField's contract", async (_label, raw) => {
    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm(raw));

    expect(state).toMatchObject({ status: "error" });
    expect(hasAnyTransactionRowsMock).not.toHaveBeenCalled();
    expect(refreshLiabilityBalancesOnlyMock).not.toHaveBeenCalled();
  });

  it("REFUSES an absent accountId field", async () => {
    const state = await refreshLiabilityBalanceAction(IDLE, new FormData());

    expect(state).toMatchObject({ status: "error" });
    expect(refreshLiabilityBalancesOnlyMock).not.toHaveBeenCalled();
  });

  it("REFUSES when the account no longer exists", async () => {
    accountRowMock.current = null;

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state).toMatchObject({ status: "error", message: "That account no longer exists." });
    expect(refreshLiabilityBalancesOnlyMock).not.toHaveBeenCalled();
  });

  it("REFUSES a non-liability account server-side, not merely by what the row rendered", async () => {
    accountRowMock.current = { ...loanRow(), type: "checking", simplefinAccountId: "ACT-1" };

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state).toMatchObject({ status: "error" });
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/not a credit card or loan/);
    expect(refreshLiabilityBalancesOnlyMock).not.toHaveBeenCalled();
  });

  it("REFUSES a linked card — importsTransactions makes it reconcile-only, never refresh", async () => {
    // A stale tab: the row rendered Refresh, then the card started importing
    // its own transactions (or always did, post v1.1.0).
    accountRowMock.current = { ...cardRow(), simplefinAccountId: "ACT-citi" };

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state).toMatchObject({ status: "error" });
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/has activity of its own now, so update it with Reconcile/);
    expect(refreshLiabilityBalancesOnlyMock).not.toHaveBeenCalled();
  });

  it("REFUSES a loan that already has rows — hasAnyTransactionRows, not the anchor-scoped count", async () => {
    accountRowMock.current = loanRow();
    hasAnyTransactionRowsMock.mockReturnValue(true);

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state).toMatchObject({ status: "error" });
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/has activity of its own now/);
  });

  it("reports 'no accounts linked' rather than a generic failure", async () => {
    accountRowMock.current = loanRow();
    hasAnyTransactionRowsMock.mockReturnValue(false);
    refreshLiabilityBalancesOnlyMock.mockResolvedValue({ status: "no-linked-accounts" });

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state).toMatchObject({
      status: "error",
      message: "No accounts are linked to SimpleFIN yet.",
    });
  });

  it("reports a real update, folding the refresh warning onto the successful write", async () => {
    accountRowMock.current = loanRow();
    hasAnyTransactionRowsMock.mockReturnValue(false);
    refreshLiabilityBalancesOnlyMock.mockResolvedValue({
      status: "ok",
      updates: [
        {
          accountId: 3,
          name: "Fixed Rate 1st Mortgage",
          balanceCents: -400_000,
          asOfIso: "2026-09-15",
          priorBalanceCents: -408_900_00,
          priorAsOfIso: "2026-08-27",
        },
      ],
      warnings: [],
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());
    logged.mockRestore();

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/\$4,000\.00/);
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("carries the outcome's OWN warnings (e.g. a positive-card-balance note) alongside a real update", async () => {
    // Two distinct warning channels on the same successful write:
    // `outcome.warnings` is folded into the MESSAGE, `revalidateBalanceSurfaces`'s
    // is the separate `warning` field. Neither may clobber the other.
    accountRowMock.current = loanRow();
    hasAnyTransactionRowsMock.mockReturnValue(false);
    refreshLiabilityBalancesOnlyMock.mockResolvedValue({
      status: "ok",
      updates: [
        {
          accountId: 3,
          name: "Fixed Rate 1st Mortgage",
          balanceCents: -400_000,
          asOfIso: "2026-09-15",
          priorBalanceCents: -408_900_00,
          priorAsOfIso: "2026-08-27",
        },
      ],
      warnings: ["Its balance is unusually stale."],
    });
    revalidatePathMock.mockImplementation(() => {});

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/\$4,000\.00/);
    expect(state.message).toMatch(/Its balance is unusually stale\./);
    // The refresh itself worked, so the SEPARATE field stays undefined even
    // though the message above carries a warning sentence of its own.
    expect(state.warning).toBeUndefined();
  });

  it("REFUSES when there is no update AND the run reported warnings — not a clean no-op", async () => {
    accountRowMock.current = loanRow();
    hasAnyTransactionRowsMock.mockReturnValue(false);
    refreshLiabilityBalancesOnlyMock.mockResolvedValue({
      status: "ok",
      updates: [],
      warnings: ["The connection to your bank needs to be re-authorized."],
    });

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state).toMatchObject({
      status: "error",
      message: "The connection to your bank needs to be re-authorized.",
    });
  });

  it("reports a genuine no-op as unchanged, still folding in a refresh-failure warning", async () => {
    accountRowMock.current = loanRow();
    hasAnyTransactionRowsMock.mockReturnValue(false);
    refreshLiabilityBalancesOnlyMock.mockResolvedValue({
      status: "ok",
      updates: [],
      warnings: [],
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());
    logged.mockRestore();

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/unchanged — the bank reports the same balance/);
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("catches a throw from the feed round trip and reports it rather than crashing the route", async () => {
    accountRowMock.current = loanRow();
    hasAnyTransactionRowsMock.mockReturnValue(false);
    refreshLiabilityBalancesOnlyMock.mockRejectedValue(new Error("SimpleFIN request timed out"));

    const state = await refreshLiabilityBalanceAction(IDLE, refreshForm());

    expect(state).toMatchObject({ status: "error", message: "SimpleFIN request timed out" });
  });
});
