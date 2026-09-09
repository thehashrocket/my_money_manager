"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountClass } from "@/lib/accounts/accountClass";
import { hasAnyTransactionRows } from "@/lib/accounts/hasAnyTransactionRows";
import { isCreditCard } from "@/lib/accounts/isCreditCard";
import { resolveBalanceAction } from "@/lib/accounts/resolveBalanceAction";
import {
  createCardActivity,
  markAsCardPayment,
  removeCardActivity,
  unmarkCardPayment,
} from "@/lib/accounts/manualTransaction";
import type { AccountsActionState, CardActivityState } from "./action-state";
import { validateUpdateAnchorInput } from "@/lib/import/validateUpdateAnchorInput";
import { validateCardTermsInput } from "@/lib/accounts/validateCardTermsInput";
import {
  STARTING_BALANCE_DOLLARS_MAX,
  owedDollarsToSignedCents,
} from "@/lib/import/accountAnchorFields";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/now";
import { guardRefresh } from "@/lib/revalidateAfterWrite";
import { refreshLiabilityBalancesOnly } from "@/lib/simplefin/sync";

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
 *
 * RETURNS A WARNING, AND CANNOT THROW. That is the load-bearing part, and it
 * is what makes T28/E20's promise at the top of this file true rather than
 * merely stated. Every action here wraps its WHOLE body — this call included —
 * in one `try` whose `catch` returns `fail(...)`. `revalidatePath` throws, so
 * an unguarded call inside that `try` converts an ALREADY-COMMITTED write into
 * `{status:"error"}`: the contract this file exists to keep, broken by the
 * refresh that follows the write it is keeping the contract about.
 *
 * The concrete harm is rule 9's, and it is not a stale page:
 *
 *   reconcile $1,200 ─▶ UPDATE commits, prior := 1200 ─▶ revalidate throws
 *        ▶ inline form says "failed"
 *        ▶ user resubmits, believing nothing saved
 *        ▶ second UPDATE reads the row the FIRST one wrote
 *        ▶ prior := 500 — the value from the "failed" attempt
 *        ▶ the true prior anchor no longer exists anywhere
 *
 * `prior_starting_balance_*` is ONE slot (rule 9), so that is the whole undo,
 * spent on a figure that was never current. CLAUDE.md documents exactly this
 * harm for the feed's balance pass; this is the same harm on the hand path,
 * reached through the refresh rather than through a race.
 *
 * Because `guardRefresh` cannot throw, the enclosing `try/catch` in every
 * caller is now unreachable from this call, and each caller folds the returned
 * warning into its `ok` outcome instead. A caller that DISCARDS the return
 * makes a failed refresh silent again.
 */
function revalidateBalanceSurfaces(): string | undefined {
  return guardRefresh("/accounts", () => {
    for (const p of ["/accounts", "/", "/import", "/sync", "/transactions", "/categorize", "/budget"]) {
      revalidatePath(p);
    }
  });
}

/**
 * The card-activity variant: the balance surfaces plus the month view, because
 * a charge changes an envelope's spend. One guarded pass rather than two, so a
 * failure in either half produces one warning.
 */
