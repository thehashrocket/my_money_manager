import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { accountClass } from "@/lib/accounts/accountClass";
import { validateUpdateAnchorInput } from "@/lib/import/validateUpdateAnchorInput";
import { owedDollarsToSignedCents } from "@/lib/import/accountAnchorFields";
import type { AccountsActionState } from "./action-state";

/**
 * Mirrors `updateLiabilityBalanceAction`'s pipeline minus the Next.js shell
 * (`revalidatePath` closes over the singleton DB and can't run under
 * `:memory:` — same convention as src/app/import/actions.test.ts and
 * src/app/budget/actions.test.ts).
 *
 * This is D10 path 3, RECONCILE — under D15 it is the ONLY way a credit card's
 * balance can ever be updated, so every branch below is on the critical path
 * for the whole liability feature. The two that matter most:
 *
 *   - the NEGATION (DS64). The user types a positive "Balance owed" and this
 *     stores it negative. Getting it wrong adds the debt to the dashboard's
 *     Cash figure and leaves net worth wrong by twice the balance, with no
 *     error and a number that looks plausible.
 *   - the PRIOR-ANCHOR write (E19). There is no import batch here to hang it
 *     on, and it is the real mechanism /accounts/error.tsx's reassurance copy
 *     describes.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});
afterEach(() => handle.close());

function seedAccount(opts: {
  name: string;
  type: "checking" | "credit" | "loan";
  cents: number;
  anchor: string;
}) {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: opts.name,
      type: opts.type,
      startingBalanceCents: opts.cents,
      startingBalanceDate: opts.anchor,
      balanceSource: "manual",
    })
    .returning()
    .all();
  return row;
}

function fail(message: string, field?: "balance" | "date"): AccountsActionState {
  return { status: "error", message, field };
}

/** The exact chain `updateLiabilityBalanceAction` runs, against the test db. */
function reconcile(raw: { accountId: unknown; balanceOwed: unknown; asOf: unknown }) {
  const owed = Number(raw.balanceOwed);
  if (!Number.isFinite(owed) || owed < 0) {
    return fail("Enter what you owe as a positive number.", "balance");
  }

  const parsed = validateUpdateAnchorInput({
    accountId: raw.accountId,
    startingBalance: owed === 0 ? 0 : -owed,
    startingBalanceDate: raw.asOf,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const onDate = issue?.path.includes("startingBalanceDate");
    return fail(
      onDate
        ? "That date is in the future. Use today or earlier."
        : "That balance is outside the range this app accepts.",
      onDate ? "date" : "balance",
    );
  }
  const { accountId, startingBalance, startingBalanceDate } = parsed.data;

  const account = handle.db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) return fail("That account no longer exists.");
  if (accountClass(account.type) !== "liability") {
    return fail(`${account.name} is not a credit card or loan.`);
  }

  // THE SHARED HELPER, not a local copy. This line used to read
  // `Math.round(startingBalance * 100)` — and since `startingBalance` is
  // already `-owed`, that was verbatim the `Math.round(-owed * 100)` formula
  // rule 9 names as the half-cent divergence. The double therefore CONTAINED
  // the bug it was written to guard: `owed = 0.125` produced -12 here and -13
  // in production, and the negation test below would have passed unchanged if
  // `actions.ts` had reverted to its own local copy.
  const cents = owedDollarsToSignedCents(-startingBalance);

  // The no-op guard, mirrored from the action. Without it, Save-with-no-edits
  // overwrites the single `prior_starting_balance_*` slot with the current
  // anchor and destroys the only undo step.
  const existing = handle.db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get()!;
  if (
    cents === existing.startingBalanceCents &&
    startingBalanceDate === existing.startingBalanceDate
  ) {
    return { status: "ok" as const, message: `${existing.name} is unchanged.` };
  }

  handle.db
    .update(schema.accounts)
    .set({
      startingBalanceCents: cents,
      startingBalanceDate,
      priorStartingBalanceCents: account.startingBalanceCents,
      priorStartingBalanceDate: account.startingBalanceDate,
      balanceAsOf: null,
      balanceSource: "manual",
      updatedAt: new Date(),
    })
    .where(eq(schema.accounts.id, accountId))
    .run();

  return { status: "ok" as const, message: `${account.name} is now ${cents}` };
}

const reload = (id: number) =>
  handle.db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();

