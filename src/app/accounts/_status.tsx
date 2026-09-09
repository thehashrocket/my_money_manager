"use client";

import type { AccountsActionState, CardActivityState } from "./action-state";

/**
 * The ONE inline status line for `/accounts`.
 *
 * `_balance-forms.tsx` and `_card-terms-form.tsx` carried byte-identical
 * private copies of this, which is how the pair drifts — and the warning
 * branch below is exactly the kind of change that would have landed in one of
 * them. `_charge-dialog.tsx` renders its own refusal inline because it also
 * has to decide whether to close, so it reuses `tone`/`role` from here rather
 * than the whole component.
 *
 * ROLE IS NOT COSMETIC, and the rule is `/sync`'s, already argued at length in
 * `ActionForm.tsx`: `alert` for a refusal AND for a warning, `status` only for
 * a plain success. A polite live region can be held until the user goes idle,
 * and on a page of four independent per-row forms a silently-swallowed message
 * reads as the click having worked. A refresh warning is the case that matters
 * most here — it says the write LANDED, and a user who does not hear it will
 * read the stale row and resubmit, which under rule 9 spends the account's one
 * `prior_starting_balance_*` slot on the value the first write already stored.
 *
 * ONE ELEMENT, NOT TWO. The message and the warning are concatenated rather
 * than stacked, for the same reason CLAUDE.md rule 6 requires a single toast
 * rather than a success plus a warning: two live regions announcing about one
 * click race each other, and the reader has no way to know they are one event.
 */

export type StatusState = AccountsActionState | CardActivityState;

/** The warning on an `ok` outcome, or `undefined`. Narrowing lives here so no
 *  caller has to re-derive that a warning can only ride on success. */
export function warningOf(state: StatusState): string | undefined {
  return state.status === "ok" ? state.warning : undefined;
}

export function statusTone(state: StatusState): string {
  if (state.status === "error") return "text-redbrown";
  return warningOf(state) !== undefined ? "text-ink-1" : "text-ledger";
}

export function statusRole(state: StatusState): "alert" | "status" {
  return state.status === "error" || warningOf(state) !== undefined ? "alert" : "status";
}

export function Status({ state }: { state: StatusState }) {
  if (state.status === "idle") return null;
  const warning = warningOf(state);
  const role = statusRole(state);
  return (
    <p
      role={role}
      // Only a plain success is polite. See the docblock: a warning that waits
      // for an idle moment is a warning the resubmitting user never hears.
      aria-live={role === "alert" ? "assertive" : "polite"}
      className={`mt-1 text-base ${statusTone(state)}`}
    >
      {warning === undefined ? state.message : `${state.message} ${warning}`}
    </p>
  );
}