function revalidateCardActivitySurfaces(): string | undefined {
  return guardRefresh("/accounts", () => {
    for (const p of ["/accounts", "/", "/import", "/sync", "/transactions", "/categorize", "/budget"]) {
      revalidatePath(p);
    }
    revalidatePath("/budget/[year]/[month]", "page");
  });
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

    // NOTHING MOVED, SO DON'T SPEND THE UNDO ON IT.
    //
    // `prior_starting_balance_*` holds exactly one step of history (rule 9),
    // and the write below overwrites it unconditionally — so a save that
    // changes nothing used to destroy the real previous anchor and leave the
    // row offering "Undo — back to <today>", restoring the number already on
    // screen.
    //
    // SCOPE, precisely: this fires when the balance AND the date both match,
    // which is a double-submit, a stale resubmit, or a same-day re-save. It
    // does NOT fire on the open-look-Save flow when the account was last
    // anchored on an earlier date, because the form defaults `asOf` to today
    // and re-dating the same figure is a genuine assertion — "I confirm I
    // still owe this, as of today" — which moves the anchor under rule 1's
    // strict `>` and legitimately earns a prior-anchor record.
    //
    // The feed's balance pass has had this guard from the start
    // (`refreshLiabilityBalances`: "Nothing moved; do not manufacture a
    // report."). This is the same check on the hand-entered path.
    if (
      cents === account.startingBalanceCents &&
      startingBalanceDate === account.startingBalanceDate
    ) {
      return { status: "ok", message: `${account.name} is unchanged.` };
    }

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

    const warning = revalidateBalanceSurfaces();
    return { status: "ok", message: `${account.name} is now ${formatCents(cents)}.`, warning };
  } catch (err) {
    return fail(toMessage(err));
  }
}

/**
 * E19 — put the previous balance back.
 *
 * `updateLiabilityBalanceAction` and the sync balance pass both record the
 * anchor they replaced, on the account row. Until this existed nothing ever
 * READ those two columns, so `/accounts/error.tsx`'s promise that "the
 * previous balance and date are kept, so the change is one step to reverse"
 * described a mechanism with no button attached to it — the data was there
 * and the user had no way to reach it short of raw SQL.
 *
 * SWAPS rather than clears. Putting the current anchor into the prior slot as
 * it restores means the undo is itself undoable, and a mis-click costs one
 * more click rather than the number you just replaced. A single-valued
 * column can hold exactly one step of history either way; a swap spends it on
 * the step the user is most likely to want.
 */
export async function revertLiabilityBalanceAction(
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
    if (accountClass(account.type) !== "liability") {
      return fail(`${account.name} is not a credit card or loan.`);
    }
    // Reachable from a stale tab: the row rendered with an undo, then another
    // tab reverted it. Naming the state rather than failing blankly.
    if (
      account.priorStartingBalanceCents === null ||
      account.priorStartingBalanceDate === null
    ) {
      return fail(`${account.name} has no previous balance to go back to.`);
    }

    db.update(schema.accounts)
      .set({
        startingBalanceCents: account.priorStartingBalanceCents,
        startingBalanceDate: account.priorStartingBalanceDate,
        priorStartingBalanceCents: account.startingBalanceCents,
        priorStartingBalanceDate: account.startingBalanceDate,
        // The restored figure is a hand-set one however it got here, so it
        // carries no provider date and starts DS57's 35-day manual clock.
        balanceAsOf: null,
        balanceSource: "manual",
        updatedAt: new Date(),
      })
      .where(eq(schema.accounts.id, accountId))
      .run();

    const warning = revalidateBalanceSurfaces();
    // Names the restored ANCHOR date, not a dollar figure: what is stored is
    // the anchor, what the row shows is the derived balance, and they differ
    // whenever activity was entered between the two reconciles.
    return {
      status: "ok",
      message: `${account.name} is back to where it was on ${account.priorStartingBalanceDate}.`,
      warning,
    };
  } catch (err) {
    return fail(toMessage(err));
  }
}

/**
 * The repair path for a card's terms — its credit limit and minimum payment.
 *
 * Both were write-once at account creation, so a mistyped $5,000 limit made
 * the utilization bar wrong on every render forever and the only fix was raw
 * SQL. That is the same gap CLAUDE.md rule 1 closed for `starting_balance_*`
 * with `updateAccountAnchorAction`; a number the user typed once and can
 * never correct is a bug regardless of how small the number is.
 *
 * Cards only, enforced here and not merely by where the form renders (D2=A).
 * A mortgage row draws no utilization bar and shows no minimum payment, so
 * storing either on one would persist a figure nothing ever reads.
 *
 * An empty field CLEARS the value rather than leaving it. "I no longer want a
 * limit recorded" has to be expressible, and a form that can only ever raise
 * a number is how you get a card stuck at a limit it does not have.
 */
