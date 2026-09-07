"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountClass } from "@/lib/accounts/accountClass";
import { hasAnyTransactionRows } from "@/lib/accounts/hasAnyTransactionRows";
import { resolveBalanceAction } from "@/lib/accounts/resolveBalanceAction";
import {
  createCardActivity,
  markAsCardPayment,
  unmarkCardPayment,
} from "@/lib/accounts/manualTransaction";
import type { AccountsActionState, CardActivityState } from "./action-state";
import { validateUpdateAnchorInput } from "@/lib/import/validateUpdateAnchorInput";
import {
  STARTING_BALANCE_DOLLARS_MAX,
  owedDollarsToSignedCents,
} from "@/lib/import/accountAnchorFields";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/now";
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
    // Checked before `Number()`, because `Number("")` and `Number(null)` are
    // both 0 — finite and >= 0, so the guard below would pass and silently
    // reconcile the card to a $0 balance owed. The form's `required` is
    // client-side only; a Server Action is a network endpoint.
    if (raw.balanceOwed === undefined || String(raw.balanceOwed).trim() === "") {
      return fail("Enter what you owe as a positive number.", "balance");
    }
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

    // Shared with account creation, so the two paths cannot round a
    // half-cent in opposite directions. `startingBalance` is already the
    // negated signed figure the validator bounds-checked, so re-derive the
    // owed magnitude to hand the helper the positive number it expects.
    const cents = owedDollarsToSignedCents(-startingBalance);
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

/**
 * D10 path 2 (DS67) — a hand-entered charge or refund on a card.
 *
 * Carries `reason` through to the client, because DS56's "Reconcile instead →"
 * recovery must only appear for the D12 before-anchor refusal — offering it
 * after "enter an amount greater than zero" would be noise.
 */
export async function addCardActivityAction(
  _prev: CardActivityState,
  formData: FormData,
): Promise<CardActivityState> {
  try {
    const raw = Object.fromEntries(formData);
    const accountId = Number(raw.accountId);
    const categoryId = Number(raw.categoryId);
    const amount = Number(raw.amount);
    const kind = raw.kind === "refund" ? "refund" : "charge";

    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { status: "error", message: "That account no longer exists." };
    }
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      // D13=B depends on this: an uncategorized charge lands in the backlog
      // instead of in an envelope, and card spending stops being visible to
      // the budget for that row.
      return { status: "error", message: "Pick a category for this charge." };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { status: "error", message: "Enter an amount greater than zero." };
    }
    // Upper bound, shared with every other money writer in the app. Without
    // it, `amount=1e12` produced a 1e14-cent row that permanently skewed the
    // card balance, net worth and its envelope's spend; larger values reached
    // better-sqlite3's int64 bind and surfaced as an opaque RangeError rather
    // than a message. `min="0.01"` on the input is client-side only.
    if (amount > STARTING_BALANCE_DOLLARS_MAX) {
      return { status: "error", message: "That amount is larger than this app accepts." };
    }
    // Capped at today for the same reason `validateUpdateAnchorInput` caps the
    // anchor: a future-dated row inflates the card balance against activity
    // that has not happened yet. The dialog sets `max={today}`, but a Server
    // Action is reachable regardless of what the form rendered.
    if (String(raw.date ?? "") > todayIso()) {
      return { status: "error", message: "That date is in the future." };
    }

    const result = createCardActivity(
      {
        kind,
        accountId,
        date: String(raw.date ?? ""),
        amountCents: Math.round(amount * 100),
        merchant: String(raw.merchant ?? ""),
        categoryId,
      },
      db,
    );

    if (result.status === "refused") {
      return { status: "error", message: result.message, reason: result.reason };
    }

    revalidateBalanceSurfaces();
    // A charge changes an envelope's spend, so the month view has to go too.
    revalidatePath("/budget/[year]/[month]", "page");
    return { status: "ok", message: result.message };
  } catch (err) {
    return { status: "error", message: toMessage(err) };
  }
}

/** D10 path 1 — mark an existing debit as a payment to a card. */
export async function markAsCardPaymentAction(
  _prev: CardActivityState,
  formData: FormData,
): Promise<CardActivityState> {
  try {
    const transactionId = Number(formData.get("transactionId"));
    const cardAccountId = Number(formData.get("cardAccountId"));
    if (!Number.isInteger(transactionId) || !Number.isInteger(cardAccountId)) {
      return { status: "error", message: "That transaction no longer exists." };
    }

    const result = markAsCardPayment({ transactionId, cardAccountId }, db);
    if (result.status === "refused") {
      return { status: "error", message: result.message, reason: result.reason };
    }
    revalidateBalanceSurfaces();
    revalidatePath("/budget/[year]/[month]", "page");
    return { status: "ok", message: result.message };
  } catch (err) {
    return { status: "error", message: toMessage(err) };
  }
}

/**
 * E12 — the inverse of the above, and the operation DS61 string 16's 10-second
 * Undo performs. NOT `unlinkTransferPair`: see `unmarkCardPayment`.
 */
export async function unmarkCardPaymentAction(
  _prev: CardActivityState,
  formData: FormData,
): Promise<CardActivityState> {
  try {
    const transactionId = Number(formData.get("transactionId"));
    if (!Number.isInteger(transactionId)) {
      return { status: "error", message: "That transaction no longer exists." };
    }
    const result = unmarkCardPayment({ transactionId }, db);
    if (result.status === "refused") {
      return { status: "error", message: result.message, reason: result.reason };
    }
    revalidateBalanceSurfaces();
    revalidatePath("/budget/[year]/[month]", "page");
    return { status: "ok", message: result.message };
  } catch (err) {
    return { status: "error", message: toMessage(err) };
  }
}
