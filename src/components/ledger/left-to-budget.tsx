"use client";

import { formatCents } from "@/lib/money";
import type { MonthPhase } from "@/lib/budget/monthOfIso";
import { cn } from "@/lib/utils";

export type LeftToBudgetProps = {
  plannedIncomeCents: number;
  allocatedCents: number;
  plannedFundCents: number;
  leftToBudgetCents: number;
  phase: MonthPhase;
  /** DS37: names the rail so "$0.00" here isn't mistaken for the account total the Spine already shows. */
  railTotalCents: number;
  /** DS31: the `no-income` state's CTA — opens the Allocate dialog on the
   * first income category. A slot rather than a categoryId/year/month prop
   * set: the dialog itself is `AllocateFormTrigger` (route-local, needs
   * `budget/actions.ts`), which this presentational component has no
   * business importing. */
  noIncomeCta?: React.ReactNode;
};

type LeftToBudgetState =
  | { kind: "no-income" }
  | { kind: "progress"; assignedPct: number }
  | { kind: "unassigned"; assignedPct: number }
  | { kind: "over" }
  | { kind: "success" };

/**
 * DS6′: `leftToBudget === 0` alone is satisfied by a virgin month's
 * `0 − 0 − 0` — never render that as success. `plannedIncomeCents === 0`
 * is checked first and wins outright, whatever `leftToBudgetCents` says.
 */
function resolveState({
  plannedIncomeCents,
  allocatedCents,
  plannedFundCents,
  leftToBudgetCents,
  phase,
}: LeftToBudgetProps): LeftToBudgetState {
  if (plannedIncomeCents === 0) return { kind: "no-income" };
  if (leftToBudgetCents < 0) return { kind: "over" };
  if (leftToBudgetCents === 0) return { kind: "success" };

  const assignedPct = Math.min(
    100,
    Math.max(0, ((allocatedCents + plannedFundCents) / plannedIncomeCents) * 100),
  );
  return phase === "future" ? { kind: "progress", assignedPct } : { kind: "unassigned", assignedPct };
}

const AMBER_MIXED = "text-[color-mix(in_oklch,var(--accent-amber)_55%,var(--fg))]";

/**
 * `src/components/ledger/left-to-budget.tsx` — the page's one hero (DS1).
 *
 * Five states (DS6′/§5.1), only one of which is a plain "$0.00": a virgin
 * month with no income planned is its own state, never a false success.
 *
 * Motion (DS6′/DS41): on transition INTO success the numeral settles to
 * ledger green over `--motion-settle` — never on page load. No mount-gating
 * needed for that: a CSS `transition-*` class present from first paint never
 * animates the initial computed style, only a LATER change to it (a server
 * action revalidating this page after the numeral was already on screen),
 * which is exactly the "into success" case. Reduced-motion is handled by
 * globals.css's one app-wide rule, not a `motion-reduce:` variant here. The
 * ✓'s own draw-in (also DS41) stays deferred: it needs an enter animation
 * (the checkmark isn't in the DOM in any other state), which is more than
 * this settle transition needs.
 */
export function LeftToBudget(props: LeftToBudgetProps) {
  const state = resolveState(props);
  const settle = "transition-colors duration-[var(--motion-settle)] ease-[var(--motion-ease)]";

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-[var(--bg-raised)] p-5 shadow-soft">
      <div className="font-mono text-xs uppercase tracking-wide text-ink-2">
        Left to budget
      </div>

      {state.kind === "no-income" ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="font-display text-lg text-ink-1">
            Start by planning your income.
          </div>
          {props.noIncomeCta}
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={cn(
              "font-mono text-3xl font-semibold [font-variant-numeric:tabular-nums]",
              settle,
              state.kind === "success" && "text-ledger",
              state.kind === "over" && "text-money-neg",
              state.kind === "progress" && "text-ink-1",
              state.kind === "unassigned" && AMBER_MIXED,
            )}
          >
            {state.kind === "success" ? formatCents(0) : formatCents(props.leftToBudgetCents)}
          </span>

          {state.kind === "success" ? (
            <span aria-hidden className={cn("text-xl text-ledger", settle)}>
              ✓
            </span>
          ) : null}

          {state.kind === "unassigned" ? (
            <span className={cn("text-sm", AMBER_MIXED)}>still unassigned</span>
          ) : null}

          {state.kind === "over" ? (
            <span className="text-sm text-money-neg">over-budgeted</span>
          ) : null}
        </div>
      )}

      {state.kind === "success" ? (
        <div className="text-sm text-ink-1">every dollar has a job</div>
      ) : null}

      {state.kind === "progress" ? (
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--bg-inset)]" aria-hidden>
          <div
            className="h-full bg-terracotta"
            style={{ width: `${state.assignedPct}%` }}
          />
        </div>
      ) : null}

      <div className="text-sm text-ink-2">
        Planned for the month. Your {formatCents(props.railTotalCents)} balance is in the rail.
      </div>
    </div>
  );
}
