import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `accounts/actions.test.ts` mirrors each action's DB-bound pipeline against a
 * `:memory:` database. That leaves a gap, and the gap turned out to matter:
 * NOTHING imported `accounts/actions.ts` itself, so the guards that live only
 * in the action wrapper — before any query runs — had zero coverage. Two of
 * them are money guards whose own comments describe the damage they prevent:
 *
 *   - `updateLiabilityBalanceAction`'s empty-balance check. `Number("")` and
 *     `Number(null)` are both 0, which is finite and >= 0, so without it a
 *     request omitting the field silently reconciles the card to $0 owed.
 *   - `addCardActivityAction`'s upper bound. Its comment records that
 *     `amount=1e12` produced a 1e14-cent row that "permanently skewed the card
 *     balance, net worth and its envelope's spend".
 *
 * Both are reachable because a Server Action is a network endpoint regardless
 * of what the form rendered — `required` and `min` are client-side only.
 *
 * Same shape as `budget/actions.wiring.test.ts`: mock `next/cache` (no live
 * request context in a Vitest run) and `@/db`, then assert the guard both
 * returns the right state AND never reaches the write. Every case here rejects
 * before the first query, which is why `db: {}` is sufficient — a case that
 * needed a real row would belong in `actions.test.ts` instead.
 */

const createCardActivityMock = vi.hoisted(() => vi.fn());
const removeCardActivityMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  // `{}` on purpose: every case below must refuse before touching it, so a
  // query reaching the database would throw and fail the test loudly rather
  // than quietly proving nothing.
  return { ...actual, db: {} };
});

vi.mock("@/lib/accounts/manualTransaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounts/manualTransaction")>();
  return {
    ...actual,
    createCardActivity: createCardActivityMock,
    removeCardActivity: removeCardActivityMock,
  };
});

const { updateLiabilityBalanceAction, addCardActivityAction, removeCardActivityAction } =
  await import("./actions");
const { IDLE, IDLE_ACTIVITY } = await import("./action-state");
const { STARTING_BALANCE_DOLLARS_MAX } = await import("@/lib/import/accountAnchorFields");
// Imported, never re-typed. Two hand-maintained copies of this sentence
// already existed in this app and had already diverged in wording, which is
// the whole reason the shared module exists. It has zero imports, so it is
// safe in any mock graph.
const { REFRESH_FAILED_WARNING } = await import("@/lib/revalidateAfterWrite");

