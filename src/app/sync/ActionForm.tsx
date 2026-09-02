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
  children,
}: {
  action: (
    prev: SyncActionState,
    formData: FormData,
  ) => Promise<SyncActionState>;
  className?: string;
  children: React.ReactNode | ((pending: boolean) => React.ReactNode);
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className={className}>
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
    <div role="status" className="mt-2 w-full space-y-1">
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
