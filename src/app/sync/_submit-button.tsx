"use client";

import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
// TYPE-ONLY, and that is what keeps the bundle argument below intact: a `import
// type` is erased outright, so this pulls no zod into the /sync client chunks.
// `ActionForm.tsx` type-imports from a `"use server"` module for the same
// reason. The argument at INTENT_FIELD is about VALUES; types are free.
import type {
  ResolveIntent,
  ResolveReversalInput,
} from "@/lib/simplefin/validateSyncInputs";

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
 * So the field NAME is a literal here rather than an import of the value. The
 * `satisfies` below is what stops that being a naked string: it makes this a
 * COMPILE error the moment the schema's key is renamed, which is strictly
 * better than the runtime argument this comment used to rest on alone.
 *
 * That runtime argument still holds as the backstop, and is worth keeping
 * written down: `intent` is REQUIRED in the schema, so a field name that drifts
 * is dropped by the non-strict object and validation refuses BOTH buttons
 * loudly on the first click. It used to be silent and money-opposite —
 * `.default("link")` filled the missing key back in and "Not a reversal" LINKED
 * the pair. Note that backstop is not independent: it is the SAME protection as
 * `_INTENT_IS_REQUIRED` in `validateSyncInputs.ts`, so do not treat the two as
 * belt and braces.
 *
 * The field's VALUES are not duplicated at all: `LINK_INTENT`/`REJECT_INTENT`
 * are imported by the queue that renders the buttons and by the action that
 * branches on them.
 */
const INTENT_FIELD = "intent" satisfies keyof ResolveReversalInput;

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
    // `aria-busy` marks this subtree as mid-update. It does NOT announce
    // anything on its own — an earlier version of this comment claimed it told
    // a screen-reader user "an outcome is coming", and no screen reader does
    // that for a non-live container. What it buys is that assistive tech can
    // treat the subtree as unstable while the label swap and the `disabled`
    // flip land together.
    //
    // The gap it does NOT close: the visible busy signal is a name change on a
    // button that was just disabled and therefore blurred, which is announced
    // by nothing, so a screen-reader user still gets silence for the length of
    // the round-trip. `ActionStatus`'s live region announces the OUTCOME.
    // Announcing the START is an open follow-up, not something this attribute
    // achieved.
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
   * Set on a submitter that names itself. The value rides along as
   * `intent=<value>` when THIS button is the one that submitted, which is both
   * how the server tells the two apart and how this component does.
   *
   * `ResolveIntent`, not `string`: the type is erased at build time so it costs
   * the bundle nothing, and it turns a typo into a compile error instead of a
   * runtime `Invalid reversal pairing`. `""` was the sharp case — it is not
   * `undefined`, so it would emit `name="intent" value=""` and be refused by
   * the enum for a mistake the compiler can see.
   */
  intent?: ResolveIntent;
  /**
   * An additional reason to be unavailable, ORed with the pending state — the
   * button is disabled if EITHER holds. (It read "ANDed" until v0.22.0, which
   * describes the opposite behaviour and would make the account-link form's
   * `disabled={!host || remote.length === 0}` a no-op whenever no action is in
   * flight, i.e. essentially always.)
   */
  disabled?: boolean;
}) {
  const { pending, data } = useFormStatus();

  // `FormData.get` is `string | File | null`. Narrow rather than coerce:
  // `String(null)` is the string "null", which would never match anything and
  // would fail silently.
  //
  // Both sides are normalised to `null` rather than compared directly, so that
  // a button with NO `intent` still identifies itself correctly. The three
  // single-submitter forms on `page.tsx` — Save, Undo this sync, and the
  // unlink button — are the ones in that case, and they are the whole reason
  // this is not the obvious `intent === submittedIntent`: that spelling is
  // `undefined === null`, which is FALSE, so all three would silently stop
  // swapping to their busy label.
  //
  // The review-queue buttons are NOT in that case, despite what an earlier
  // version of this comment claimed. `_review-queue.tsx` passes `intent`
  // unconditionally, for every one of the five bucket reasons — so a
  // cross-account card's primary carries `intent=link` too, posted to an action
  // whose schema has no such key and strips it. On the reversal card both
  // submitters name themselves, so neither side is null there either.
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