beforeEach(() => {
  createCardActivityMock.mockReset();
  removeCardActivityMock.mockReset();
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

describe("updateLiabilityBalanceAction — guards that run before any query", () => {
  it("REFUSES an omitted balance rather than reconciling the card to $0", async () => {
    // The silent-corruption case. `Number(undefined)` is NaN, but an empty
    // string posts as "" and `Number("")` is 0 — finite and >= 0 — so the
    // numeric guard alone would accept it and store a $0 balance owed.
    const state = await updateLiabilityBalanceAction(
      IDLE,
      formData({ accountId: "1", asOf: "2026-09-06" }),
    );
    expect(state.status).toBe("error");
    expect(state).toMatchObject({ field: "balance" });
  });

  it("refuses an empty-string balance", async () => {
    const state = await updateLiabilityBalanceAction(
      IDLE,
      formData({ accountId: "1", balanceOwed: "", asOf: "2026-09-06" }),
    );
    expect(state.status).toBe("error");
    expect(state).toMatchObject({ field: "balance" });
  });

  it("refuses a whitespace-only balance", async () => {
    // `Number(" ")` is also 0, so trimming has to happen before the numeric
    // check or whitespace slips into the same $0 trap.
    const state = await updateLiabilityBalanceAction(
      IDLE,
      formData({ accountId: "1", balanceOwed: "   ", asOf: "2026-09-06" }),
    );
    expect(state.status).toBe("error");
    expect(state).toMatchObject({ field: "balance" });
  });

  it("refuses a negative balance owed — the user never types a minus sign", async () => {
    const state = await updateLiabilityBalanceAction(
      IDLE,
      formData({ accountId: "1", balanceOwed: "-500", asOf: "2026-09-06" }),
    );
    expect(state.status).toBe("error");
    expect(state).toMatchObject({ field: "balance" });
  });

  it("refuses a non-numeric balance", async () => {
    const state = await updateLiabilityBalanceAction(
      IDLE,
      formData({ accountId: "1", balanceOwed: "banana", asOf: "2026-09-06" }),
    );
    expect(state.status).toBe("error");
  });

  it("marks the DATE field, not the balance, when the anchor date is rejected", async () => {
    // The field discriminator drives `aria-invalid`. Pointing it at the wrong
    // input is how a form highlights something the user got right.
    const state = await updateLiabilityBalanceAction(
      IDLE,
      formData({ accountId: "1", balanceOwed: "2148.32", asOf: "2999-01-01" }),
    );
    expect(state.status).toBe("error");
    expect(state).toMatchObject({ field: "date" });
  });

  it("refuses a calendar-invalid anchor date", async () => {
    const state = await updateLiabilityBalanceAction(
      IDLE,
      formData({ accountId: "1", balanceOwed: "2148.32", asOf: "2026-13-40" }),
    );
    expect(state.status).toBe("error");
    expect(state).toMatchObject({ field: "date" });
  });
});

describe("addCardActivityAction — guards that run before the write", () => {
  it("REFUSES an amount above the shared ceiling, and never calls the writer", async () => {
    // 1e12 dollars is the figure the action's own comment records as having
    // produced a 1e14-cent row.
    const state = await addCardActivityAction(
      IDLE_ACTIVITY,
      formData({
        accountId: "1",
        categoryId: "2",
        amount: "1e12",
        date: "2026-09-06",
        merchant: "Costco",
      }),
    );
    expect(state.status).toBe("error");
    expect(createCardActivityMock).not.toHaveBeenCalled();
  });

  it("accepts nothing above STARTING_BALANCE_DOLLARS_MAX", async () => {
    const state = await addCardActivityAction(
      IDLE_ACTIVITY,
      formData({
        accountId: "1",
        categoryId: "2",
        amount: String(STARTING_BALANCE_DOLLARS_MAX + 1),
        date: "2026-09-06",
        merchant: "Costco",
      }),
    );
    expect(state.status).toBe("error");
    expect(createCardActivityMock).not.toHaveBeenCalled();
  });

  it("refuses a zero or negative amount", async () => {
    for (const amount of ["0", "-80"]) {
      const state = await addCardActivityAction(
        IDLE_ACTIVITY,
        formData({
          accountId: "1",
          categoryId: "2",
          amount,
          date: "2026-09-06",
          merchant: "Costco",
        }),
      );
      expect(state.status).toBe("error");
    }
    expect(createCardActivityMock).not.toHaveBeenCalled();
  });

  it("refuses a future-dated charge", async () => {
    const state = await addCardActivityAction(
      IDLE_ACTIVITY,
      formData({
        accountId: "1",
        categoryId: "2",
        amount: "80",
        date: "2999-01-01",
        merchant: "Costco",
      }),
    );
    expect(state.status).toBe("error");
    expect(createCardActivityMock).not.toHaveBeenCalled();
  });

  it("refuses a missing category — D13=B depends on it", async () => {
    // An uncategorized charge lands in the backlog instead of an envelope, and
    // card spending stops being visible to the budget for that row.
    const state = await addCardActivityAction(
      IDLE_ACTIVITY,
      formData({
        accountId: "1",
        categoryId: "",
        amount: "80",
        date: "2026-09-06",
        merchant: "Costco",
      }),
    );
    expect(state.status).toBe("error");
    expect(createCardActivityMock).not.toHaveBeenCalled();
  });

  it("converts dollars to cents once it reaches the writer", async () => {
    // The only dollars->cents conversion on the third write path, and it had
    // no coverage at all: `createCardActivity` takes cents, so every test of
    // that function bypassed this line.
    createCardActivityMock.mockReturnValue({
      status: "ok",
      message: "Recorded.",
      transactionId: 7,
      balanceCents: -21_480,
    });
    const state = await addCardActivityAction(
      IDLE_ACTIVITY,
      formData({
        accountId: "1",
        categoryId: "2",
        amount: "80.25",
        date: "2026-09-06",
        merchant: "Costco",
      }),
    );
    expect(state.status).toBe("ok");
    expect(createCardActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 8025, kind: "charge" }),
      expect.anything(),
    );
  });

  it("passes the refusal reason through, so 'Reconcile instead' can appear", async () => {
    createCardActivityMock.mockReturnValue({
      status: "refused",
      reason: "before-anchor",
      message: "This is dated before your last reconcile.",
      accountId: 1,
    });
    const state = await addCardActivityAction(
      IDLE_ACTIVITY,
      formData({
        accountId: "1",
        categoryId: "2",
        amount: "80",
        date: "2026-09-06",
        merchant: "Costco",
      }),
    );
    expect(state).toMatchObject({ status: "error", reason: "before-anchor" });
  });
});

