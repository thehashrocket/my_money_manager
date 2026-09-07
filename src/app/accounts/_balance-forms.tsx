"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { centsToDollarString } from "@/lib/money";
import { formatMonthDay } from "@/lib/now";
import { IDLE, type AccountsActionState } from "./action-state";
import {
  refreshLiabilityBalanceAction,
  revertLiabilityBalanceAction,
  updateLiabilityBalanceAction,
} from "./actions";

/**
 * The two per-row balance controls. Separate components rather than one with
 * a mode prop: DS55 makes them mutually exclusive by construction, and a row
 * renders exactly one of them (chosen by `resolveBalanceAction`, which is
 * total over its inputs — never both, never neither).
 *
 * Both hold their outcome as returned state (E20). A thrown action would
 * unmount the route and take the typed balance with it.
 */

function Status({ state }: { state: AccountsActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`mt-1 text-base ${
        state.status === "error" ? "text-redbrown" : "text-ledger"
      }`}
    >
      {state.message}
    </p>
  );
}

/**
 * A disclosure, not a permanently-open form. The layout spec renders
 * `Reconcile` as a row ACTION; two expanded forms stacked in one panel is the
 * per-row clutter DS52 argues against for the same reason. It also keeps the
 * balances the loudest thing on the page, which is the only actionable
 * content on it.
 */
export function ReconcileDisclosure(props: {
  accountId: number;
  accountName: string;
  balanceCents: number;
  today: string;
  /** DS56 — arrive open and focused, from "Reconcile instead →". */
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.startOpen ?? false);

  if (!open) {
    return (
      <div className="mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          /* DS66 — 44px minimum touch target, and full width below `sm` so
             the row's actions stack rather than crowd (DS65). */
          className="min-h-11 w-full sm:w-auto"
        >
          Reconcile
        </Button>
        <span className="sr-only">{`Set the balance owed on ${props.accountName}`}</span>
      </div>
    );
  }
  return <ReconcileForm {...props} autoFocus />;
}

export function ReconcileForm({
  accountId,
  accountName,
  balanceCents,
  today,
  autoFocus = false,
}: {
  accountId: number;
  accountName: string;
  balanceCents: number;
  today: string;
  autoFocus?: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateLiabilityBalanceAction, IDLE);
  // CONTROLLED, for the reason `CardTermsDisclosure` documents: React 19
  // unconditionally resets a form submitted through a function action
  // (`requestFormReset`, verified in react-dom 19.2.8), so an uncontrolled
  // input snaps back to its `defaultValue` on every submit — including a
  // REJECTED one. Both fields here were uncontrolled, so rejecting a
  // future-dated reconcile bounced the date back to today (now valid) and the
  // typed balance back to the stored figure, while the error "That date is in
  // the future" sat under a date field showing today and `aria-invalid` marked
  // the field it had just emptied. That is the same bug the create-account and
  // card-terms forms were fixed for; these two were missed.
  const [balanceOwed, setBalanceOwed] = useState(centsToDollarString(Math.abs(balanceCents)));
  const [asOf, setAsOf] = useState(today);

  // RESYNC WHEN THE BALANCE MOVES UNDERNEATH AN UNTOUCHED FIELD.
  //
  // Going controlled fixed the rejected-submit wipe but broke something the
  // uncontrolled version got for free: React updates a `defaultValue` on the
  // DOM node when the prop changes, and the browser re-displays it as long as
  // the input's dirty-value flag is clear — so a field the user never typed
  // into tracked the real balance. `useState` initialises once, and this form
  // is NOT remounted when the balance changes (`_card-controls.tsx` keys it on
  // `handoff` alone, and `revalidateBalanceSurfaces` deliberately avoids
  // `revalidatePath("/", "layout")` so client state survives).
  //
  // The failure that made this worth fixing is silent and expensive: open
  // Reconcile on a card at -$2,000 and leave it open; add an $80 charge from
  // the same row; then Save the still-open form. It posts the stale $2,000 as
  // of today, and rule 1's strict `>` drops the just-entered charge out of the
  // balance sum entirely. Money typed, accepted, and then quietly gone.
  //
  // Guarded on `touched` so it never overwrites what someone is in the middle
  // of typing, and written as the "adjust state during render" pattern this
  // codebase already uses in `_charge-dialog.tsx` and `_month-editor.tsx`.
  const [touched, setTouched] = useState(false);
  const [seenBalanceCents, setSeenBalanceCents] = useState(balanceCents);
  if (balanceCents !== seenBalanceCents) {
    setSeenBalanceCents(balanceCents);
    if (!touched) setBalanceOwed(centsToDollarString(Math.abs(balanceCents)));
  }
  const balanceId = useId();
  const dateId = useId();
  const balanceRef = useRef<HTMLInputElement>(null);

  // DS56/DS66 — "Reconcile instead →" must actually land the user in the
  // field they were sent here for. A handoff that silently relocates someone
  // is worse than the refusal it fixes.
  useEffect(() => {
    if (autoFocus) balanceRef.current?.focus();
  }, [autoFocus]);

  return (
    <form
      action={formAction}
      /* `w-full` so the expanded form claims its own row inside CardControls'
         wrapping flex container rather than sitting beside "Add a charge". */
      className="mt-2 flex w-full flex-wrap items-end gap-3"
    >
      <input type="hidden" name="accountId" value={accountId} />
      <div>
        <label
          className="mb-1 block font-mono text-xs uppercase tracking-wide text-ink-3"
          htmlFor={balanceId}
        >
          Balance owed
        </label>
        <input
          ref={balanceRef}
          id={balanceId}
          type="number"
          name="balanceOwed"
          step="0.01"
          min="0"
          required
          // The user never types a minus sign. The stored value is negative;
          // this field shows and takes the magnitude (DS64, DS61).
          value={balanceOwed}
          onChange={(e) => {
            setTouched(true);
            setBalanceOwed(e.target.value);
          }}
          aria-label={`Balance owed on ${accountName}`}
          aria-invalid={state.status === "error" && state.field === "balance"}
          className="w-32 rounded-md border border-border bg-card px-3 py-2 text-base [font-variant-numeric:tabular-nums]"
        />
      </div>
      <div>
        <label
          className="mb-1 block font-mono text-xs uppercase tracking-wide text-ink-3"
          htmlFor={dateId}
        >
          As of
        </label>
        <input
          id={dateId}
          type="date"
          name="asOf"
          required
          max={today}
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          aria-invalid={state.status === "error" && state.field === "date"}
          className="rounded-md border border-border bg-card px-3 py-2 text-base"
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        className="min-h-11 w-full sm:w-auto"
      >
        {pending ? "Saving…" : "Save"}
      </Button>
      <div className="w-full">
        <Status state={state} />
      </div>
    </form>
  );
}

