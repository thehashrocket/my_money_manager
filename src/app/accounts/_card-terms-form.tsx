"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { centsToDollarString } from "@/lib/money";
import { IDLE } from "./action-state";
import { ActionStatus } from "@/components/ledger/action-status";
import { updateCardTermsAction } from "./actions";
import { useCloseOnHide } from "@/components/ledger/use-close-on-hide";

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
 * **Toggle wrapper + remountable inner form, mirroring `ReconcileDisclosure`
 * / `ReconcileForm` in `_balance-forms.tsx` exactly (red-team finding, 3rd
 * convergence pass).** These used to be one component whose `if (!open)`
 * branch just changed what it returned — which meant `useActionState`'s
 * `state` (a stale "Updated…" or error message) and the edited `values`
 * both SURVIVED a Cancel-then-reopen, because nothing ever unmounted.
 * Splitting `CardTermsForm` out as its own component makes the disclosure
 * toggle a genuine mount/unmount boundary: closing it destroys the form's
 * hooks entirely, and reopening mounts a fresh instance that initializes
 * `values` from current props and `state` at `IDLE` — for free, with no
 * manual resync needed on the toggle button the way round 3 required.
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

type CardTerms = {
  accountId: number;
  accountName: string;
  creditLimitCents: number | null;
  minimumPaymentCents: number | null;
  paydownTargetCents: number | null;
};

export function CardTermsDisclosure(props: CardTerms) {
  const [open, setOpen] = useState(false);
  useCloseOnHide(setOpen);

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
        <span className="sr-only">{` for ${props.accountName}`}</span>
      </Button>
    );
  }

  return <CardTermsForm {...props} onClose={() => setOpen(false)} />;
}

function CardTermsForm({
  accountId,
  accountName,
  creditLimitCents,
  minimumPaymentCents,
  paydownTargetCents,
  onClose,
}: CardTerms & { onClose: () => void }) {
  const [state, formAction, pending] = useActionState(updateCardTermsAction, IDLE);

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
  // pointing at a field that no longer held the offending input. Seeded
  // once, at mount — a fresh `CardTermsForm` instance is exactly what
  // "start from what's actually stored" means now, so there is no separate
  // reopen-time resync to keep in sync with this.
  const [values, setValues] = useState<Record<FieldKey, string>>(fieldsFromProps);
  // Three unconditional `useId()` calls — hooks can't be called from inside
  // `FIELDS.map()`.
  const ids: Record<FieldKey, string> = {
    creditLimit: useId(),
    minimumPayment: useId(),
    paydownTarget: useId(),
  };

  // Re-canonicalize `values` after every SUCCESSFUL save (adversarial-review
  // finding, both Codex passes independently). The form deliberately stays
  // open after a save (only Cancel/close unmounts it — see the module
  // docstring), so `values` otherwise keeps whatever raw string the user
  // typed forever, while `snapshot` below is recomputed from props every
  // render through `centsToDollarString`, which always formats to 2 decimal
  // places. Type "50" (not "50.00"), save it, then edit ONLY a different
  // field and save again: `values.minimumPayment` is still "50" but the new
  // snapshot (from the now-updated prop) is "50.00" — different strings for
  // the same stored value — so the guard reads "50" as a fresh edit and
  // reposts it, overwriting anything a different tab wrote to that field in
  // between.
  //
  // Adjust-state-during-render, not `useEffect` — the same pattern this
  // codebase already uses for `_categorize-ui.tsx`'s `renderedGroups`/
  // `renderedBacklog` resyncs, and the one React's own lint rule
  // (`react-hooks/set-state-in-effect`) steers away from an effect for:
  // comparing against the last-rendered `state` right here means the
  // correction lands in the SAME commit as the fresh props, with no extra
  // render pass. `state` is a new object on every action return (even a
  // repeat "ok"), so `state !== renderedState` is true exactly once per
  // successful save.
  const [renderedState, setRenderedState] = useState(state);
  if (state !== renderedState) {
    setRenderedState(state);
    if (state.status === "ok") setValues(fieldsFromProps());
  }

  // The stale-tab guard (Red Team finding, card-paydown-target plan). A
  // field genuinely never appears "absent" from this form's POST — it
  // always renders and submits all three inputs — so `updateCardTermsAction`
  // cannot tell "the user left this untouched" from "the user re-confirmed
  // the same value" by presence alone. Posting each field's CURRENT prop
  // value alongside it lets the action compare posted-vs-snapshot instead:
  // unchanged from what THIS tab loaded means untouched (skip the write, so
  // a second tab's more recent save survives), changed means the user
  // edited it (write it, even if that happens to match what's already
  // stored). Recomputed fresh on every render, from props — not from
  // `values`, which the user may have since edited.
  const snapshot = fieldsFromProps();

  return (
    <form action={formAction} className="mt-2 flex w-full flex-wrap items-end gap-3">
      <input type="hidden" name="accountId" value={accountId} />
      {FIELDS.map(({ key }) => (
        <input
          key={`${key}-snapshot`}
          type="hidden"
          name={`${key}Snapshot`}
          value={snapshot[key]}
        />
      ))}
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
        // Disabled during `pending` (red-team finding, round 3): closing the
        // disclosure while a Save is still in flight would unmount this
        // form before its own write's revalidation has landed — the NEXT
        // mount would then seed `values`/`snapshot` from props that don't
        // reflect that write yet, and a save of some OTHER field in that
        // window could repost this field's pre-write value as if the user
        // had just re-typed it, clobbering the in-flight save once it does
        // land. The remount-on-reopen split above closes the "stale local
        // state survives a reopen" half of that bug; this closes the
        // "reopen too soon after an in-flight write" half.
        disabled={pending}
        onClick={onClose}
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