export async function updateCardTermsAction(
  _prev: AccountsActionState,
  formData: FormData,
): Promise<AccountsActionState> {
  try {
    const raw = Object.fromEntries(formData);
    const accountId = Number(raw.accountId);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return fail("That account no longer exists.");
    }

    const parsed = validateCardTermsInput({
      creditLimit: raw.creditLimit,
      minimumPayment: raw.minimumPayment,
    });
    if (!parsed.success) {
      const onLimit = parsed.error.issues[0]?.path.includes("creditLimit");
      return fail(
        onLimit
          ? "Enter a credit limit this app accepts, or leave it blank."
          : "Enter a minimum payment this app accepts, or leave it blank.",
        "balance",
      );
    }

    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    if (!account) return fail("That account no longer exists.");
    if (!isCreditCard(account.type)) {
      return fail(`${account.name} is not a credit card.`);
    }

    // ABSENT IS NOT THE SAME AS EMPTY, and only one of them clears.
    //
    // `optionalPositiveDollarsSchema` is `.nullish()`, so a field missing from
    // the request parsed to `null` exactly like an emptied one — making this
    // endpoint destructive by omission. A POST carrying only `accountId` and
    // `creditLimit` silently NULLed the minimum payment.
    //
    // Empty-clears is deliberate and documented ("I no longer want a limit
    // recorded" has to be expressible). Absent-clears was an accident of the
    // same schema serving both, and it is the same absent-vs-zero distinction
    // rule 9 insists on one field over. The form always posts both, so this
    // only ever fires for a hand-made request.
    const patch: Partial<typeof schema.accounts.$inferInsert> = { updatedAt: new Date() };
    if (raw.creditLimit !== undefined) patch.creditLimitCents = parsed.data.creditLimitCents;
    if (raw.minimumPayment !== undefined) {
      patch.minimumPaymentCents = parsed.data.minimumPaymentCents;
    }

    db.update(schema.accounts).set(patch).where(eq(schema.accounts.id, accountId)).run();

    const warning = revalidateBalanceSurfaces();
    return { status: "ok", message: `Updated ${account.name}'s card details.`, warning };
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
    // Server-side, not merely by where the button renders — the same argument
    // `assetAccountGuard` and `requireCardAccount` make. `resolveBalanceAction`
    // answers "refresh" for ANY zero-row feed-linked account, assets included,
    // but the balance pass only ever considers liabilities. Without this, a
    // posted checking-account id sails past the gate below, finds no update
    // and no warning, and gets told "unchanged — the bank reports the same
    // balance" about an account the pass never looked at.
    if (accountClass(account.type) !== "liability") {
      return fail(`${account.name} is not a credit card or loan.`);
    }

    if (resolveBalanceAction(account, hasAnyTransactionRows(accountId, db)) !== "refresh") {
      // Reachable from a stale tab: the row rendered with Refresh, then the
      // account grew its first transaction. Naming the alternative keeps this
      // from being a dead end.
      return fail(`${account.name} has activity of its own now, so update it with Reconcile.`);
    }

    // The BALANCE PASS ONLY. This used to call `syncSimpleFin({})` — the
    // entire import — so one click on the mortgage row pulled 45 days of
    // checking transactions, wrote a snapshot and an undoable batch, ran
    // auto-categorization and the transfer matcher, and then reported a single
    // balance. `refreshLiabilityBalancesOnly` shares the same anchor-writing
    // code (its bounds checks, its missing-date refusal, its sign guard and
    // its prior-anchor bookkeeping), so there is still exactly one
    // implementation of "what does the feed say this is worth".
    // Scoped to THIS account. Left unscoped, a per-row button moved every
    // feed-linked zero-row liability's anchor — spending each one's single
    // undo slot — and `outcome.warnings` became the union across all of them,
    // so refreshing the mortgage could render a warning about the Visa in red
    // under the mortgage's own button.
    const outcome = await refreshLiabilityBalancesOnly({ accountId }, db);
    // Held rather than folded immediately: the branches below can still refuse
    // (`no-linked-accounts`, or a warning-only outcome), and a refresh warning
    // belongs only on the branches that report a WRITE. Attaching it to a
    // refusal would claim something was saved.
    const refreshWarning = revalidateBalanceSurfaces();

    if (outcome.status === "no-linked-accounts") {
      return fail("No accounts are linked to SimpleFIN yet.");
    }

    const update = outcome.updates.find((u) => u.accountId === accountId);
    if (update) {
      // Warnings can accompany a SUCCESSFUL write — the credit-balance notice
      // is the case, and it is exactly the moment its "if that is wrong, use
      // Reconcile" copy was written for. Reporting only in the no-update
      // branch swallowed it precisely when it mattered.
      const note = outcome.warnings.length > 0 ? ` ${outcome.warnings.join(" ")}` : "";
      return {
        status: "ok",
        message: `${account.name} is now ${formatCents(update.balanceCents)}.${note}`,
        warning: refreshWarning,
      };
    }

    // NO UPDATE IS NOT AUTOMATICALLY SUCCESS. The old code matched warnings by
    // `w.includes(account.name)` and, finding none, claimed "the bank reports
    // the same balance" — a positive factual claim about the bank that a
    // failed connection never established. Substring matching also
    // mis-attributed: refreshing "Visa" would surface a warning about "Visa
    // Signature". Any warning at all means this refresh cannot be described as
    // a clean no-op, so report it rather than narrating past it.
    if (outcome.warnings.length > 0) {
      return fail(outcome.warnings.join(" "));
    }
    return {
      status: "ok",
      message: `${account.name} is unchanged — the bank reports the same balance.`,
      warning: refreshWarning,
    };
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

    // A charge changes an envelope's spend, so the month view goes too — see
    // `revalidateCardActivitySurfaces`, which folds both into one guarded pass.
    const warning = revalidateCardActivitySurfaces();
    return { status: "ok", message: result.message, warning };
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
    const warning = revalidateCardActivitySurfaces();
    return { status: "ok", message: result.message, warning };
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
    const warning = revalidateCardActivitySurfaces();
    return { status: "ok", message: result.message, warning };
  } catch (err) {
    return { status: "error", message: toMessage(err) };
  }
}

