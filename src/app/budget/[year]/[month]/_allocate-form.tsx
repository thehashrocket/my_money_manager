"use client";

import { useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/money";
import { upsertBudgetAllocationAction } from "../../actions";
import type { LeafAllocation } from "@/lib/budget/loadMonthView";

type AllocateFormTriggerProps = {
  categoryId: number;
  categoryName: string;
  year: number;
  month: number;
  allocation: LeafAllocation | null;
  carryoverPolicy: "none" | "rollover" | "reset";
  /** DS30/DS31: the first-run card and the `plannedIncome === 0` headline both
   * need a CTA that opens THIS category's Allocate dialog, styled as a
   * primary call-to-action rather than a row's small "Allocate" button.
   * Overriding the trigger element/label re-skins the same dialog + form
   * rather than needing a second, state-synced dialog instance. */
  triggerElement?: React.ReactElement;
  triggerLabel?: React.ReactNode;
};

/**
 * Client island for the `/budget` Allocate flow (Track D).
 *
 * Shows the full envelope math the user is committing to: Explicit is the only
 * editable field; Rollover is auto-computed upstream (see
 * `invalidateForwardRollover` contract in src/lib/budget.ts) and displayed
 * read-only; Effective updates live as the user types so the envelope total is
 * never a surprise at submit.
 *
 * Input is `text-base sm:text-sm` — iOS Safari autozooms inputs below 16px, so
 * the mobile breakpoint must hit 16px (TODOS.md v0.3.0 ship review P3).
 */
export function AllocateFormTrigger(props: AllocateFormTriggerProps) {
  const {
    categoryId,
    categoryName,
    year,
    month,
    allocation,
    carryoverPolicy,
    triggerElement,
    triggerLabel,
  } = props;
  const allocatedCents = allocation?.allocatedCents ?? 0;
  const rolloverCents =
    carryoverPolicy === "rollover" ? (allocation?.rolloverCents ?? 0) : 0;

  const defaultDollars = (allocatedCents / 100).toFixed(2);
  const [explicitDollars, setExplicitDollars] = useState(defaultDollars);

  const liveEffectiveCents = computeLiveEffectiveCents(
    explicitDollars,
    rolloverCents,
  );

  const inputId = useId();
  const titleId = useId();
  const descId = useId();

  return (
    <Dialog
      onOpenChange={(open) => {
        // T18: this trigger's row now stays mounted for the whole editing
        // session instead of remounting on every navigation (the old
        // redirect-per-commit flow made a fresh mount implicit). Without
        // this, opening the dialog after the row's inline `CurrencyInput`
        // already committed a new value would show the STALE number this
        // component's `useState` initializer captured at first mount —
        // reset it from the current prop on every open instead. Same root
        // cause hits any revalidation that changes `allocatedCents` behind
        // an already-mounted trigger even without T18's editor (e.g. Copy
        // Previous Month) — Save would otherwise write the stale $0.00
        // default back over the just-copied amount.
        if (open) setExplicitDollars(defaultDollars);
      }}
    >
      <DialogTrigger render={triggerElement ?? <Button variant="outline" size="sm" />}>
        {triggerLabel ?? "Allocate"}
      </DialogTrigger>
      <DialogContent aria-labelledby={titleId} aria-describedby={descId}>
        <DialogHeader>
          <DialogTitle id={titleId}>Allocate — {categoryName}</DialogTitle>
          <DialogDescription id={descId}>
            {monthLabel(year, month)} · set this category&apos;s explicit
            budget.
          </DialogDescription>
        </DialogHeader>

        <form
          action={upsertBudgetAllocationAction}
          className="space-y-3 [font-variant-numeric:tabular-nums]"
        >
          <input type="hidden" name="categoryId" value={categoryId} />
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="month" value={month} />

          <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
            <label
              htmlFor={inputId}
              className="text-sm font-medium text-foreground"
            >
              Explicit
            </label>
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="text-sm text-muted-foreground"
              >
                $
              </span>
              <input
                id={inputId}
                name="allocatedDollars"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={explicitDollars}
                onChange={(e) => setExplicitDollars(e.target.value)}
                autoFocus
                className="h-9 w-28 rounded-md border border-border bg-background px-2 text-right text-base sm:text-sm [font-variant-numeric:tabular-nums] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
              />
            </div>

            <span className="text-sm text-muted-foreground">
              Rollover
              {carryoverPolicy === "rollover" ? null : (
                <span className="ml-2 text-[10px] uppercase tracking-wide">
                  (not rollover)
                </span>
              )}
            </span>
            <span className="text-right text-sm text-muted-foreground">
              {rolloverCents === 0 ? "—" : formatCents(rolloverCents)}
            </span>

            <span className="text-sm font-semibold text-foreground">
              Effective
            </span>
            <span
              aria-live="polite"
              className="text-right text-sm font-semibold text-foreground"
            >
              {formatCents(liveEffectiveCents)}
            </span>
          </div>

          <DialogFooter showCloseButton>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function computeLiveEffectiveCents(
  dollarsStr: string,
  rolloverCents: number,
): number {
  const dollars = Number(dollarsStr);
  if (!Number.isFinite(dollars) || dollars < 0) return rolloverCents;
  return Math.round(dollars * 100) + rolloverCents;
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