describe("updateLiabilityBalanceAction — the reconcile pipeline (D10 path 3)", () => {
  it("NEGATES the typed 'Balance owed' — the ledger-corruption path (DS64)", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });

    const state = reconcile({
      accountId: String(visa.id),
      balanceOwed: "2148.32",
      asOf: "2026-09-06",
    });
    expect(state.status).toBe("ok");

    const after = reload(visa.id);
    expect(after?.startingBalanceCents).toBe(-214_832);
    expect(after?.startingBalanceDate).toBe("2026-09-06");
  });

  it("stores a paid-off card as 0, never -0", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    expect(reconcile({ accountId: visa.id, balanceOwed: "0", asOf: "2026-09-06" }).status).toBe(
      "ok",
    );
    const after = reload(visa.id);
    expect(after?.startingBalanceCents).toBe(0);
    expect(Object.is(after?.startingBalanceCents, -0)).toBe(false);
  });

  it("records the PRIOR anchor on the account row, since there is no batch (E19)", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    reconcile({ accountId: visa.id, balanceOwed: "500", asOf: "2026-09-06" });

    const after = reload(visa.id);
    expect(after?.priorStartingBalanceCents).toBe(-200_000);
    expect(after?.priorStartingBalanceDate).toBe("2026-08-01");
  });

  it("starts DS57's 35-day manual clock and clears any provider date", () => {
    const loan = seedAccount({
      name: "Mortgage",
      type: "loan",
      cents: -30_000_000,
      anchor: "2026-08-01",
    });
    // Simulate the feed having written it first, as refreshLiabilityBalances does.
    handle.db
      .update(schema.accounts)
      .set({ balanceSource: "feed", balanceAsOf: new Date("2026-08-01T14:32:00Z") })
      .where(eq(schema.accounts.id, loan.id))
      .run();

    reconcile({ accountId: loan.id, balanceOwed: "299000", asOf: "2026-09-06" });

    const after = reload(loan.id);
    expect(after?.balanceSource).toBe("manual");
    expect(after?.balanceAsOf).toBeNull();
  });

  it("REFUSES a negative 'Balance owed' rather than double-negating it into an asset", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    const state = reconcile({ accountId: visa.id, balanceOwed: "-500", asOf: "2026-09-06" });
    expect(state).toEqual({
      status: "error",
      message: "Enter what you owe as a positive number.",
      field: "balance",
    });
    // Untouched: a refusal never reaches the UPDATE.
    expect(reload(visa.id)?.startingBalanceCents).toBe(-200_000);
  });

  it("refuses a future date and blames the DATE field, not the balance", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    const state = reconcile({ accountId: visa.id, balanceOwed: "500", asOf: "2099-01-01" });
    expect(state).toEqual({
      status: "error",
      message: "That date is in the future. Use today or earlier.",
      field: "date",
    });
    expect(reload(visa.id)?.startingBalanceCents).toBe(-200_000);
  });

  it("refuses an out-of-range balance and blames the BALANCE field", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    const state = reconcile({
      accountId: visa.id,
      balanceOwed: "999999999",
      asOf: "2026-09-06",
    });
    expect(state.status).toBe("error");
    if (state.status === "error") expect(state.field).toBe("balance");
  });

  it("refuses an account id that no longer exists — reachable from a stale tab", () => {
    const state = reconcile({ accountId: 999_999, balanceOwed: "500", asOf: "2026-09-06" });
    expect(state).toEqual({
      status: "error",
      message: "That account no longer exists.",
      field: undefined,
    });
  });

  it("REFUSES to reconcile a checking account — /accounts' form is liabilities-only", () => {
    const checking = seedAccount({
      name: "Checking",
      type: "checking",
      cents: 500_000,
      anchor: "2026-08-01",
    });
    const state = reconcile({ accountId: checking.id, balanceOwed: "500", asOf: "2026-09-06" });
    expect(state.status).toBe("error");
    if (state.status === "error") expect(state.message).toContain("not a credit card or loan");
    // The asset's positive anchor survives — this is the guard that stops a
    // "Balance owed" negation being applied to money you actually have.
    expect(reload(checking.id)?.startingBalanceCents).toBe(500_000);
  });
});

/** The exact chain `revertLiabilityBalanceAction` runs, against the test db. */
function revert(raw: { accountId: unknown }): AccountsActionState {
  const accountId = Number(raw.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return fail("That account no longer exists.");
  }
  const account = handle.db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) return fail("That account no longer exists.");
  if (accountClass(account.type) !== "liability") {
    return fail(`${account.name} is not a credit card or loan.`);
  }
  if (account.priorStartingBalanceCents === null || account.priorStartingBalanceDate === null) {
    return fail(`${account.name} has no previous balance to go back to.`);
  }

  handle.db
    .update(schema.accounts)
    .set({
      startingBalanceCents: account.priorStartingBalanceCents,
      startingBalanceDate: account.priorStartingBalanceDate,
      priorStartingBalanceCents: account.startingBalanceCents,
      priorStartingBalanceDate: account.startingBalanceDate,
      balanceAsOf: null,
      balanceSource: "manual",
      updatedAt: new Date(),
    })
    .where(eq(schema.accounts.id, accountId))
    .run();

  return { status: "ok", message: "reverted" };
}


