import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateCardTermsAction` had ZERO action-layer test coverage before this
 * file — only its pure half (`validateCardTermsInput`) was unit-tested.
 * That mattered because the action's own comment documents a real,
 * previously-shipped bug in its patch-building logic: `optionalPositiveDollarsSchema`
 * is `.nullish()`, so a field genuinely ABSENT from the FormData parses to
 * `null` exactly like an emptied one, and a naive `patch.x = parsed.data.x`
 * for every field would silently NULL whatever the request omitted. The fix
 * — `if (raw.field !== undefined) patch.field = ...` — has no test pinning it
 * anywhere. Added here (card-paydown-target plan, Issue 3A) alongside the new
 * `paydownTarget` field, covering all three fields rather than only the new
 * one: the harness cost is paid once regardless of scope.
 *
 * Same `dbMock` shape as `actions.balance-refresh.test.ts` — a hand-rolled
 * select/update chain, not the real `:memory:` test db, because this drives
 * the REAL `updateCardTermsAction` (imported after the `vi.mock` calls)
 * rather than hand-mirroring its body, which is the fragile pattern this
 * codebase has already been burned by once (see the `bulkRetarget`/
 * `runBulkRetarget` split in `lib/categorize/`).
 */

const revalidatePathMock = vi.hoisted(() => vi.fn());
const updateRunMock = vi.hoisted(() => vi.fn());
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

const { updateCardTermsAction } = await import("./actions");
const { IDLE } = await import("./action-state");

function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Citi Visa",
    type: "credit",
    creditLimitCents: 500_000,
    minimumPaymentCents: 5_000,
    paydownTargetCents: 50_000,
    ...overrides,
  };
}

/** Only the keys actually set land in the FormData — the whole point of the
 *  absent-vs-empty distinction this action's patch guard exists to preserve. */
function termsForm(fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("accountId", "1");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  revalidatePathMock.mockReset().mockImplementation(() => {});
  updateRunMock.mockReset();
  updateSetMock.mockReset();
  accountRowMock.current = cardRow();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updateCardTermsAction", () => {
  it("refuses a non-credit-card account", async () => {
    accountRowMock.current = cardRow({ type: "checking" });
    const state = await updateCardTermsAction(
      IDLE,
      termsForm({ creditLimit: "5000", minimumPayment: "50", paydownTarget: "500" }),
    );
    expect(state.status).toBe("error");
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("refuses a missing account", async () => {
    accountRowMock.current = null;
    const state = await updateCardTermsAction(IDLE, termsForm());
    expect(state.status).toBe("error");
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range paydown target with a field-specific message", async () => {
    const state = await updateCardTermsAction(IDLE, termsForm({ paydownTarget: "100000001" }));
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/paydown target/i);
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  // The FIELD_MESSAGES lookup replaced a two-way ternary
  // (`onLimit ? creditLimit-message : minimumPayment-message`) — a genuine
  // refactor, not just an addition, so both of its pre-existing branches need
  // their own pin alongside the new paydownTarget one above. A swapped key or
  // a path[0] that doesn't match the object's keys would fall through to the
  // generic fallback message silently.
  it("refuses an out-of-range credit limit with a field-specific message", async () => {
    const state = await updateCardTermsAction(IDLE, termsForm({ creditLimit: "100000001" }));
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/credit limit/i);
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  it("refuses a negative minimum payment with a field-specific message", async () => {
    const state = await updateCardTermsAction(IDLE, termsForm({ minimumPayment: "-5" }));
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/minimum payment/i);
    expect(updateRunMock).not.toHaveBeenCalled();
  });

  // accountId is read straight off FormData with no schema behind it
  // (`Number(raw.accountId)`), so a missing, non-numeric, zero or negative
  // id is its own untested branch distinct from "account not found" (which
  // exercises a valid-shaped id that the mocked `select` can't find).
  it.each([["missing", undefined], ["non-numeric", "abc"], ["zero", "0"], ["negative", "-1"]])(
    "refuses a %s accountId before ever querying the account",
    async (_label, value) => {
      const fd = new FormData();
      if (value !== undefined) fd.set("accountId", value);
      const state = await updateCardTermsAction(IDLE, fd);
      expect(state.status).toBe("error");
      if (state.status !== "error") throw new Error("unreachable");
      expect(state.message).toMatch(/no longer exists/i);
      expect(updateRunMock).not.toHaveBeenCalled();
    },
  );

  it("stores a valid dollar value as cents, for all three fields", async () => {
    const state = await updateCardTermsAction(
      IDLE,
      termsForm({ creditLimit: "6000", minimumPayment: "75", paydownTarget: "600" }),
    );
    expect(state.status).toBe("ok");
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditLimitCents: 600_000,
        minimumPaymentCents: 7_500,
        paydownTargetCents: 60_000,
      }),
    );
  });

  it("clears a field to NULL when posted empty", async () => {
    await updateCardTermsAction(
      IDLE,
      termsForm({ creditLimit: "", minimumPayment: "", paydownTarget: "" }),
    );
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        creditLimitCents: null,
        minimumPaymentCents: null,
        paydownTargetCents: null,
      }),
    );
  });

  // THE REGRESSION CASE. A field genuinely absent from the FormData (never
  // `.set()` at all, not even to "") must leave the stored value untouched —
  // this is the exact bug the action's own comment documents as having
  // shipped once, for `creditLimit`/`minimumPayment`. Now pinned for real,
  // and extended to the new `paydownTarget` field it was added alongside.
  it("leaves a field ABSENT from the request untouched, never nulling it (the documented absent-vs-empty bug)", async () => {
    // Only creditLimit is posted; minimumPayment and paydownTarget are never
    // `.set()` on the FormData at all.
    await updateCardTermsAction(IDLE, termsForm({ creditLimit: "7000" }));

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.creditLimitCents).toBe(700_000);
    expect(patch).not.toHaveProperty("minimumPaymentCents");
    expect(patch).not.toHaveProperty("paydownTargetCents");
  });

  it("leaves paydownTarget untouched when only the other two fields are posted", async () => {
    await updateCardTermsAction(
      IDLE,
      termsForm({ creditLimit: "7000", minimumPayment: "100" }),
    );

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.creditLimitCents).toBe(700_000);
    expect(patch.minimumPaymentCents).toBe(10_000);
    expect(patch).not.toHaveProperty("paydownTargetCents");
  });
});
