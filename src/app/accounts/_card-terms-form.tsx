"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { centsToDollarString } from "@/lib/money";
import { IDLE, type AccountsActionState } from "./action-state";
import { updateCardTermsAction } from "./actions";

/**
 * The repair path for a card's credit limit and minimum payment.
 *
 * Both were write-once at account creation. A mistyped $5,000 limit made the
 * utilization bar wrong on every render forever, and the only fix was raw
 * SQL — the same gap `updateAccountAnchorAction` closed for the anchor.
 *
 * A disclosure, not a permanently-open form, for the reason
 * `ReconcileDisclosure` documents: these are the row's third and fourth
 * controls, and four expanded forms in one row is exactly the per-row clutter
 * DS52 argues against. Card details change once a year at most, so they are
 * the ones that stay folded.
 */

const LABEL = "mb-1 block font-mono text-xs uppercase tracking-wide text-ink-3";
const FIELD =
  "w-32 rounded-md border border-border bg-card px-3 py-2 text-base [font-variant-numeric:tabular-nums]";

function Status({ state }: { state: AccountsActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`mt-1 text-base ${state.status === "error" ? "text-redbrown" : "text-ledger"}`}
    >
      {state.message}
    </p>
  );
}

export function CardTermsDisclosure({
  accountId,
  accountName,
  creditLimitCents,
  minimumPaymentCents,
}: {
  accountId: number;
  accountName: string;
  creditLimitCents: number | null;
  minimumPaymentCents: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateCardTermsAction, IDLE);
  const limitId = useId();
  const minimumId = useId();

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="min-h-11 w-full sm:w-auto"
      >
        Card details
        <span className="sr-only">{` for ${accountName}`}</span>
      </Button>
    );
  }

  return (
    <form action={formAction} className="mt-2 flex w-full flex-wrap items-end gap-3">
      <input type="hidden" name="accountId" value={accountId} />
      <div>
        <label className={LABEL} htmlFor={limitId}>
          Credit limit
        </label>
        <input
          id={limitId}
          type="number"
          name="creditLimit"
          step="0.01"
          min="0"
          placeholder="none"
          /* Empty CLEARS. "I no longer want a limit recorded" has to be
             expressible, or a card gets stuck at a limit it does not have. */
          defaultValue={creditLimitCents === null ? "" : centsToDollarString(creditLimitCents)}
          aria-label={`Credit limit on ${accountName}`}
          className={FIELD}
        />
      </div>
      <div>
        <label className={LABEL} htmlFor={minimumId}>
          Minimum payment
        </label>
        <input
          id={minimumId}
          type="number"
          name="minimumPayment"
          step="0.01"
          min="0"
          placeholder="none"
          defaultValue={
            minimumPaymentCents === null ? "" : centsToDollarString(minimumPaymentCents)
          }
          aria-label={`Minimum payment on ${accountName}`}
          className={FIELD}
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(false)}
        className="min-h-11 w-full sm:w-auto"
      >
        Cancel
      </Button>
      <div className="w-full">
        <Status state={state} />
      </div>
    </form>
  );
}
