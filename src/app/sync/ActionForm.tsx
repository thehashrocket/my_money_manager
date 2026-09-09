"use client";

import { useActionState } from "react";
import { useActionFeedback } from "./_action-feedback";
import type { SyncActionState } from "./actions";

const INITIAL: SyncActionState = { status: "idle" };

/**
 * Wraps a Server Action in useActionState so its returned outcome lands next to
 * the form instead of being discarded (or, when the action used to throw,
 * taking out the whole route). Used by every mutating form on /sync.
 */
export function ActionForm({
  action,
  className,
  ariaLabelledBy,
  announceSuccess,
  children,
}: {
  action: (
    prev: SyncActionState,
    formData: FormData,
  ) => Promise<SyncActionState>;
  className?: string;
  /**
   * Id of the element naming this form. The review queues render up to a dozen
   * structurally identical forms on one page whose only distinguishing text is
   * a date and an amount, so without this every control announces the same two
   * names over and over with nothing saying which decision is in focus.
   */
  ariaLabelledBy?: string;
  /**
   * Set on a form that can DISAPPEAR when it succeeds. Three of them: the
   * review queues (a resolved bucket leaves the list on the revalidate that
   * follows), the unlink form (its `<li>` leaves `linkedPairs`), and the undo
   * form (its section is gated on `lastBatch`). The success message is ALSO
   * published to the page-level region (`ActionFeedbackProvider`), which sits
   * above all of them and survives.
   *
   * ADDITIVE, not a redirect: the inline copy still renders. It has to, because
   * "disappears" is not certain for any of them — a reversal bucket with more
   * than one candidate pair survives a rejection, and the inline message is
   * then the only thing distinguishing the card from one that was never
   * clicked. See the comment at the render site.
   *
   * Only successes are published. A failure skips `revalidateAll()`, so the
   * form is still on screen and its inline `role="alert"` is the whole answer —
   * nearer the controls that caused it than a banner at the top of a long page.
   * That held for every failure path only after `actions.ts` was corrected:
   * three no-op refusals used to revalidate BEFORE returning `fail`, which
   * could unmount the very message they exist to deliver.
   */
  announceSuccess?: boolean;
  children: React.ReactNode | ((pending: boolean) => React.ReactNode);
}) {
  const publish = useActionFeedback();

  // Publishes from INSIDE the action, not from a `useEffect` on the result.
  //
  // The effect version never fired for the forms that UNMOUNT on success — the
  // review queues and the unlink row, which is most of them. `revalidateAll()`
  // runs inside the Server Action, so React applies the new `useActionState`
  // state and the new RSC payload in ONE commit, and a form whose row left the
  // list unmounts in that same commit, before its effect can run. Measured in a
  // browser 2026-09-08: rejecting a reversal produced no confirmation anywhere,
  // inline or in the page-level region, on this branch AND on unmodified
  // `main`. `_action-feedback.tsx` describes at length the unmount it was built
  // to survive; it did not survive it.
  //
  // The undo form is the exception that proves the shape: its node is reused
  // rather than unmounted when an older batch remains, so there the effect DID
  // fire — and put the message under the wrong batch. It is keyed now.
  //
  // Awaiting here puts the `publish` call before the commit that unmounts this
  // component. `ActionFeedbackProvider` sits above the list and is not
  // unmounting, so its own re-render lands regardless of what happens to this
  // form.
  const [state, formAction, pending] = useActionState(
    async (prev: SyncActionState, formData: FormData) => {
      const next = await action(prev, formData);
      if (announceSuccess && publish !== null) {
        if (next.status === "ok" || next.status === "warning") publish(next);
      }
      return next;
    },
    INITIAL,
  );

  return (
    <form action={formAction} className={className} aria-labelledby={ariaLabelledBy}>
      {typeof children === "function" ? children(pending) : children}
      {/*
        ALWAYS inline, even when `announceSuccess` also publishes to the
        page-level region. Suppressing it here was tried and reverted: it is
        only ever right for a form that actually unmounts, and a multi-candidate
        reversal bucket does not. Rejecting one combination of a 2x4 bucket
        leaves the others live, so `findSameAccountReversals` keeps the bucket,
        `bucketKey` is unchanged, React reuses this node, and both `<select>`s
        keep the pair just rejected — making the card byte-identical to before
        the click, with its only confirmation a banner at the top of a page that
        holds a dozen cards. The next click on "Link as reversal" then CLEARS
        that rejection and pairs the two rows, removing real money from every
        spending surface.

        The cost is that a surviving form prints its success twice. That is
        strictly the cheaper mistake, and it is confined to the surviving case:
        a form that unmounts takes this copy with it, which is the whole reason
        the region exists.
      */}
      <ActionStatus state={state} />
    </form>
  );
}

/** Shared renderer so ok / warning / error read the same everywhere. */
export function ActionStatus({ state }: { state: SyncActionState }) {
  if (state.status === "idle") return null;

  const tone =
    state.status === "error"
      ? "text-destructive"
      : state.status === "warning"
        ? "text-foreground"
        : "text-money-pos";

  return (
    // w-full is belt-and-braces now rather than load-bearing. It was here
    // because the account-link form put its flex-wrap row on the <form>, so
    // this div was a flex ITEM and needed to force its own line. That layout
    // moved onto the form's `PendingFieldset` — the fieldset has to wrap every
    // submitted control for one `disabled` to freeze them — so the status is a
    // plain block below the row. Kept because any future form that does put a
    // row on the <form> itself gets the old behaviour for free.
    //
    // `alert` for a refusal, `status` for the rest: a polite live region can be
    // held until the user goes idle, and on a page of a dozen near-identical
    // forms a silently-swallowed "already paired" refusal reads as the click
    // having worked.
    <div
      role={state.status === "error" ? "alert" : "status"}
      className="mt-2 w-full space-y-1"
    >
      <p className={`text-sm ${tone}`}>{state.message}</p>
      {state.warnings.length > 0 && (
        <ul
          className="space-y-1 rounded-md border p-2 text-sm"
          style={{
            background:
              "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
            borderColor:
              "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
          }}
        >
          {state.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