describe("revertLiabilityBalanceAction (E19)", () => {
  it("puts the previous balance and date back", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    reconcile({ accountId: visa.id, balanceOwed: "2500", asOf: "2026-09-06" });
    expect(reload(visa.id)?.startingBalanceCents).toBe(-250_000);

    expect(revert({ accountId: visa.id }).status).toBe("ok");
    const after = reload(visa.id);
    expect(after?.startingBalanceCents).toBe(-200_000);
    expect(after?.startingBalanceDate).toBe("2026-08-01");
  });

  it("SWAPS rather than clears, so the undo is itself undoable", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    reconcile({ accountId: visa.id, balanceOwed: "2500", asOf: "2026-09-06" });
    revert({ accountId: visa.id });

    // A mis-clicked undo costs one more click, not the figure just typed.
    expect(reload(visa.id)?.priorStartingBalanceCents).toBe(-250_000);
    expect(revert({ accountId: visa.id }).status).toBe("ok");
    expect(reload(visa.id)?.startingBalanceCents).toBe(-250_000);
  });

  it("refuses an account whose balance has never been moved", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });

    const result = revert({ accountId: visa.id });
    expect(result.status).toBe("error");
    expect(reload(visa.id)?.startingBalanceCents).toBe(-200_000);
  });

  it("refuses an asset account", () => {
    const checking = seedAccount({
      name: "Checking",
      type: "checking",
      cents: 500_000,
      anchor: "2026-08-01",
    });

    expect(revert({ accountId: checking.id }).status).toBe("error");
  });

  it("resets the balance source to manual, restarting DS57's clock", () => {
    const loan = seedAccount({
      name: "Car Loan",
      type: "loan",
      cents: -1_000_000,
      anchor: "2026-08-01",
    });
    reconcile({ accountId: loan.id, balanceOwed: "9000", asOf: "2026-09-06" });
    revert({ accountId: loan.id });

    const after = reload(loan.id);
    expect(after?.balanceSource).toBe("manual");
    expect(after?.balanceAsOf).toBeNull();
  });
});

/**
 * `prior_starting_balance_*` holds exactly ONE step of history (rule 9), and
 * the reconcile write used to overwrite it unconditionally. The form arrives
 * pre-filled with the current balance and today's date, so the most ordinary
 * interaction on the page spent that single slot on a no-op and destroyed the
 * real previous anchor.
 */
describe("updateLiabilityBalanceAction — a no-op must not spend the undo", () => {
  it("LEAVES the prior anchor alone when nothing actually changed", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });
    // A real earlier correction: -$3,000 on Jul 1 is what Undo should go back
    // to, and it is the value at risk.
    handle.db
      .update(schema.accounts)
      .set({ priorStartingBalanceCents: -300_000, priorStartingBalanceDate: "2026-07-01" })
      .where(eq(schema.accounts.id, visa.id))
      .run();

    // Save with exactly what the form renders: the current magnitude, and the
    // current anchor date.
    const state = reconcile({
      accountId: String(visa.id),
      balanceOwed: "2000.00",
      asOf: "2026-08-01",
    });

    expect(state.status).toBe("ok");
    const after = reload(visa.id);
    expect(after?.startingBalanceCents).toBe(-200_000);
    expect(after?.startingBalanceDate).toBe("2026-08-01");
    // The genuine previous balance survives, so Undo still goes somewhere real.
    expect(after?.priorStartingBalanceCents).toBe(-300_000);
    expect(after?.priorStartingBalanceDate).toBe("2026-07-01");
  });

  it("still records the prior anchor when the balance really moves", () => {
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });

    const state = reconcile({
      accountId: String(visa.id),
      balanceOwed: "2148.32",
      asOf: "2026-08-01",
    });

    expect(state.status).toBe("ok");
    const after = reload(visa.id);
    expect(after?.startingBalanceCents).toBe(-214_832);
    expect(after?.priorStartingBalanceCents).toBe(-200_000);
  });

  it("treats a same-balance-different-date save as a real move", () => {
    // The anchor DATE is half the anchor. Re-dating the same figure to today
    // is a genuine assertion about when it was true, so it earns the write.
    const visa = seedAccount({
      name: "Visa",
      type: "credit",
      cents: -200_000,
      anchor: "2026-08-01",
    });

    const state = reconcile({
      accountId: String(visa.id),
      balanceOwed: "2000.00",
      asOf: "2026-09-06",
    });

    expect(state.status).toBe("ok");
    const after = reload(visa.id);
    expect(after?.startingBalanceDate).toBe("2026-09-06");
    expect(after?.priorStartingBalanceDate).toBe("2026-08-01");
  });
});
