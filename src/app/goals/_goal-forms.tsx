"use client";

import { useActionState } from "react";
import { createGoalAction, updateGoalTargetAction } from "./actions";
import { IDLE_GOALS } from "./action-state";
import { ActionStatus } from "@/components/ledger/action-status";

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
 * `/goals`' outcome line — now just the shared component.
 *
 * It was a hand-rolled `RefreshWarning` that branched on two independent
 * optionals, chose its own `role`, and rendered a refusal in one style and a
 * warning in another. `GoalsActionState` gained a `status` discriminant in
 * v0.27.0 and satisfies `ActionState`, so all three of those decisions come
 * from `action-status.tsx` — which is where the repo keeps exactly one copy of
 * them. It also means the update-target form finally reports its successes:
 * the old shape could not tell a success from a form that had never run.
 */

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
      {/* Two outcomes reach this, not one: a name collision, returned as state
          since v0.27.0 because the obvious second click on a still-mounted form
          used to take the page down; and a success whose `/goals` revalidation
          threw. A clean success redirects, which discards this state entirely. */}
      <ActionStatus state={state} />
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
        <ActionStatus state={state} />
      </form>
    </details>
  );
}