export function RefreshButton({
  accountId,
  accountName,
}: {
  accountId: number;
  accountName: string;
}) {
  const [state, formAction, pending] = useActionState(refreshLiabilityBalanceAction, IDLE);
  return (
    <form action={formAction}>
      <input type="hidden" name="accountId" value={accountId} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        className="min-h-11 w-full sm:w-auto"
      >
        {pending ? "Refreshing…" : "Refresh"}
      </Button>
      <span className="sr-only">{`Refresh ${accountName}'s balance from the bank`}</span>
      <Status state={state} />
    </form>
  );
}

/**
 * E19 — "Undo" beside a balance that has a previous value recorded.
 *
 * The prior anchor was written on every reconcile from the start, and read by
 * nothing, so `/accounts/error.tsx` promised "one step to reverse" with no
 * control anywhere that could take that step. This is the control.
 *
 * Renders only when there IS a previous balance, so it appears the moment a
 * balance is first corrected rather than sitting inert on a fresh account.
 *
 * The button names the DATE it goes back to, not a dollar figure, and that is
 * deliberate. What is stored is the prior ANCHOR; what the row displays is the
 * derived balance (anchor + every row dated after the anchor date). Those are
 * the same number only when no activity was entered between the two
 * reconciles — and `createCardActivity` refuses rows on or before the anchor,
 * so every hand-entered charge lands after it and makes them differ. Printing
 * the anchor as "back to $2,000.00" would promise a figure the refreshed row
 * then contradicts. The date is unambiguous, and the row shows the real
 * balance a moment later.
 */
export function RevertBalanceButton({
  accountId,
  accountName,
  priorBalanceDate,
}: {
  accountId: number;
  accountName: string;
  priorBalanceDate: string;
}) {
  const [state, formAction, pending] = useActionState(revertLiabilityBalanceAction, IDLE);
  const asOf = formatMonthDay(priorBalanceDate);
  return (
    <form action={formAction}>
      <input type="hidden" name="accountId" value={accountId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        className="min-h-11 w-full sm:w-auto"
      >
        {pending ? "Going back…" : `Undo — back to ${asOf}`}
      </Button>
      <span className="sr-only">
        {`Put ${accountName}'s balance back to what it was on ${asOf}`}
      </span>
      <Status state={state} />
    </form>
  );
}
