"use client";

import { useActionState } from "react";
import { createGoalAction, updateGoalTargetAction } from "./actions";
import { IDLE_GOALS, type GoalsActionState } from "./action-state";
import { StatusWarning } from "@/components/ledger/action-status";

/**
 * The two write forms on `/goals`, as client islands.
 *
 * They were plain `<form action={serverAction}>` posts against actions that
 * returned `void`, which left the page with no channel at all for the one thing
 * these actions can now report: a post-commit `revalidatePath` that threw. That
 * used to escape into `error.tsx`, whose copy affirmatively says nothing was
 * written — false, and on the create path actively harmful, since re-submitting
 * on that advice collides with the name the first attempt already took.
 *
 * Nothing else moved. Validation failures still THROW and still land in
 * `error.tsx`; the markup is the same markup, lifted verbatim.
 */

/**
 * The one renderer for a refresh warning, so both forms say it the same way.
 *
 * `role="alert"`, not `status`: the same argument `/sync`'s `ActionStatus`
 * makes. A polite live region can be held until the reader goes idle, and the
 * whole content of this message is "what you are looking at may be out of
 * date" — which is worth nothing once they have already looked.
 */
function RefreshWarning({ state }: { state: GoalsActionState }) {
  // A REFUSAL first — a name collision is ordinary use (double-submit, stale
  // tab), and it used to escape into `/goals/error.tsx` and take the page down.
  if (state.error !== undefined) {
    return (
      <p role="alert" aria-live="assertive" className="text-sm text-money-neg">
        {state.error}
      </p>
    );
  }
  if (state.warning === undefined) return null;
  // `StatusWarning`, not a local `<p>`. `/goals`' state is the one shape that
  // does NOT satisfy `ActionState` — it carries a warning and nothing else,
  // because both actions still THROW on a validation failure — so it cannot
  // render `<ActionStatus>` wholesale. It can still share the BLOCK, which is
  // the part that has to look the same everywhere: this is the byte-identical
  // sentence `/sync` and `/accounts` render, and a fifth visual language for
  // it is how a design system stops being one.
  // The LIVE REGION is the point, and it was lost for one review cycle when
  // this switched to `StatusWarning`: on the create path a successful write
  // normally redirects away, so this warning is the only signal the fund
  // exists. Silent for assistive tech is the resubmit loop, not a cosmetic gap.
  // `assertive`, per `action-status.tsx`'s rule — a warning about a committed
  // write is one the user must hear BEFORE deciding to click again.
  return (
    <div role="alert" aria-live="assertive">
      <StatusWarning warning={state.warning} />
    </div>
  );
}

export function CreateGoalForm() {
  const [state, formAction, pending] = useActionState(createGoalAction, IDLE_GOALS);

  return (
    <form
      action={formAction}
      className="rounded-lg border border-border bg-card p-4 space-y-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-1">
          <label className="block text-xs text-muted-foreground mb-1" htmlFor="goal-name">
            Name
          </label>
          <input
            id="goal-name"
            name="name"
            type="text"
            required
            placeholder="e.g. Emergency Fund"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1" htmlFor="goal-target">
            Target ($)
          </label>
          <input
            id="goal-target"
            name="targetDollars"
            type="number"
            required
            min="0.01"
            step="0.01"
            placeholder="1000.00"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1" htmlFor="goal-carryover">
            Carryover
          </label>
          <select
            id="goal-carryover"
            name="carryoverPolicy"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="none">None</option>
            <option value="rollover">Rollover</option>
            <option value="reset">Reset</option>
          </select>
        </div>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create fund"}
      </button>
      {/* Only ever rendered when the refresh failed — the success path
          redirects, which discards this state entirely. */}
      <RefreshWarning state={state} />
    </form>
  );
}

/**
 * `currentTargetCents` is nullable, and the NULL case must not prefill.
 *
 * It used to take `number`, fed by `loadGoals`' `?? 0` — so a fund with no
 * target opened this form already filled in with `0.00`, which fails
 * `updateGoalTargetSchema`'s `.positive()`. `updateGoalTargetAction` throws on
 * a validation failure and nothing catches it, so submitting the value the
 * form itself supplied took out the page via `error.tsx` (and in a production
 * build the message is replaced by a generic digest, so it did not even say
 * why). An empty field with a placeholder cannot do that: `required` stops the
 * submit in the browser first.
 */
export function UpdateTargetForm({
  categoryId,
  currentTargetCents,
}: {
  categoryId: number;
  currentTargetCents: number | null;
}) {
  const [state, formAction, pending] = useActionState(updateGoalTargetAction, IDLE_GOALS);
  const currentDollars =
    currentTargetCents === null ? undefined : (currentTargetCents / 100).toFixed(2);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
        {currentTargetCents === null ? "Set target" : "Edit target"}
      </summary>
      <form action={formAction} className="mt-2 space-y-2">
        <div className="flex gap-2 items-center">
          <input type="hidden" name="categoryId" value={categoryId} />
          <input
            name="targetDollars"
            type="number"
            required
            min="0.01"
            step="0.01"
            defaultValue={currentDollars}
            placeholder="1000.00"
            className="w-32 rounded-md border border-border bg-background px-3 py-1 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
        <RefreshWarning state={state} />
      </form>
    </details>
  );
}
