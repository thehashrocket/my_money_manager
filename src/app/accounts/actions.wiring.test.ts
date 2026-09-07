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
  return { ...actual, createCardActivity: createCardActivityMock };
});

const { updateLiabilityBalanceAction, addCardActivityAction } = await import("./actions");
const { IDLE, IDLE_ACTIVITY } = await import("./action-state");
const { STARTING_BALANCE_DOLLARS_MAX } = await import("@/lib/import/accountAnchorFields");

beforeEach(() => {
  createCardActivityMock.mockReset();
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