/**
 * The refresh that follows an ALREADY-COMMITTED write.
 *
 * These drive the real action rather than mirroring its body, which is the
 * point — `accounts/actions.test.ts` mirrors the DB pipeline by hand, and
 * CLAUDE.md records what that costs: a mirrored test kept 1,755 tests green
 * while the opt-in it claimed to pin had been deleted from the action. Here the
 * write is mocked and `revalidatePath` is real-enough (a mock that throws), so
 * the thing under test is the wiring itself.
 *
 * Removing `guardRefresh` from `revalidateCardActivitySurfaces` makes every
 * case below fail: the throw reaches each action's outer `catch`, which
 * returns `{status:"error"}` for a charge that is already in the ledger.
 *
 * ONLY that helper. Every case here drives `addCardActivityAction` or
 * `removeCardActivityAction`, and those are its only two callers — so nothing
 * below can say anything about `revalidateBalanceSurfaces`, which guards the
 * four anchor-moving actions. Deleting `guardRefresh` from THAT one leaves
 * this suite green, which is exactly the false confidence a docblock naming
 * both would buy. Its coverage lives in `actions.balance-refresh.test.ts`,
 * separate because it needs a real-ish account row and `db: {}` above forbids
 * one on purpose.
 */
describe("a failed refresh never denies a committed write", () => {
  function throwingRevalidate() {
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });
    // Silenced here; the log itself is asserted in its own case below.
    return vi.spyOn(console, "error").mockImplementation(() => {});
  }

  function goodCharge(): FormData {
    return formData({
      accountId: "1",
      categoryId: "2",
      amount: "80.25",
      date: "2026-01-05",
      merchant: "Costco",
    });
  }

  it("reports a charge that COMMITTED as ok, with a warning, not as an error", async () => {
    createCardActivityMock.mockReturnValue({
      status: "ok",
      message: "Recorded. Citi Bank is now -$2,286.68.",
      transactionId: 42,
      balanceCents: -228668,
    });
    const logged = throwingRevalidate();

    const state = await addCardActivityAction(IDLE_ACTIVITY, goodCharge());
    logged.mockRestore();

    // NOT `error`. The row exists; saying otherwise sends the user round the
    // loop again, and `createCardActivity` has no delete path to undo the
    // duplicate they would create.
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/Recorded/);
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("leaves `warning` undefined when the refresh works, so success stays plain", async () => {
    createCardActivityMock.mockReturnValue({
      status: "ok",
      message: "Recorded.",
      transactionId: 42,
      balanceCents: -228668,
    });
    revalidatePathMock.mockImplementation(() => {});

    const state = await addCardActivityAction(IDLE_ACTIVITY, goodCharge());

    expect(state).toMatchObject({ status: "ok" });
    if (state.status !== "ok") throw new Error("unreachable");
    // An always-present warning would paint every ordinary save as degraded.
    expect(state.warning).toBeUndefined();
  });

  it("does not swallow the refresh failure silently", async () => {
    createCardActivityMock.mockReturnValue({
      status: "ok",
      message: "Recorded.",
      transactionId: 42,
      balanceCents: -228668,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    await addCardActivityAction(IDLE_ACTIVITY, goodCharge());

    expect(logged).toHaveBeenCalledWith(
      "[/accounts] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("still REFUSES a genuine refusal — the guard must not turn errors into warnings", async () => {
    // The other direction, and worth pinning: a guard that reported every
    // outcome as ok would hide `before-anchor`, which is a real refusal the
    // user has to act on.
    createCardActivityMock.mockReturnValue({
      status: "refused",
      reason: "before-anchor",
      message: "This is dated before your last reconcile.",
      accountId: 1,
    });
    const logged = throwingRevalidate();

    const state = await addCardActivityAction(IDLE_ACTIVITY, goodCharge());

    // Refused BEFORE the refresh runs, so no warning and no log — nothing was
    // written for a stale page to be stale about.
    expect(state).toMatchObject({ status: "error", reason: "before-anchor" });
    // ASSERTED BEFORE `mockRestore`, and that ordering is the whole assertion.
    // Vitest's `mockRestore` performs a `mockReset` first, which WIPES
    // `mock.calls` — so this ran green unconditionally when it sat after the
    // restore, pinning nothing at all.
    expect(logged).not.toHaveBeenCalled();
    // The fact the comment above actually claims, which nothing asserted: the
    // refusal returns before `revalidateCardActivitySurfaces` is reached. A
    // revalidation here would re-render the form out from under the only
    // rendering of `before-anchor`.
    expect(revalidatePathMock).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

/**
 * `removeCardActivityAction` — the NEW action, and the only one in this file
 * whose write DELETES a row.
 *
 * `addCardActivityAction`'s suite above covers the shared refresh guard, but
 * not this wrapper: it has its own input coercion, and it is the wrapper that
 * decides a committed DELETE is reported as `ok`. That distinction is sharper
 * here than anywhere else on the page — the row is gone, the dialog that
 * launched it says in as many words "This cannot be undone in the app", and an
 * `{status:"error"}` for a delete that landed invites a second click that then
 * refuses with `not-found`, which reads as the app contradicting itself.
 */
describe("removeCardActivityAction", () => {
  function form(transactionId: string): FormData {
    return formData({ transactionId });
  }

  it("REFUSES a non-numeric transaction id, and never reaches the writer", async () => {
    // `Number("abc")` is NaN. A Server Action is a network endpoint regardless
    // of what the menu rendered, so the coercion has to be checked here.
    const state = await removeCardActivityAction(IDLE_ACTIVITY, form("abc"));

    expect(state.status).toBe("error");
    expect(removeCardActivityMock).not.toHaveBeenCalled();
  });

  it("passes the refusal REASON through, so the bank-row message survives", async () => {
    // `not-manual` is the guard that protects the ledger rather than a
    // mechanism. Dropping `reason` on the floor is how a refusal becomes a
    // generic failure the user cannot act on.
    removeCardActivityMock.mockReturnValue({
      status: "refused",
      reason: "not-manual",
      message: "That transaction came from your bank, so it can't be removed here.",
    });

    const state = await removeCardActivityAction(IDLE_ACTIVITY, form("42"));

    expect(state).toMatchObject({ status: "error", reason: "not-manual" });
    // Refused before any refresh — nothing was written for a page to be stale
    // about, and revalidating would re-render the menu holding the message.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("reports a COMMITTED delete as ok with a warning when the refresh throws", async () => {
    removeCardActivityMock.mockReturnValue({
      status: "ok",
      message: "Charge removed. The balance is now -$1,000.00.",
      transactionId: 42,
      balanceCents: -100000,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    revalidatePathMock.mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    const state = await removeCardActivityAction(IDLE_ACTIVITY, form("42"));
    logged.mockRestore();

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toMatch(/Charge removed/);
    expect(state.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("revalidates the MONTH view too — a removed charge changes an envelope's spend", async () => {
    // `revalidateCardActivitySurfaces`, not `revalidateBalanceSurfaces`. The
    // row carried a category, so `/budget/[year]/[month]` is stale without it;
    // and removing the LAST row makes the card eligible for the feed balance
    // pass again, which is why the balance surfaces go as well.
    removeCardActivityMock.mockReturnValue({
      status: "ok",
      message: "Charge removed.",
      transactionId: 42,
      balanceCents: -100000,
    });
    revalidatePathMock.mockImplementation(() => {});

    const state = await removeCardActivityAction(IDLE_ACTIVITY, form("42"));

    expect(state).toMatchObject({ status: "ok" });
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.warning).toBeUndefined();
    expect(revalidatePathMock).toHaveBeenCalledWith("/budget/[year]/[month]", "page");
    for (const path of ["/accounts", "/", "/sync", "/transactions"]) {
      expect(revalidatePathMock).toHaveBeenCalledWith(path);
    }
  });
});
