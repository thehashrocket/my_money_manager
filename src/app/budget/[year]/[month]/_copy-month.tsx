"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyPreviousMonthAction } from "../../actions";

type Props = {
  year: number;
  month: number;
  priorMonthLabel: string;
  /** DS7's disabled state — known server-side, so the button never invites
   * a click that can only ever produce "nothing to copy." */
  priorMonthHasAllocations: boolean;
  variant?: "outline" | "primary";
  label?: string;
};

/**
 * T16c/DS7 — the highest-leverage thing in PR1b: fill this month's blanks
 * from last month's `budget_periods` in one click. Two mount points share
 * this component: a `btn-outline` beside `MonthNav` on an ordinary month,
 * and DS30's first-run `StateCard` primary action when the prior month has
 * something to copy.
 */
export function CopyPreviousMonthButton({
  year,
  month,
  priorMonthLabel,
  priorMonthHasAllocations,
  variant = "outline",
  label,
}: Props) {
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    startTransition(async () => {
      try {
        const result = await copyPreviousMonthAction(year, month);
        const parts = [`Copied ${result.copied}`];
        if (result.skipped > 0) {
          parts.push(`skipped ${result.skipped} already set`);
        }
        if (result.skippedArchived > 0) {
          parts.push(`skipped ${result.skippedArchived} archived`);
        }
        toast.success(parts.join(" · ") + ".");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Copy failed.");
      }
    });
  };

  const disabled = isPending || !priorMonthHasAllocations;

  return (
    <Button type="button" variant={variant} onClick={handleClick} disabled={disabled}>
      {!priorMonthHasAllocations
        ? `${priorMonthLabel} has no budget to copy`
        : (label ?? `Copy ${priorMonthLabel}'s budget`)}
    </Button>
  );
}