/**
 * The way back from `addCardActivityAction`, which had none.
 *
 * Deliberately NOT on `/accounts`, where the charge is entered: `/accounts`
 * renders account rows, and this operates on a TRANSACTION. It is offered from
 * the `/transactions` row menu, beside "Not a card payment" — the row is the
 * thing being removed, and that menu is already where a card row's per-row
 * repairs live. `removeCardActivity` refuses everything the menu would not
 * have offered anyway (E17 and the four guards on its docblock), because a
 * Server Action is a network endpoint regardless of what rendered.
 */
export async function removeCardActivityAction(
  _prev: CardActivityState,
  formData: FormData,
): Promise<CardActivityState> {
  try {
    const transactionId = Number(formData.get("transactionId"));
    if (!Number.isInteger(transactionId)) {
      return { status: "error", message: "That transaction no longer exists." };
    }
    const result = removeCardActivity({ transactionId }, db);
    if (result.status === "refused") {
      return { status: "error", message: result.message, reason: result.reason };
    }
    // Removing the LAST row on a card makes it eligible for the feed balance
    // pass again (`hasAnyTransactionRows`), so `/accounts` and `/sync` both
    // render differently afterwards — the balance surfaces are not optional
    // here even though this is a transaction-level write.
    const warning = revalidateCardActivitySurfaces();
    return { status: "ok", message: result.message, warning };
  } catch (err) {
    return { status: "error", message: toMessage(err) };
  }
}
