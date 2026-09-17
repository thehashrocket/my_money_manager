"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { centsToDollarString } from "@/lib/money";
import { IDLE } from "./action-state";
import { ActionStatus } from "@/components/ledger/action-status";
import { updateCardTermsAction } from "./actions";

/**
 * The repair path for a card's credit limit, minimum payment, and monthly
 * paydown goal.
 *
 * Credit limit and minimum payment were write-once at account creation. A
 * mistyped $5,000 limit made the utilization bar wrong on every render
 * forever, and the only fix was raw SQL — the same gap
 * `updateAccountAnchorAction` closed for the anchor. The paydown goal
 * (card-paydown-target plan) has no creation-time counterpart at all — it is
 * edit-only from the start, and it's the one field here with no bank-facing
 * meaning of its own: it's a number you set and compare against
 * `paidDownCents` (the actual money moved) on `/accounts`.
 *
 * A disclosure, not a permanently-open form, for the reason
 * `ReconcileDisclosure` documents: these are the row's third and fourth
 * controls, and four expanded forms in one row is exactly the per-row clutter
 * DS52 argues against. Card details change once a year at most, so they are
 * the ones that stay folded.
 *
 * All three fields share one shape (a dollar amount where "" means CLEAR,
 * not zero — see `optionalPositiveDollarsSchema`), so they're driven off one
 * `FIELDS` config and one values-object `useState` rather than three
 * hand-written copies. What's NOT shared: `updateCardTermsAction`'s
 * absent-vs-empty write guard is still three separate `if` checks server
 * side, because that guard's whole point is per-field independence — a
 * single loop there would reintroduce the exact "all three POSTed or none
 * of them are safe" coupling the guard exists to avoid.
 */

const LABEL = "mb-1 block font-mono text-xs uppercase tracking-wide text-ink-3";
const FIELD =
  "w-32 rounded-md border border-border bg-card px-3 py-2 text-base [font-variant-numeric:tabular-nums]";

type FieldKey = "creditLimit" | "minimumPayment" | "paydownTarget";

/** `key` doubles as the FormData field name — must match
 *  `validateCardTermsInput.ts`'s `cardTermsInputSchema` keys exactly. */
const FIELDS: { key: FieldKey; label: string }[] = [
  { key: "creditLimit", label: "Credit limit" },
  { key: "minimumPayment", label: "Minimum payment" },
  { key: "paydownTarget", label: "Monthly paydown goal" },
];

export function CardTermsDisclosure({
  accountId,
  accountName,
  creditLimitCents,
  minimumPaymentCents,
  paydownTargetCents,
}: {
  accountId: number;
  accountName: string;
  creditLimitCents: number | null;
  minimumPaymentCents: number | null;
  paydownTargetCents: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateCardTermsAction, IDLE);

  // Recomputed (not memoized) on every call: the initial mount AND every
  // Cancel click need the CURRENT prop values, not whatever was true when
  // this component first rendered.
  function fieldsFromProps(): Record<FieldKey, string> {
    return {
      creditLimit: creditLimitCents === null ? "" : centsToDollarString(creditLimitCents),
      minimumPayment:
        minimumPaymentCents === null ? "" : centsToDollarString(minimumPaymentCents),
      paydownTarget: paydownTargetCents === null ? "" : centsToDollarString(paydownTargetCents),
    };
  }

  // CONTROLLED. React 19 resets a form submitted through a function action,
  // so uncontrolled inputs snap back to `defaultValue` on every submit —
  // including a rejected one, which would revert the user's typed limit to
  // the stored value while the error message about it stayed on screen,
  // pointing at a field that no longer held the offending input.
  const [values, setValues] = useState<Record<FieldKey, string>>(fieldsFromProps);
  // Three unconditional `useId()` calls, same as before the extraction —
  // hooks can't be called from inside `FIELDS.map()`.
  const ids: Record<FieldKey, string> = {
    creditLimit: useId(),
    minimumPayment: useId(),
    paydownTarget: useId(),
  };

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
      {FIELDS.map(({ key, label }) => (
        <div key={key}>
          <label className={LABEL} htmlFor={ids[key]}>
            {label}
          </label>
          <input
            id={ids[key]}
            type="number"
            name={key}
            step="0.01"
            min="0"
            placeholder="none"
            /* Empty CLEARS this field. "I no longer want a limit/goal
               recorded" has to be expressible, or a card gets stuck at a
               figure it does not have. */
            value={values[key]}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            aria-label={`${label} on ${accountName}`}
            className={FIELD}
          />
        </div>
      ))}
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
        onClick={() => {
          // Discard edits along with the disclosure, so reopening shows what
          // is actually stored rather than an abandoned draft.
          setValues(fieldsFromProps());
          setOpen(false);
        }}
        className="min-h-11 w-full sm:w-auto"
      >
        Cancel
      </Button>
      <div className="w-full">
        <ActionStatus state={state} />
      </div>
    </form>
  );
}
