"use client";

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * The busy half of every mutating control on `/sync`.
 *
 * `ActionForm` already tracks the in-flight action (`useActionState`) and even
 * declares a `children(pending)` render prop — but it has zero callers and can
 * never have one: `_review-queue.tsx` and `page.tsx` are Server Components, and
 * a function child is not serializable across the RSC boundary. `useFormStatus`
 * in a nested client component is the documented way in
 * (`node_modules/next/dist/docs/01-app/02-guides/forms.md:316`), and React 19
 * hands it `data` as well as `pending`, which is what lets a form with TWO
 * submitters tell which one fired.
 */

/**
 * The name of the field carrying which submitter was pressed.
 *
 * Written out rather than imported from `validateSyncInputs.ts`: this file and
 * `ActionForm.tsx` are the client components in this chain, and that module is
 * zod — importing it here would pull zod into the /sync route bundle, which
 * cost +376 KB the last time it happened on /transactions (see
 * `src/lib/transactions/limits.ts`). Importing it the other way is not an
 * option either: a `"use client"` module's exports reach a Server Component as
 * client references, not as the values themselves.
 *
 * So the field NAME is duplicated against a zod object key. What makes that
 * survivable is that `intent` is REQUIRED in the schema. Drift here used to be
 * silent and money-opposite — a renamed field was dropped by the non-strict
 * object, `.default("link")` filled it back in, and "Not a reversal" LINKED
 * the pair. With no default, a renamed field fails validation for BOTH
 * buttons, loudly, on the first click. See `resolveReversalInputSchema`.
 *
 * The field's VALUES are not duplicated: `LINK_INTENT`/`REJECT_INTENT` are
 * imported by the queue that renders the buttons and by the action that
 * branches on them.
 */
const INTENT_FIELD = "intent";

/**
 * Freezes every control inside it while the form's action is in flight.
 *
 * A `<fieldset disabled>` rather than `disabled` on each button, because the
 * `<select>`s ARE the payload: they name which two rows get paired. Left live,
 * a mid-flight change followed by a refusal renders the error underneath a
 * selection that was never submitted — on the only surface in this app where
 * transfers are paired by hand. One attribute covers the selects, both
 * buttons, and anything added to the form later.
 *
 * Safe only because the browser captures FormData at submit time, BEFORE
 * `pending` flips. That ordering is load-bearing: `page.tsx`'s account-link
 * form documents that a disabled `<select>` is omitted from FormData
 * entirely, so disabling one a moment too early would silently truncate the
 * payload rather than merely greying it out.
 *
 * `m-0 border-0 p-0` strips the browser's default fieldset chrome, which would
 * otherwise draw a second border inside the review-queue card. `min-w-0` stops
 * a fieldset refusing to shrink below its content's intrinsic width when it is
 * the flex/grid item.
 */
export function PendingFieldset({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();

  return (
    // `aria-busy` because the visible busy signal is a label swap on a button
    // that has just been disabled — and a name change on a disabled, blurred
    // element is announced by nothing. Without it a screen-reader user gets
    // silence for the length of a bank round-trip. `ActionStatus`'s live region
    // announces the OUTCOME; this announces that there is one coming.
    <fieldset
      disabled={pending}
      aria-busy={pending}
      className={cn("m-0 min-w-0 border-0 p-0", className)}
    >
      {children}
    </fieldset>
  );
}

/**
 * A submit button that says what it is doing.
 *
 * DISABLED whenever the form is busy, but only the button that actually fired
 * swaps to `busyLabel`. `pending` is per-FORM, and the reversal card has two
 * submitters with opposite effects on money — labelling both busy re-creates
 * exactly the confusion `_action-feedback.tsx` was written to eliminate, where
 * "Link as reversal" and "Not a reversal" produced an identical visible
 * outcome on a one-candidate bucket.
 *
 * `disabled:opacity-50` is not decoration. Four of the five controls this
 * replaces carried no `disabled:` variant at all, so setting `disabled` alone
 * changed behaviour and nothing visible.
 */
export function SubmitButton({
  label,
  busyLabel,
  className,
  intent,
  disabled,
}: {
  label: string;
  busyLabel: string;
  className?: string;
  /**
   * Set only on a non-default submitter. The value rides along as
   * `intent=<value>` when THIS button is the one that submitted, which is both
   * how the server tells the two apart and how this component does.
   */
  intent?: string;
  /** An additional reason to be unavailable, ANDed with the pending state. */
  disabled?: boolean;
}) {
  const { pending, data } = useFormStatus();

  // `FormData.get` is `string | File | null`. Narrow rather than coerce:
  // `String(null)` is the string "null", which would never match anything and
  // would fail silently.
  //
  // Both sides are normalised to `null` rather than tested for truthiness so
  // that a button with NO `intent` still identifies itself correctly — the
  // three cross-account queue reasons and the three single-submitter forms on
  // `page.tsx` are all in that case. On the reversal card both submitters name
  // themselves, so neither side is null there.
  const submitted = data?.get(INTENT_FIELD);
  const submittedIntent = typeof submitted === "string" ? submitted : null;
  const isBusy = pending && (intent ?? null) === submittedIntent;

  return (
    <button
      type="submit"
      name={intent === undefined ? undefined : INTENT_FIELD}
      value={intent}
      disabled={pending || disabled}
      className={cn(className, "disabled:cursor-not-allowed disabled:opacity-50")}
    >
      {isBusy ? busyLabel : label}
    </button>
  );
}
