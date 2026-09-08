"use client";

import { useActionState } from "react";
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
  children: React.ReactNode | ((pending: boolean) => React.ReactNode);
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className={className} aria-labelledby={ariaLabelledBy}>
      {typeof children === "function" ? children(pending) : children}
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
    // w-full so that inside a flex-wrap row (the account link form) the status
    // drops to its own line rather than squeezing in beside the controls.
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
