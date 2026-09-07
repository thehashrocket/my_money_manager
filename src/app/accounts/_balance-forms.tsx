"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { centsToDollarString } from "@/lib/money";
import { IDLE, type AccountsActionState } from "./action-state";
import { refreshLiabilityBalanceAction, updateLiabilityBalanceAction } from "./actions";

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
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!open) {
    return (
      <div className="mt-2">
        <Button
          ref={triggerRef}
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
          defaultValue={centsToDollarString(Math.abs(balanceCents))}
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
          defaultValue={today}
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
