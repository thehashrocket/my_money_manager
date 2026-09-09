"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { ActionStatus } from "./ActionForm";
import type { SyncActionState } from "./actions";

/**
 * A status region that OUTLIVES the form that produced it.
 *
 * Forms that stay put render their outcome inline, via `useActionState` — the
 * account-link form is the only one left in that case. Inline silently fails
 * for the review queues: a successful resolve calls `revalidateAll()`, the
 * resolved bucket leaves `buckets`, and the keyed `<ActionForm>` unmounts —
 * taking the `ok(...)` message with it before it can paint. The card just
 * vanishes. The unlink and undo forms have the same problem, so all three set
 * `announceSuccess` and route ok/warning here instead. ERRORS stay inline
 * everywhere: a failure skips `revalidateAll()`, so the form is still on
 * screen and the refusal belongs beside the controls that caused it.
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
  // Stable identity: this is the context value every `ActionForm` on the page
  // subscribes to, so a new function each render would re-render all of them.
  // `ActionForm` calls it from inside its action, not from an effect — an
  // effect never ran, because the revalidation that removes the form and the
  // state update that would have triggered the effect land in one commit.
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
