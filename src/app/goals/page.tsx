import { connection } from "next/server";
import { db } from "@/db";
import { loadGoals, type GoalRow, type MonthlyContribution } from "@/lib/goals/loadGoals";
import { formatCents } from "@/lib/money";
import { StateCard } from "@/components/ledger/state-card";
import { createGoalAction, updateGoalTargetAction } from "./actions";

export default async function GoalsPage() {
  await connection();
  const view = loadGoals(db);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-8 [font-variant-numeric:tabular-nums]">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold">Savings Goals</h1>
        {/* DS11(i): the subhead used to be the exact claim ("track
            progress") this whole change exists to stop making. */}
        <p className="text-sm text-muted-foreground">
          Planned contributions toward each target. These are amounts you budgeted, not transfers.
        </p>
      </div>

      {/* DS11: a relabel alone leaves the progress bar and percent-complete
          UI still asserting a fact about money that may never have moved
          (B2) — this says so plainly instead. `empty`, not `error`: this is
          the page working as designed, not a failure, so it shouldn't wear
          the same redbrown `!` mark a real error does. */}
      <StateCard
        variant="empty"
        title="Progress tracking is paused"
        description="These are amounts you budgeted toward each goal, not confirmed transfers — the app can't tell whether the money actually moved, so there's no percent-complete bar until that's true."
      />

      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          New goal
        </h2>
        <CreateGoalForm />
      </section>

      {view.goals.length === 0 ? (
        <GoalsEmptyState />
      ) : (
        <>
          {view.totalTargetCents > 0 && (
            <PlannedTotalLine plannedCents={view.totalProgressCents} targetCents={view.totalTargetCents} />
          )}
          <section className="space-y-4">
            <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Goals · {view.goals.length}
            </h2>
            {view.goals.map((goal) => (
              <GoalCard key={goal.categoryId} goal={goal} />
            ))}
          </section>
        </>
      )}
    </main>
  );
}

function CreateGoalForm() {
  return (
    <form
      action={createGoalAction}
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
        className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
      >
        Create goal
      </button>
    </form>
  );
}

/** DS11: replaces the old bar-plus-ratio `SummaryStrip` — a plain two-number line, no bar. */
function PlannedTotalLine({ plannedCents, targetCents }: { plannedCents: number; targetCents: number }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        Planned across all goals
      </span>
      <span className="font-mono text-sm">
        {formatCents(plannedCents)} / {formatCents(targetCents)}
      </span>
    </div>
  );
}

function GoalCard({ goal }: { goal: GoalRow }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{goal.name}</div>
          {goal.carryoverPolicy !== "none" && (
            <span className="inline-block mt-0.5 rounded-xs bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {goal.carryoverPolicy}
            </span>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-sm font-medium">
            {formatCents(goal.progressCents)}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            planned of {formatCents(goal.targetCents)}
          </div>
        </div>
      </div>

      <UpdateTargetForm categoryId={goal.categoryId} currentTargetCents={goal.targetCents} />

      {goal.monthlyBreakdown.length > 0 && (
        <MonthlyBreakdownTable breakdown={goal.monthlyBreakdown} />
      )}
    </div>
  );
}

function UpdateTargetForm({
  categoryId,
  currentTargetCents,
}: {
  categoryId: number;
  currentTargetCents: number;
}) {
  const currentDollars = (currentTargetCents / 100).toFixed(2);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
        Edit target
      </summary>
      <form action={updateGoalTargetAction} className="mt-2 flex gap-2 items-center">
        <input type="hidden" name="categoryId" value={categoryId} />
        <input
          name="targetDollars"
          type="number"
          required
          min="0.01"
          step="0.01"
          defaultValue={currentDollars}
          className="w-32 rounded-md border border-border bg-background px-3 py-1 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted transition-colors"
        >
          Save
        </button>
      </form>
    </details>
  );
}

function MonthlyBreakdownTable({ breakdown }: { breakdown: MonthlyContribution[] }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
        Monthly contributions ({breakdown.length})
      </summary>
      <table className="mt-2 w-full text-xs font-mono">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pb-1 font-normal">Month</th>
            <th className="pb-1 text-right font-normal">Contributed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {breakdown.map((row) => (
            <tr key={`${row.year}-${row.month}`}>
              <td className="py-1">
                {new Date(Date.UTC(row.year, row.month - 1, 1)).toLocaleDateString("en-US", {
                  month: "short",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </td>
              <td className="py-1 text-right">{formatCents(row.allocatedCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function GoalsEmptyState() {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-8 py-10 text-center">
      <div className="mb-3 font-mono text-3xl text-muted-foreground">★</div>
      <p className="mb-1 text-sm font-medium">No savings goals yet</p>
      <p className="text-xs text-muted-foreground">Create your first goal above.</p>
    </div>
  );
}
