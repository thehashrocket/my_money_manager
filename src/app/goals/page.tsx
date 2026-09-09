import { connection } from "next/server";
import Link from "next/link";
import { db } from "@/db";
import { loadGoals, type GoalRow, type MonthlyContribution } from "@/lib/goals/loadGoals";
import { formatCents } from "@/lib/money";
import { StateCard } from "@/components/ledger/state-card";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import { currentMonth } from "@/lib/now";
import { createGoalAction, updateGoalTargetAction } from "./actions";

export default async function GoalsPage() {
  await connection();
  const view = loadGoals(db);
  // The return path out of this page. D3=C made /budget the place a fund is
  // funded, and this page had no link back — `createGoalAction` redirects
  // here and then the trail goes cold, which is the same dead end in the
  // other direction as the one that change fixed.
  const { year, month } = currentMonth();

  return (
    <main className="mx-auto max-w-3xl p-5 space-y-7 [font-variant-numeric:tabular-nums]">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold">Funds</h1>
        {/* DS11(i): the subhead used to be the exact claim ("track
            progress") this whole change exists to stop making. */}
        <p className="text-sm text-muted-foreground">
          What you have budgeted toward each target, month by month. Amounts you planned, not transfers — fund them on the Budget page.
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
        description="These are amounts you budgeted toward each fund, not confirmed transfers — the app can't tell whether the money actually moved, so there's no percent-complete bar until that's true."
      />

      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
          New fund
        </h2>
        <CreateGoalForm />
      </section>

      {view.goals.length === 0 ? (
        <GoalsEmptyState />
      ) : (
        <>
          {view.totalTargetCents > 0 && (
            <PlannedTotalLine
              plannedCents={view.totalTargetedContributedCents}
              targetCents={view.totalTargetCents}
              untargetedGoalCount={view.untargetedGoalCount}
            />
          )}
          <section className="space-y-4">
            <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Funds · {view.goals.length}
            </h2>
            {view.goals.map((goal) => (
              <GoalCard key={goal.categoryId} goal={goal} year={year} month={month} />
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
        Create fund
      </button>
    </form>
  );
}

/**
 * DS11: replaces the old bar-plus-ratio `SummaryStrip` — a plain two-number
 * line, no bar.
 *
 * Both halves are drawn from the funds that HAVE a target (`loadGoals`'
 * `totalTargetedContributedCents` / `totalTargetCents`). The label says "all
 * funds" only when that really is all of them; otherwise it names the funds it
 * is leaving out, because a ratio silently computed over two different sets is
 * worse than a longer label.
 */
function PlannedTotalLine({
  plannedCents,
  targetCents,
  untargetedGoalCount,
}: {
  plannedCents: number;
  targetCents: number;
  untargetedGoalCount: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        {untargetedGoalCount === 0
          ? "Planned to date, all funds"
          : `Planned to date, funds with a target · ${untargetedGoalCount} without`}
      </span>
      <span className="font-mono text-sm shrink-0">
        {formatCents(plannedCents)} / {formatCents(targetCents)}
      </span>
    </div>
  );
}

/**
 * The headline figure is `totalContributedCents`, NOT `progressCents`.
 *
 * They are different quantities — `progressCents` is contributed MINUS
 * withdrawals — and this card used to render the net one under the word
 * "planned", while `/budget`'s FUNDS band renders the gross one under the
 * same word. Two adjacent pages, one word, two numbers that only agree when
 * nothing has ever been withdrawn. Now both pages show the same quantity
 * under the same label, and the withdrawal, which is a real and separate
 * fact, gets its own line instead of being silently folded into the total.
 */
function GoalCard({ goal, year, month }: { goal: GoalRow; year: number; month: number }) {
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
            {formatCents(goal.totalContributedCents)}
          </div>
          {/* A NULL target is "no target recorded", never `$0.00` — the same
              rule `fundTargetGap` applies on `/budget`, which renders an em
              dash. A fund created from the FUNDS band's "+ Add a line" has no
              target until one is set here, so this is the ordinary state of a
              fund born on the other page, not an edge case. */}
          <div className="font-mono text-xs text-muted-foreground">
            {goal.targetCents === null
              ? "planned to date · no target set"
              : `planned to date, target ${formatCents(goal.targetCents)}`}
          </div>
          {goal.totalWithdrawnCents > 0 && (
            <div className="font-mono text-xs text-muted-foreground">
              less {formatCents(goal.totalWithdrawnCents)} withdrawn · {formatCents(goal.progressCents)} net
            </div>
          )}
        </div>
      </div>

      {/* The established inline-link recipe: FOCUS_RING (DESIGN.md names it
          "the one focus treatment for interactive elements outside
          components/ui") plus `inline-flex min-h-11 items-center` for the
          DS66 44px touch floor. At text-xs this link is ~15px tall without
          it, and it is the whole return path into the FUNDS band. */}
      <Link
        href={`/budget/${year}/${month}#funds-band`}
        className={`inline-flex min-h-11 items-center font-mono text-xs text-terracotta underline-offset-4 hover:underline ${FOCUS_RING}`}
      >
        Fund this month →
      </Link>

      <UpdateTargetForm categoryId={goal.categoryId} currentTargetCents={goal.targetCents} />

      {goal.monthlyBreakdown.length > 0 && (
        <MonthlyBreakdownTable breakdown={goal.monthlyBreakdown} />
      )}
    </div>
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
function UpdateTargetForm({
  categoryId,
  currentTargetCents,
}: {
  categoryId: number;
  currentTargetCents: number | null;
}) {
  const currentDollars =
    currentTargetCents === null ? undefined : (currentTargetCents / 100).toFixed(2);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
        {currentTargetCents === null ? "Set target" : "Edit target"}
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
          placeholder="1000.00"
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
      <p className="mb-1 text-sm font-medium">No funds yet</p>
      <p className="text-xs text-muted-foreground">Create your first fund above.</p>
    </div>
  );
}
