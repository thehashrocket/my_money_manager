"use client";

/**
 * The ONE inline status line for a returned-state Server Action.
 *
 * WHY IT IS HERE AND NOT IN A ROUTE FOLDER. It started as a private copy in
 * `_balance-forms.tsx` and `_card-terms-form.tsx`, became a shared
 * `accounts/_status.tsx`, and was STILL re-derived by hand in
 * `accounts/_charge-dialog.tsx` and `import/_create-account-form.tsx` — four
 * spellings of one decision, in the branch whose whole subject is that two
 * hand-maintained copies of a rule drift. Routes cannot import each other's
 * private components without the same thing happening again, so it lives with
 * the other design-system components.
 *
 * TAKES A STRUCTURAL TYPE, NOT A ROUTE'S UNION. `AccountsActionState`,
 * `CardActivityState` and `CreateAccountState` each carry their own extra
 * fields (`field`, `reason`) that only their own route reads. Importing all
 * three here would make this module depend on every route that uses it — and
 * the next route would have to edit this file to render a status. `ActionState`
 * below is the shape they share, and each of those unions satisfies it
 * structurally with no cast.
 *
 * THREE RULES, and each one is a decision this repo has already paid for:
 *
 *   role   `alert` for a refusal AND for a warning; `status` only for a plain
 *          success. Copied from `/sync`'s `ActionForm.tsx`, which argues it at
 *          length: a polite live region can be held until the user goes idle,
 *          and on a page of independent per-row forms a swallowed message reads
 *          as the click having worked. The warning is the case that matters
 *          most — it says the write LANDED, and a user who does not hear it
 *          resubmits, which under rule 9 spends the account's one
 *          `prior_starting_balance_*` slot on a value that was never current.
 *
 *   tone   A warned success is not an error. Error is `redbrown`; a success
 *          is `ledger` whether or not it carries a warning — the MESSAGE is
 *          still reporting a write that landed, and the amber block below it
 *          is what carries the signal. (The predecessor `_status.tsx` toned a
 *          warned message `ink-1` and pinned the inequality in a test; that
 *          made sense while the warning was concatenated into the same
 *          sentence with no block of its own.)
 *
 *   amber  The warning renders in the same amber block `/sync` uses for the
 *          byte-identical sentence (`ActionForm.tsx`'s warnings list). Two
 *          surfaces reporting one fact in two visual languages is how a design
 *          system stops being one.
 *
 * ONE live region, not two: the container owns the `role`, and the message and
 * the warning are both inside it. That is `/sync`'s shape, and it is what keeps
 * a single click from announcing twice — the same reasoning CLAUDE.md rule 6
 * gives for a single toast rather than a success plus a warning.
 */

/** The shape every returned-state action in this app shares. */
export type ActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; warning?: string }
  | { status: "error"; message: string };

/** The warning on an `ok` outcome, or `undefined`.
 *
 *  Narrowing lives here so no caller re-derives that a warning can only ride on
 *  success — putting one on `error` would send a committed write back down the
 *  failure branch, which is the defect `guardRefresh` exists to prevent. */
export function warningOf(state: ActionState): string | undefined {
  return state.status === "ok" ? state.warning : undefined;
}

export function statusRole(state: ActionState): "alert" | "status" {
  return state.status === "error" || warningOf(state) !== undefined ? "alert" : "status";
}

export function statusTone(state: ActionState): string {
  return state.status === "error" ? "text-redbrown" : "text-ledger";
}

/** The amber warning block. Exported for the one surface that renders it
 *  without `<ActionStatus>` — `/budget`'s `_reclassify-income.tsx`, whose
 *  refusal line and warning sit in different parts of a dialog rather than in
 *  one live region, so it places the block itself rather than re-deriving it.
 *  (`_charge-dialog.tsx` does not render it at all: it CLOSES on success, so it
 *  imports `statusRole`/`warningOf` and sends the warning to a toast.) */
export function StatusWarning({ warning }: { warning: string }) {
  return (
    <p
      className="mt-1 rounded-md border px-2 py-1 text-sm text-ink-1"
      style={{
        background: "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
        borderColor: "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
      }}
    >
      {warning}
    </p>
  );
}

export function ActionStatus({
  state,
  className = "",
}: {
  state: ActionState;
  /** Grid/flow placement from the calling form. Never tone — tone is decided here. */
  className?: string;
}) {
  if (state.status === "idle") return null;
  const warning = warningOf(state);
  const role = statusRole(state);
  return (
    <div
      role={role}
      // Only a plain success is polite. A warning that waits for an idle moment
      // is a warning the resubmitting user never hears.
      aria-live={role === "alert" ? "assertive" : "polite"}
      className={`mt-1 ${className}`}
    >
      <p className={`text-base ${statusTone(state)}`}>{state.message}</p>
      {warning === undefined ? null : <StatusWarning warning={warning} />}
    </div>
  );
}
