"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountClass } from "@/lib/accounts/accountClass";
import { hasAnyTransactionRows } from "@/lib/accounts/hasAnyTransactionRows";
import { resolveBalanceAction } from "@/lib/accounts/resolveBalanceAction";
import { validateUpdateAnchorInput } from "@/lib/import/validateUpdateAnchorInput";
import { formatCents } from "@/lib/money";
import { syncSimpleFin } from "@/lib/simplefin/sync";

/**
 * T28 / E20 — EVERY ACTION ON THIS ROUTE RETURNS ITS OUTCOME AS STATE AND
 * NEVER THROWS. `error.tsx` is the backstop for the genuinely unexpected.
 *
 * This is a decision, not a style preference, and it had to be made before
 * any of these were written. DS54-57 promises inline row errors, a form that
 * keeps your input, a toast with the row restored, and DS56's focus handoff
 * into the reconcile field. A thrown Server Action unmounts the whole route
 * into `error.tsx`, so NONE of those survive a throw. `/accounts` has four
 * independent per-row actions live at once.
 *
 * The path of least resistance pointed the wrong way: T6 delegates anchor
 * validation to `validateUpdateAnchorInput`, whose existing caller
 * `updateAccountAnchorAction` (`import/actions.ts`) is throw-and-redirect,
 * forty lines from where you would copy. `/sync` is the pattern to copy
 * instead, and CLAUDE.md already wrote the rationale for it: "a throw would
 * take out the undo button and the balance check along with the page."
 */
export type AccountsActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; field?: "balance" | "date" };

export const IDLE: AccountsActionState = { status: "idle" };

function fail(message: string, field?: "balance" | "date"): AccountsActionState {
  return { status: "error", message, field };
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Revalidates every surface that renders a balance. Same set as
 * `/sync`'s revalidateAll, and deliberately NOT `revalidatePath("/", "layout")`
 * — that unmounts the client components holding `useActionState` and would
 * strand a row's button on "Saving…" forever.
 */
function revalidateBalanceSurfaces(): void {
  for (const p of ["/accounts", "/", "/import", "/sync", "/transactions", "/categorize", "/budget"]) {
    revalidatePath(p);
  }
}

/**
 * D10 path 3 — RECONCILE. Set what you actually owe today.
 *
 * Delegates the bounds to `validateUpdateAnchorInput`; it does NOT
 * reimplement them. `accountAnchorFields.ts` is the single definition of a
 * legal anchor across account creation, the /import repair form, CSV-derived
 * auto-anchoring and this.
 *
 * The user types a positive "Balance owed" and this negates it, exactly as
 * account creation does (DS64). The user never types a minus sign anywhere
 * in the app.
 */
export async function updateLiabilityBalanceAction(
  _prev: AccountsActionState,
  formData: FormData,
): Promise<AccountsActionState> {
  try {
    const raw = Object.fromEntries(formData);
    const owed = Number(raw.balanceOwed);
    if (!Number.isFinite(owed) || owed < 0) {
      return fail("Enter what you owe as a positive number.", "balance");
    }

    // Re-shaped into what the shared validator expects: it takes a signed
    // dollar figure, because its other callers are asset accounts.
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

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    if (!account) return fail("That account no longer exists.");
    if (accountClass(account.type) !== "liability") {
      return fail(`${account.name} is not a credit card or loan.`);
    }

    const cents = Math.round(startingBalance * 100);
    db.update(schema.accounts)
      .set({
        startingBalanceCents: cents,
        startingBalanceDate,
        // E19 — the prior anchor, on the account row. There is no import
        // batch here to hang it on, and it is the real mechanism the error
        // boundary's reassurance copy describes: one click to reverse.
        priorStartingBalanceCents: account.startingBalanceCents,
        priorStartingBalanceDate: account.startingBalanceDate,
        // DS57 — a hand-reconciled balance starts the 35-day clock, and
        // carries no provider date at all.
        balanceAsOf: null,
        balanceSource: "manual",
        updatedAt: new Date(),
      })
      .where(eq(schema.accounts.id, accountId))
      .run();

    revalidateBalanceSurfaces();
    return { status: "ok", message: `${account.name} is now ${formatCents(cents)}.` };
  } catch (err) {
    return fail(toMessage(err));
  }
}

/**
 * DS55 — REFRESH, offered only where `resolveBalanceAction` says "refresh":
 * a feed-linked account with no transaction rows. Per-row rather than a page
 * button precisely because eligibility is a per-account property (E4): a
 * page-level "Refresh balances" would silently do nothing for the Visa and
 * owe the user a sentence like "1 refreshed, 2 skipped".
 */
export async function refreshLiabilityBalanceAction(
  _prev: AccountsActionState,
  formData: FormData,
): Promise<AccountsActionState> {
  try {
    const accountId = Number(formData.get("accountId"));
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return fail("That account no longer exists.");
    }

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    if (!account) return fail("That account no longer exists.");

    if (resolveBalanceAction(account, hasAnyTransactionRows(accountId, db)) !== "refresh") {
      // Reachable from a stale tab: the row rendered with Refresh, then the
      // account grew its first transaction. Naming the alternative keeps this
      // from being a dead end.
      return fail(`${account.name} has activity of its own now, so update it with Reconcile.`);
    }

    // The balance pass lives inside syncSimpleFin so there is exactly one
    // implementation of "what does the feed say this is worth" — including
    // its bounds checks, its missing-balance-date refusal, and its prior-
    // anchor bookkeeping. This button just runs a sync.
    const outcome = await syncSimpleFin({}, db);
    revalidateBalanceSurfaces();

    if (outcome.status === "no-linked-accounts") {
      return fail("No accounts are linked to SimpleFIN yet.");
    }
    const update = outcome.balanceUpdates.find((u) => u.accountId === accountId);
    if (update) {
      return { status: "ok", message: `${account.name} is now ${formatCents(update.balanceCents)}.` };
    }
    // No update and no crash means the feed agreed with what we already had,
    // or declined to date its figure. Either way the ledger is unchanged, and
    // saying so beats a success message that implies movement.
    const warned = outcome.warnings.find((w) => w.includes(account.name));
    return warned
      ? fail(warned)
      : { status: "ok", message: `${account.name} is unchanged — the bank reports the same balance.` };
  } catch (err) {
    return fail(toMessage(err));
  }
}
