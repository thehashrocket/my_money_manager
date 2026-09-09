"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import type { LeafCategory } from "@/lib/categories";
import { describeRuleUndo } from "@/lib/categorize/describeRuleUndo";
import { merchantLabel } from "@/lib/transactions/merchantLabel";
import { bulkRetargetAction, undoBulkRetargetAction } from "./actions";

/** One category this merchant already has rows filed under, and how many. */
export type FiledCategory = {
  categoryId: number;
  categoryName: string;
  count: number;
};

type Props = {
  normalizedMerchant: string;
  /**
   * The merchant's filing history across the WHOLE key — summarised on
   * `{ merchant }` alone, never on the page's live filter set.
   *
   * This is the one number on the page that is deliberately NOT the list's.
   * `MerchantSummary` above describes the filtered list, because that is what
   * a header is for; this control's action is key-scoped (see `bulkRetarget`),
   * and labelling a button "Move 3 rows" while it moves 53 is the failure that
   * sibling's `scoped` flag exists to avoid. Same rule, opposite direction:
   * there the honest move was to drop the number, here it is to show the true
   * one.
   */
  filed: FiledCategory[];
  leafCategories: LeafCategory[];
};

/**
 * Bulk retarget for the merchant drilldown — "these 49 are filed as Gas, move
 * them to Groceries."
 *
 * ## Why it lives here and not on `/categorize`
 *
 * `loadMerchantGroups` selects on `category_id IS NULL`, so filing a group is
 * what makes it VANISH from `/categorize`. The mis-filing this repairs is
 * therefore never visible on the page where it happened; by the time you want
 * it back the group is gone and only the exact-merchant drilldown still lists
 * the rows. `/categorize`'s own "See all N transactions →" link already lands
 * here, so the path existed before the control did.
 *
 * ## Why Remember has no client-side disable
 *
 * `/categorize` disables its checkbox up front by running
 * `classifyKeyTrainability` in the browser against `filedCategoryIds`. This
 * form deliberately does not, even though it holds a filing history and could
 * fake one: `filedCategoryEvidenceWhere` also skips rows whose category is
 * ARCHIVED, and `summarizeByCategory` — which feeds `filed` — does not. A
 * client verdict built from this list would be stricter than the server's on
 * exactly the merchants that have an archived category in their past,
 * disabling a checkbox the server would have honoured. A second, subtly
 * disagreeing copy of the verdict is worse than answering a beat late, so the
 * server decides and the toast reports, which is also what the row form on
 * this same page does and for a related reason.
 *
 * A `<details>` disclosure, matching the app's pattern for secondary content
 * (`BudgetHelpPanel`, `/goals`): this is a repair, not the page's main verb,
 * and it should not shout at someone who came here to read.
 */
export function RetargetForm({
  normalizedMerchant,
  filed,
  leafCategories,
}: Props) {
  const [fromChoice, setFromChoice] = useState("");
  const [toValue, setToValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [isPending, startTransition] = useTransition();

  // After the hooks, never before them. The caller already gates on this, so
  // it is a second belt rather than the mechanism.
  if (filed.length === 0) return null;

  // Derived, not synced. `filed` changes under us on every revalidation — a
  // completed move empties the category that was selected — and deriving the
  // effective choice each render means there is no stale state to reset and no
  // effect to write. Falls back to the largest group, which `summarizeByCategory`
  // has already sorted to the front.
  const from =
    filed.find((f) => String(f.categoryId) === fromChoice) ?? filed[0];

  const toId = toValue === "" ? null : Number(toValue);
  const canSubmit =
    !isPending && toId !== null && Number.isFinite(toId) && toId !== from.categoryId;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      try {
        const result = await bulkRetargetAction(formData);
        setRemember(false);
        setToValue("");

        /* ONE toast, never a success plus a warning — `<Toaster>` runs
           Sonner's default collapsed stack, where a non-front toast has its
           contents INCLUDING its action button drawn at `opacity: 0` until the
           stack is hovered. Two toasts would force a choice between the
           refusal being readable and this Undo being reachable, and this Undo
           is the only way back for a move that just touched every row for a
           merchant. */
        const moved = `Moved ${result.updatedCount} row${
          result.updatedCount === 1 ? "" : "s"
        } from ${result.fromCategoryName} to ${result.categoryName}.`;
        const notify =
          result.ruleRefusal === null ? toast.success : toast.warning;
        notify(
          result.ruleRefusal === null
            ? moved
            : `${moved} ${result.ruleRefusal.message}`,
          {
            duration: 10_000,
            action: {
              label: "Undo",
              onClick: async () => {
                try {
                  const undo = await undoBulkRetargetAction(result.snapshot);
                  toast(
                    `Moved ${undo.revertedCount} row${
                      undo.revertedCount === 1 ? "" : "s"
                    } back to ${result.fromCategoryName}.${describeRuleUndo(undo.ruleAction)}`,
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
        toast.error(err instanceof Error ? err.message : "Move failed.");
      }
    });
  };

  return (
    <details className="group rounded-lg bg-[var(--bg-raised)] p-3 shadow-soft">
      <summary
        /* `py-2.5 -my-2.5` buys the 44px touch floor (DS66) without making
           the row taller — the same recipe `_merchant-row.tsx` uses on its
           own <summary>. */
        className={`flex cursor-pointer select-none items-center py-2.5 -my-2.5 font-mono text-xs uppercase tracking-wide text-ink-2 group-open:mb-3 ${FOCUS_RING}`}
      >
        Move filed rows to another category
      </summary>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="hidden"
          name="normalizedMerchant"
          value={normalizedMerchant}
        />
        <input type="hidden" name="fromCategoryId" value={from.categoryId} />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-ink-2">Move</span>
            {/* A plain <select>: the choices are this merchant's own filing
                history, usually one or two entries, and each needs a count
                beside its name — neither of which `CategoryCombobox`'s
                search-over-all-categories shape is for. */}
            <select
              value={String(from.categoryId)}
              onChange={(e) => setFromChoice(e.target.value)}
              className={`h-8 rounded-md border border-border bg-background px-2 text-sm ${FOCUS_RING}`}
              aria-label={`Rows to move for ${merchantLabel(normalizedMerchant)}`}
            >
              {filed.map((f) => (
                <option key={f.categoryId} value={String(f.categoryId)}>
                  {f.count} row{f.count === 1 ? "" : "s"} filed as{" "}
                  {f.categoryName}
                </option>
              ))}
            </select>
          </label>
          {/* Explicit sr-only label, matching the two other CategoryCombobox
              callers. Wrapping the visible "to" made the control's whole
              accessible name the word "to". */}
          <label className="sr-only" htmlFor="retarget-to">
            Category to move these rows to
          </label>
          <div className="flex items-center gap-2">
            <span className="text-ink-2" aria-hidden="true">
              to
            </span>
            <CategoryCombobox
              id="retarget-to"
              name="categoryId"
              value={toValue}
              onValueChange={setToValue}
              categories={leafCategories}
              required
              className="min-w-[10rem]"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
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
            disabled={!canSubmit}
            className={`h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
          >
            {isPending ? "Moving…" : `Move ${from.count}`}
          </button>
        </div>

        <p className="text-xs text-ink-3">
          Moves every non-transfer row for this merchant that is filed as{" "}
          {from.categoryName} — the whole merchant, not just the rows matching
          the filters above. Ticking Remember retrains the merchant&apos;s rule
          to follow them.
        </p>
      </form>
    </details>
  );
}
