"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { formatCents } from "@/lib/money";
import type { MerchantGroup } from "@/lib/categorize/loadMerchantGroups";
import type { LeafCategory } from "@/lib/categories";
import { bulkCategorizeMerchantAction, undoBulkCategorizeAction } from "./actions";

type Props = {
  group: MerchantGroup;
  leafCategories: LeafCategory[];
  onOptimisticSubmit: (count: number) => void;
  onUndo: (count: number) => void;
};

/**
 * One row on `/categorize` — dropdown + Remember checkbox + Submit.
 *
 * On submit:
 * - calls `bulkCategorizeMerchantAction` via a transition,
 * - decrements the live backlog counter optimistically,
 * - shows a Sonner toast with a 10s Undo action that fires
 *   `undoBulkCategorizeAction(snapshot)` and reverts the counter.
 */
export function MerchantRow({
  group,
  leafCategories,
  onOptimisticSubmit,
  onUndo,
}: Props) {
  const [categoryId, setCategoryId] = useState<string>(
    group.existingRule ? String(group.existingRule.categoryId) : "",
  );
  const [remember, setRemember] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (dismissed) return null;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!categoryId) return;
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      onOptimisticSubmit(group.count);
      try {
        const result = await bulkCategorizeMerchantAction(formData);
        setDismissed(true);
        toast.success(
          `Categorized ${result.updatedCount} ${group.normalizedMerchant} row${result.updatedCount === 1 ? "" : "s"} as ${result.categoryName}.`,
          {
            duration: 10_000,
            action: {
              label: "Undo",
              onClick: async () => {
                try {
                  const undo = await undoBulkCategorizeAction(result.snapshot);
                  onUndo(undo.revertedCount);
                  setDismissed(false);
                  toast(`Reverted ${undo.revertedCount} row${undo.revertedCount === 1 ? "" : "s"}.`);
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
        // Revert optimistic counter on error.
        onUndo(group.count);
        toast.error(err instanceof Error ? err.message : "Categorize failed.");
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card p-3 text-sm"
    >
      <input type="hidden" name="normalizedMerchant" value={group.normalizedMerchant} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate font-medium">{group.normalizedMerchant}</span>
        {group.existingRule ? (
          <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            → {group.existingRule.categoryName} (rule)
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline gap-3 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground">{group.count}</strong> row
          {group.count === 1 ? "" : "s"}
        </span>
        <span className="[font-variant-numeric:tabular-nums]">
          {formatCents(group.totalCents)}
        </span>
      </div>
      <label className="sr-only" htmlFor={`cat-${group.normalizedMerchant}`}>
        Category for {group.normalizedMerchant}
      </label>
      <select
        id={`cat-${group.normalizedMerchant}`}
        name="categoryId"
        value={categoryId}
        onChange={(e) => setCategoryId(e.target.value)}
        className="h-8 min-w-[10rem] rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        required
      >
        <option value="" disabled>
          Pick a category…
        </option>
        {leafCategories.map((cat) => (
          <option key={cat.id} value={cat.id}>
            {cat.name}
          </option>
        ))}
      </select>
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
      <button
        type="submit"
        disabled={isPending || !categoryId}
        className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Saving…" : "Submit"}
      </button>
    </form>
  );
}
