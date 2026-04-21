"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { LeafCategory } from "@/lib/categories";
import type { TransactionRow } from "@/lib/categorize/loadTransactions";
import { formatCents } from "@/lib/money";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import {
  categorizeTransactionAction,
  undoCategorizeTransactionAction,
} from "./actions";

type Props = {
  row: TransactionRow;
  leafCategories: LeafCategory[];
  /** Called after the action resolves — used to bump the live backlog counter. */
  onCategorized: (priorCategoryId: number | null, updatedCount: number) => void;
  /** Called after Undo resolves — reverses the backlog bump. */
  onUndone: (priorCategoryId: number | null, revertedCount: number) => void;
};

/**
 * One row on `/transactions`. Picker + Remember + Apply-to-past + Submit,
 * with a 10s Sonner Undo on success (symmetry with `/categorize`).
 *
 * On submit:
 * - optimistically hides the backlog banner contribution (only when the row
 *   was uncategorized pre-click — that's the only case the banner counted),
 * - shows a Sonner toast with a 10s Undo that calls
 *   `undoCategorizeTransactionAction(snapshot)`.
 *
 * The row stays visible after success so the user can re-categorize. The
 * inline category label updates via the local `currentCategoryId` state.
 */
export function TransactionRowForm({
  row,
  leafCategories,
  onCategorized,
  onUndone,
}: Props) {
  const [pickerValue, setPickerValue] = useState<string>(
    row.categoryId !== null ? String(row.categoryId) : "",
  );
  const [currentCategoryId, setCurrentCategoryId] = useState<number | null>(
    row.categoryId,
  );
  const [currentCategoryName, setCurrentCategoryName] = useState<string | null>(
    row.categoryName,
  );
  const [remember, setRemember] = useState(false);
  const [applyToPast, setApplyToPast] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pickerValue) return;
    const newCategoryId = Number(pickerValue);
    const newCategoryName =
      leafCategories.find((c) => c.id === newCategoryId)?.name ?? null;
    const priorCategoryId = currentCategoryId;
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      try {
        const result = await categorizeTransactionAction(formData);
        setCurrentCategoryId(newCategoryId);
        setCurrentCategoryName(newCategoryName);
        setRemember(false);
        setApplyToPast(false);
        onCategorized(priorCategoryId, result.updatedCount);

        toast.success(
          `Categorized ${result.updatedCount} row${result.updatedCount === 1 ? "" : "s"} as ${result.categoryName}.`,
          {
            duration: 10_000,
            action: {
              label: "Undo",
              onClick: async () => {
                try {
                  const undo = await undoCategorizeTransactionAction(
                    result.snapshot,
                  );
                  const reverted =
                    (undo.targetReverted ? 1 : 0) +
                    undo.revertedApplyToPastCount;
                  setCurrentCategoryId(priorCategoryId);
                  setCurrentCategoryName(
                    priorCategoryId === null
                      ? null
                      : (leafCategories.find((c) => c.id === priorCategoryId)
                          ?.name ?? null),
                  );
                  setPickerValue(
                    priorCategoryId !== null ? String(priorCategoryId) : "",
                  );
                  onUndone(priorCategoryId, reverted);
                  toast(
                    `Reverted ${reverted} row${reverted === 1 ? "" : "s"}.`,
                  );
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Undo failed.",
                  );
                }
              },
            },
          },
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Categorize failed.");
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-3 text-sm"
    >
      <input type="hidden" name="transactionId" value={row.id} />
      <div className="flex min-w-0 flex-[2_1_16rem] items-baseline gap-2">
        <span className="truncate font-medium" title={row.rawDescription}>
          {row.normalizedMerchant}
        </span>
        {currentCategoryName ? (
          <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {currentCategoryName}
          </span>
        ) : (
          <span className="rounded-sm bg-amber-200/60 px-1 py-0.5 text-[10px] uppercase tracking-wide text-amber-900 dark:bg-amber-900/50 dark:text-amber-100">
            Uncategorized
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-3 text-xs text-muted-foreground">
        <span>{row.date}</span>
        <span>{row.accountName}</span>
        {row.isPending ? (
          <span className="rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wide">
            Pending
          </span>
        ) : null}
      </div>
      <span className="ml-auto w-24 text-right [font-variant-numeric:tabular-nums]">
        {formatCents(row.amountCents)}
      </span>
      <label className="sr-only" htmlFor={`cat-${row.id}`}>
        Category for transaction {row.id}
      </label>
      <CategoryCombobox
        id={`cat-${row.id}`}
        name="categoryId"
        value={pickerValue}
        onValueChange={setPickerValue}
        categories={leafCategories}
        required
        className="min-w-[10rem]"
      />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          name="rememberMerchant"
          value="true"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-4 w-4"
        />
        Remember
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          name="applyToPast"
          value="true"
          checked={applyToPast}
          onChange={(e) => setApplyToPast(e.target.checked)}
          className="h-4 w-4"
        />
        Apply to past
      </label>
      <button
        type="submit"
        disabled={isPending || !pickerValue || pickerValue === String(currentCategoryId)}
        className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
