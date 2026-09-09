"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { ActionStatus } from "./ActionForm";
import type { SyncActionState } from "./actions";

/**
 * A status region that OUTLIVES the form that produced it.
 *
 * EVERY form renders its outcome inline, via `useActionState`. This region is
 * ADDITIVE on top of that — never a replacement for it — for the three forms
 * that can VANISH before the inline copy is any use: a successful resolve calls
 * `revalidateAll()`, the resolved bucket leaves `buckets`, and the keyed
 * `<ActionForm>` unmounts, taking the `ok(...)` message with it before it can
 * paint. The card just disappears. The unlink row (its `<li>` leaves
 * `linkedPairs`) and the undo form (its section is gated on `lastBatch`) have
 * the same problem, so all three set `announceSuccess` and route ok/warning
 * here AS WELL AS inline.
 *
 * "Vanishes" is not certain for any of the three, which is why suppressing the
 * inline copy on an `announceSuccess` form was tried and reverted: a reversal
 * bucket with more than one candidate pair SURVIVES a rejection, and inline is
 * then the only thing distinguishing that card from one nobody ever clicked.
 * See the render site in `ActionForm`.
 *
 * ERRORS are inline ONLY: a failure skips `revalidateAll()`, so the form is
 * still on screen and the refusal belongs beside the controls that caused it.
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
