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

  it("refuses an out-of-range paydown goal with a field-specific message", async () => {
    const state = await updateCardTermsAction(IDLE, termsForm({ paydownTarget: "100000001" }));
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/paydown goal/i);
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

  // The mirror of the two tests above: every OTHER absent-vs-empty case in
  // this file posts creditLimit, so creditLimitCents' own guard branch
  // (`if (raw.creditLimit !== undefined) ...`) was never exercised omitted.
  it("leaves creditLimit untouched when only the other two fields are posted", async () => {
    await updateCardTermsAction(
      IDLE,
      termsForm({ minimumPayment: "100", paydownTarget: "600" }),
    );

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.minimumPaymentCents).toBe(10_000);
    expect(patch.paydownTargetCents).toBe(60_000);
    expect(patch).not.toHaveProperty("creditLimitCents");
  });
});

/**
 * THE STALE-TAB REGRESSION (red-team finding, card-paydown-target plan).
 * `_card-terms-form.tsx`'s real browser form always posts all three fields —
 * confirmed above, `absent` never fires for a genuine submit — so the
 * `raw.field !== undefined` guard alone could never catch this: tab A edits
 * only the paydown goal and saves; tab B, still showing the pre-edit page,
 * edits only the credit limit and saves — its POST still carries tab B's own
 * stale `paydownTarget`, present exactly like every other field, and would
 * silently overwrite tab A's already-committed change.
 *
 * The fix is snapshot-diffing: the form now posts a parallel `<field>Snapshot`
 * hidden input per field, carrying whatever value THAT TAB last loaded. A
 * field is only written when what was posted differs from its own snapshot —
 * true when the user actually edited it, false when it's merely along for
 * the ride on an unrelated field's save.
 */
function browserForm(
  fields: Partial<Record<"creditLimit" | "minimumPayment" | "paydownTarget", string>>,
  snapshots: Partial<Record<"creditLimit" | "minimumPayment" | "paydownTarget", string>>,
): FormData {
  const fd = new FormData();
  fd.set("accountId", "1");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const [k, v] of Object.entries(snapshots)) fd.set(`${k}Snapshot`, v);
  return fd;
}

describe("updateCardTermsAction — stale-tab guard (snapshot vs. posted value)", () => {
  it("does NOT write a field whose posted value still matches its own snapshot (untouched)", async () => {
    // Simulates tab B: it loaded creditLimit=5000, never touched it, and
    // posts it back unchanged alongside a real edit to minimumPayment.
    await updateCardTermsAction(
      IDLE,
      browserForm(
        { creditLimit: "5000.00", minimumPayment: "60", paydownTarget: "500.00" },
        { creditLimit: "5000.00", minimumPayment: "50.00", paydownTarget: "500.00" },
      ),
    );

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.minimumPaymentCents).toBe(6_000);
    expect(patch).not.toHaveProperty("creditLimitCents");
    expect(patch).not.toHaveProperty("paydownTargetCents");
  });

  it("WRITES a field whenever posted differs from its own snapshot, even if it matches what's currently stored elsewhere", async () => {
    await updateCardTermsAction(
      IDLE,
      browserForm(
        { creditLimit: "5000.00", minimumPayment: "50.00", paydownTarget: "700.00" },
        { creditLimit: "5000.00", minimumPayment: "50.00", paydownTarget: "500.00" },
      ),
    );

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.paydownTargetCents).toBe(70_000);
    expect(patch).not.toHaveProperty("creditLimitCents");
    expect(patch).not.toHaveProperty("minimumPaymentCents");
  });

  it("still applies an explicit clear even though the emptied field differs from its own snapshot", async () => {
    await updateCardTermsAction(
      IDLE,
      browserForm(
        { creditLimit: "5000.00", minimumPayment: "50.00", paydownTarget: "" },
        { creditLimit: "5000.00", minimumPayment: "50.00", paydownTarget: "500.00" },
      ),
    );

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.paydownTargetCents).toBeNull();
  });

  it("THE FULL REPRO: a stale tab's save cannot revert a different tab's already-committed edit to an unrelated field", async () => {
    // Tab A already saved paydownTarget 500 -> 700 (not modeled here directly;
    // this test's premise is that tab B never saw that write). Tab B loaded
    // the account before tab A's save (paydownTarget snapshot = 500, the
    // PRE-tab-A value) and now saves its own unrelated creditLimit edit.
    await updateCardTermsAction(
      IDLE,
      browserForm(
        { creditLimit: "9000.00", minimumPayment: "50.00", paydownTarget: "500.00" },
        { creditLimit: "5000.00", minimumPayment: "50.00", paydownTarget: "500.00" },
      ),
    );

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.creditLimitCents).toBe(900_000);
    // The bug this guards against: without snapshot-diffing, this line would
    // have been `paydownTargetCents: 50_000`, silently reverting tab A's
    // already-committed 700 back to the stale 500 tab B still had loaded.
    expect(patch).not.toHaveProperty("paydownTargetCents");
  });

  it("a genuinely absent snapshot (hand-made request, no snapshot concept) behaves exactly like the pre-existing absent-field guard", async () => {
    // No `raw.creditLimitSnapshot` at all — `undefined !== undefined` is
    // false, so this still reads as "untouched," matching the guard's
    // original behavior for a crafted request that omits the field itself.
    const fd = new FormData();
    fd.set("accountId", "1");
    fd.set("minimumPayment", "60");
    await updateCardTermsAction(IDLE, fd);

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.minimumPaymentCents).toBe(6_000);
    expect(patch).not.toHaveProperty("creditLimitCents");
    expect(patch).not.toHaveProperty("paydownTargetCents");
  });

  // THE ASYMMETRIC CASE (Codex + a Claude adversarial subagent, independently).
  // The real browser form always posts a field and its Snapshot together —
  // never one without the other — but nothing server-side enforced that
  // pairing. Dropping `paydownTarget` while leaving `paydownTargetSnapshot`
  // present made `raw.paydownTarget` (undefined) parse to `null` and compare
  // unequal to the snapshot string, reading as "changed" and silently
  // writing null over a real stored value — the exact destructive-by-omission
  // bug the presence guard exists to prevent, reintroduced by relying on
  // snapshot-diffing ALONE instead of layering it onto that guard.
  it("a field ABSENT from the request is never written, even when its own Snapshot is present (crafted/malformed request)", async () => {
    const fd = new FormData();
    fd.set("accountId", "1");
    // paydownTarget itself is never `.set()` — only its snapshot is, which a
    // real browser submit could never produce (the two inputs are siblings
    // in the same form, always posted together) but a crafted POST could.
    fd.set("paydownTargetSnapshot", "500.00");
    fd.set("minimumPayment", "75");
    fd.set("minimumPaymentSnapshot", "50.00");

    await updateCardTermsAction(IDLE, fd);

    const patch = updateSetMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.minimumPaymentCents).toBe(7_500);
    expect(patch).not.toHaveProperty("paydownTargetCents");
    expect(patch).not.toHaveProperty("creditLimitCents");
  });
});
