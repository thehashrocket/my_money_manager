"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import { notifyUndo, notifyWrite } from "@/components/ledger/write-toast";
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

  /* Derived, not synced. `filed` changes under us on every revalidation — a
     completed move empties the category that was selected — and deriving the
     effective choice each render means there is no stale state to reset and no
     effect to write.

     `undefined` when the chosen category is GONE, and that is deliberately not
     a fallback to `filed[0]`. It used to be, and the substitution was silent
     and armed: `toValue` is untouched by the swap, so `canSubmit` stayed true
     and the button the user had already aimed at was still live — one click
     moved the LARGEST group (`summarizeByCategory` sorts it to the front) off
     a category they never named, and with Remember ticked retrained the rule
     against that set instead. The server refuses this exact condition
     (`NoRowsToRetargetError`), so the client was the laxer of the two. Now it
     refuses too, and says which choice evaporated. */
  const from = filed.find((f) => String(f.categoryId) === fromChoice);
  const chosenIsGone = fromChoice !== "" && from === undefined;
  const effective = from ?? (fromChoice === "" ? filed[0] : undefined);

  const toId = toValue === "" ? null : Number(toValue);
  const canSubmit =
    !isPending &&
    effective !== undefined &&
    toId !== null &&
    Number.isFinite(toId) &&
    toId !== effective.categoryId;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      /* The action returns its refusals as STATE, so this catch is only for
         what is genuinely unexpected — a transport failure, or a bug. Without
         it a throw inside an async `startTransition` callback is an unhandled
         rejection and the user sees nothing at all. */
      let result: Awaited<ReturnType<typeof bulkRetargetAction>>;
      try {
        result = await bulkRetargetAction(formData);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Move failed.");
        return;
      }
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      setRemember(false);
      setToValue("");
      /* `fromChoice` MUST be cleared here, and it is the success path that
         needs it. A complete move empties the source out of `filed` —
         `summarizeByCategory` GROUPs over the remaining rows, so a category
         with none left produces no row — and this component is unkeyed in the
         same tree position, so client state survives the revalidation. Leaving
         the old pick set therefore made `chosenIsGone` true immediately after
         a move that WORKED, and the form accused another tab of doing what the
         user had just done. Clearing it collapses the post-success state back
         into "nothing explicitly picked", where `effective` falls to
         `filed[0]` — now the destination the rows just landed in. */
      setFromChoice("");

      /* ONE toast, never a success plus a warning — rule 6, spelled once in
         `notifyWrite` (this was one of its three hand-copies). Its docstring
         carries the collapsed-stack argument and the reason `result.warning`
         merges in rather than stacking behind. This surface is the one where
         losing the Undo costs the most: a move touches every row for a
         merchant, not one. */
      const moved = `Moved ${result.updatedCount} row${
        result.updatedCount === 1 ? "" : "s"
      } from ${result.fromCategoryName} to ${result.categoryName}.`;
      notifyWrite(moved, [result.ruleRefusal?.message, result.warning], {
        onUndo: async () => {
          let undo: Awaited<ReturnType<typeof undoBulkRetargetAction>>;
          try {
            undo = await undoBulkRetargetAction(result.snapshot);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Undo failed.");
            return;
          }
          if (undo.status === "error") {
            toast.error(undo.message);
            return;
          }
          /* "Moved 0 rows back" is honest but unreadable on its own — it is
             the same sentence whether there was nothing to move or whether
             the user re-categorized all 49 inside the window. The snapshot
             knows which, so it says which. */
          const scope =
            undo.revertedCount === result.snapshot.txnIds.length
              ? ""
              : ` (${result.snapshot.txnIds.length - undo.revertedCount} had been re-categorized since)`;
          notifyUndo(
            `Moved ${undo.revertedCount} row${
              undo.revertedCount === 1 ? "" : "s"
            } back to ${result.fromCategoryName}${scope}.${describeRuleUndo(undo.ruleAction)}`,
            undo.warning,
          );
        },
      });
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
        {effective !== undefined && (
          <input type="hidden" name="fromCategoryId" value={effective.categoryId} />
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-ink-2">Move</span>
            {/* A plain <select>: the choices are this merchant's own filing
                history, usually one or two entries, and each needs a count
                beside its name — neither of which `CategoryCombobox`'s
                search-over-all-categories shape is for. */}
            <select
              value={effective === undefined ? "" : String(effective.categoryId)}
              onChange={(e) => setFromChoice(e.target.value)}
              className={`h-8 rounded-md border border-border bg-background px-2 text-sm ${FOCUS_RING}`}
              aria-label={`Rows to move for ${merchantLabel(normalizedMerchant)}`}
            >
              {/* Only rendered when the picked category has vanished, so the
                  <select> has a value to show that is not silently some other
                  group. Selecting it is not a route back to the old choice —
                  there is nothing to go back to. */}
              {effective === undefined && (
                <option value="">— no longer filed here —</option>
              )}
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
            {isPending
              ? "Moving…"
              : effective === undefined
                ? "Move"
                : `Move ${effective.count}`}
          </button>
        </div>

        {chosenIsGone ? (
          <p className="text-xs text-money-neg">
            The category you picked no longer has rows for this merchant —
            another tab, or an Undo, moved them. Pick one of the groups above.
          </p>
        ) : (
          <p className="text-xs text-ink-3">
            Moves every non-transfer row for this merchant that is filed as{" "}
            {effective?.categoryName} — the whole merchant, not just the rows
            matching the filters above. Ticking Remember retrains the
            merchant&apos;s rule to follow them.
          </p>
        )}
      </form>
    </details>
  );
}
