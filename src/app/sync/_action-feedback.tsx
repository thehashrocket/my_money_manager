"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { ActionStatus } from "./ActionForm";
import type { SyncActionState } from "./actions";

/**
 * A status region that OUTLIVES the form that produced it.
 *
 * Every mutating form on this page renders its outcome inline, via
 * `useActionState`. That works for the forms that stay put (linking an
 * account, undoing a batch). It silently fails for the review queues: a
 * successful resolve calls `revalidateAll()`, the resolved bucket leaves
 * `buckets`, and the keyed `<ActionForm>` unmounts — taking the `ok(...)`
 * message with it before it can paint. The card just vanishes.
 *
 * That was survivable while "resolve" meant one thing. It stopped being
 * survivable when the reversal queue grew a second button: "Link as reversal"
 * and "Not a reversal" have opposite effects on money and, on a 1x1 bucket,
 * produced the identical visible outcome — the card disappearing. A misclick
 * was unnoticeable, and the durable consequence of rejecting ("won't be
 * suggested again") was stated only in a message nobody ever saw.
 *
 * This provider sits ABOVE the list, so revalidating the list doesn't unmount
 * it and its state survives the re-render.
 */
type Publish = (state: SyncActionState) => void;

const ActionFeedbackContext = createContext<Publish | null>(null);

export function useActionFeedback(): Publish | null {
  return useContext(ActionFeedbackContext);
}

export function ActionFeedbackProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SyncActionState>({ status: "idle" });
  // Stable identity: `ActionForm` publishes from an effect keyed on this, and
  // a new function every render would re-fire it on every parent re-render.
  const publish = useCallback<Publish>((next) => setState(next), []);

  return (
    <ActionFeedbackContext.Provider value={publish}>
      {state.status !== "idle" && (
        <div className="rounded-md border border-border p-3">
          <ActionStatus state={state} />
        </div>
      )}
      {children}
    </ActionFeedbackContext.Provider>
  );
}
