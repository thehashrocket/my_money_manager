"use client";

import Link from "next/link";
import { useId, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { formatCents } from "@/lib/money";
import { merchantDrilldownHref } from "@/lib/budget/transactionsDrilldownHref";
import type { MerchantGroup } from "@/lib/categorize/loadMerchantGroups";
import type { LeafCategory } from "@/lib/categories";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import { hasMerchantName, merchantLabel } from "@/lib/transactions/merchantLabel";
import { classifyKeyTrainability } from "@/lib/categorize/keyTrainability";
import { describeRuleUndo } from "@/lib/categorize/describeRuleUndo";
import { bulkCategorizeMerchantAction, undoBulkCategorizeAction } from "./actions";
import {
  clearPendingPick,
  noPendingPick,
  readPendingPick,
  subscribePendingPicks,
  writePendingPick,
} from "./_pending-pick";

type Props = {
  group: MerchantGroup;
  leafCategories: LeafCategory[];
  onOptimisticSubmit: (count: number) => void;
  onUndo: (count: number) => void;
  /** Lifted so the page can count "12 of 181 merchants done" (T15/D18). */
  onDismissedChange: (normalizedMerchant: string, dismissed: boolean) => void;
};

/** The chevron's own column, reserved on every row so names line up. */
const CHEVRON_SLOT = "w-2 shrink-0";

/**
 * Shared by the row and by `ColumnHeaders` — one template string, so a column
 * cannot drift out from under its own label.
 */
export const ROW_GRID =
  "grid grid-cols-1 items-baseline gap-x-3 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_5rem_7rem]";

/**
 * One row on `/categorize` — the merchant's own evidence, then the decision.
 *
 * D16/D22: the merchant name is a `<details>` control, not a link. Three
 * reviewers independently found that the failure point here was the ROUND
 * TRIP, not the missing detail — "AMAZON, 53 rows, −$2,411" doesn't say
 * whether that was groceries or a laptop, and the only way to find out was to
 * leave the page you are working through. Opening the name shows up to three
 * of the group's real bank memos in place; the drilldown to `/transactions`
 * is the escape hatch for when three isn't enough. That drilldown sits
 * OUTSIDE the disclosure, not inside it — see the comment at the render site
 * for why nesting it there made it unreachable for the groups that need it
 * most.
 *
 * Making the name a disclosure rather than a link closes four things at once
 * that a bare link opened: it halves the added tab stops, a truncated 69-char
 * key is no longer also an ambiguous link target, the control is no longer
 * inside a dimmed row (this PR drops that dimming entirely — rule-backed rows
 * now render at full-strength ink, with the `→ CATEGORY (RULE)` badge
 * carrying the settled signal), and the common case no longer navigates away
 * from unsaved state at all.
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
  onDismissedChange,
}: Props) {
  const [remember, setRemember] = useState(false);
  const [isPending, startTransition] = useTransition();

  const merchant = group.normalizedMerchant;

  /**
   * T11/D19 — `sessionStorage` IS this field's state, not a copy of it.
   *
   * The pick has to survive following "See all N transactions" and coming
   * back, and the app does not set `cacheComponents`, so that navigation
   * genuinely unmounts this component and destroys any `useState`. Holding it
   * in React state and syncing to storage would need a restore-on-mount
   * effect; making storage the source of truth removes the second copy — and
   * with it the question of which copy is right.
   */
  const storedPick = useSyncExternalStore(
    subscribePendingPicks,
    () => readPendingPick(merchant),
    noPendingPick,
  );
  const categoryId =
    storedPick ?? (group.existingRule ? String(group.existingRule.categoryId) : "");

  const handlePick = (next: string) => {
    writePendingPick(merchant, next);
    /* CLEAR the tick rather than only masking it. `checked={remember &&
       trainable}` un-ticks the box on screen, but `remember` stays true, so
       picking a trainable category again resurrected a tick the user had not
       re-made — and on that submit a rule really would be written. The mask
       stays as well, because the verdict can also change from underneath a
       stale page. */
    if (
      !classifyKeyTrainability(
        merchant,
        group.filedCategoryIds,
        next === "" ? null : Number(next),
      ).trainable
    ) {
      setRemember(false);
    }
  };

  /**
   * Whether "Remember" may write a rule for this key, evaluated against the
   * category currently picked — not against the key alone.
   *
   * Passing the pick SEPARATELY from the filed ids is what makes this agree
   * with the server: `bulkCategorize` calls the same pure predicate with the
   * same two arguments, so the checkbox is disabled exactly when the write
   * would be refused, and the sentence shown here is the sentence the server
   * would have returned. Folding them into one array at each call site — which
   * this used to do — is what let the client hand over `Number("")` as a
   * phantom second category; `classifyKeyTrainability` now decides what counts
   * as a real id, once, for both sides.
   */
  const trainability = classifyKeyTrainability(
    merchant,
    group.filedCategoryIds,
    categoryId === "" ? null : Number(categoryId),
  );

  /* ONE `useId` base, and both ids on this row derive from it.
     `id={`cat-${merchant}`}` was the previous spelling for the combobox, and
     while it works (`htmlFor` is a DOM association, not a CSS selector) it is
     not something to reach for: 17 of the 363 real keys carry `# * ? /` (see
     `merchantDrilldownHref`), so the resulting id needs `CSS.escape` before it
     can appear in any selector, and two keys differing only in stripped
     punctuation would collide outright. Deriving both from `useId` also stops
     this file contradicting itself, which it did while the reason element used
     `useId` and the control eight lines below used the raw key. */
  const rowId = useId();
  const categoryFieldId = `${rowId}-cat`;
  const reasonId = `${rowId}-reason`;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!categoryId) return;
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      onOptimisticSubmit(group.count);
      try {
        const result = await bulkCategorizeMerchantAction(formData);
        clearPendingPick(merchant);
        onDismissedChange(merchant, true);
        /* ONE toast, not a success plus a warning. `<Toaster>` runs Sonner's
           default collapsed stack (`expand` unset — `layout.tsx`), where
           `[data-front="false"] > *` is `opacity: 0`: whichever toast is not
           newest has its contents, INCLUDING its action button, drawn
           invisible until the stack is hovered. Two toasts therefore forced a
           choice between the warning being readable and the Undo being
           reachable, and the Undo is the only thing that puts a removed rule
           back inside its 10s window. Merging them makes the notice and its
           remedy the same front toast. */
        const filed = `Categorized ${result.updatedCount} ${merchant} row${result.updatedCount === 1 ? "" : "s"} as ${result.categoryName}.`;
        const notify =
          result.ruleRefusal === null ? toast.success : toast.warning;
        notify(
          result.ruleRefusal === null
            ? filed
            : `${filed} ${result.ruleRefusal.message}`,
          {
            duration: 10_000,
            action: {
              label: "Undo",
              onClick: async () => {
                try {
                  const undo = await undoBulkCategorizeAction(result.snapshot);
                  onUndo(undo.revertedCount);
                  onDismissedChange(merchant, false);
                  toast(
                    `Reverted ${undo.revertedCount} row${undo.revertedCount === 1 ? "" : "s"}.${describeRuleUndo(undo.ruleAction)}`,
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
        // Revert optimistic counter on error.
        onUndo(group.count);
        toast.error(err instanceof Error ? err.message : "Categorize failed.");
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      /* D17 — the row is a grid on the same template as `ColumnHeaders`, so
         the header labels actually sit above the columns they name. The
         evidence (merchant, counts, and the disclosure panel) occupies row 1;
         the decision occupies row 2. Splitting them that way is what gives
         the sample memos the full column width they need to be readable —
         wedged beside the picker they wrapped every line. Below `sm` the
         whole thing stacks in DOM order. */
      className={ROW_GRID}
    >
      <input type="hidden" name="normalizedMerchant" value={merchant} />
      <MerchantDisclosure group={group} />
      <span className="text-xs text-ink-2 sm:col-start-2 sm:row-start-1 sm:text-right">
        <strong className="text-foreground">{group.count}</strong> row
        {group.count === 1 ? "" : "s"}
      </span>
      <span className="font-mono text-xs text-ink-2 sm:col-start-3 sm:row-start-1 sm:text-right">
        {formatCents(group.totalCents)}
      </span>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-3 sm:col-start-1 sm:row-start-2 sm:justify-end">
        <label className="sr-only" htmlFor={categoryFieldId}>
          Category for {merchantLabel(merchant)}
        </label>
        <CategoryCombobox
          id={categoryFieldId}
          name="categoryId"
          value={categoryId}
          onValueChange={handlePick}
          categories={leafCategories}
          required
          className="min-w-[10rem]"
        />
        <label
          className={`flex min-h-11 items-center gap-1.5 text-xs ${
            trainability.trainable ? "text-ink-2" : "cursor-not-allowed text-ink-3"
          }`}
          title={trainability.trainable ? undefined : trainability.message}
        >
          <input
            type="checkbox"
            name="rememberMerchant"
            value="true"
            /* Never `checked={remember}` alone: the verdict moves with the
               category picked above, so a box ticked while the key still
               looked trainable has to un-tick itself when the pick makes it
               untrainable — otherwise the form posts a Remember the server
               will refuse, and the user is told after the fact instead of
               before. */
            checked={remember && trainability.trainable}
            disabled={!trainability.trainable}
            /* The reason is the checkbox's accessible description, not just
               text that happens to sit nearby: `basis-full` puts it on its
               own line below the Submit button, so proximity alone does not
               connect the two. */
            aria-describedby={
              trainability.trainable ? undefined : reasonId
            }
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 disabled:cursor-not-allowed disabled:opacity-50"
          />
          Remember
        </label>
        <button
          type="submit"
          disabled={isPending || !categoryId}
          className={`h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
        >
          {isPending ? "Saving…" : "Submit"}
        </button>
        {/* Not a `title=` alone. A disabled control with no visible reason is
            the thing the user files a bug about; and `title` is unreachable by
            keyboard and unreliable to screen readers. `basis-full` puts it on
            its own line inside the same flex row rather than adding a grid
            cell the `ColumnHeaders` template would then have to know about. */}
        {trainability.trainable ? null : (
          /* `sm:text-right`, not `text-right`: the row it belongs to only
             right-aligns above `sm` (`sm:justify-end` on the wrapper), so a
             hard right-align left a stray right-edge sentence under a
             left-aligned control stack on narrow screens. `text-xs` matches
             the Remember label two elements up — the 11px `--text-xs` token
             put the one sentence that has to be read at the smallest size on
             the row. */
          <p
            id={reasonId}
            className="basis-full text-xs text-ink-3 sm:text-right"
          >
            {trainability.message}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * The merchant name, and what it opens.
 *
 * A group with nothing to disclose renders NO control — not a control that
 * opens onto an empty panel. That case is real and common: on the live ledger
 * `TRIM(raw_memo)` equals the key itself on 151 of 1,540 rows, and
 * `loadMerchantGroups` drops those samples rather than repeat the line above.
 *
 * The drilldown link is rendered in BOTH branches, not just inside the panel.
 * "Nothing to disclose" and "nothing to link to" are different facts, and
 * conflating them took the escape hatch away from precisely the rows that
 * cannot explain themselves any other way.
 */
function MerchantDisclosure({ group }: { group: MerchantGroup }) {
  const merchant = group.normalizedMerchant;
  const href = merchantDrilldownHref(merchant);
  const badge = group.existingRule ? (
    <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-2">
      → {group.existingRule.categoryName} (rule)
    </span>
  ) : null;

  const drilldown =
    href === null ? null : (
      <Link
        href={href}
        /* D8 — 181 of these on one page; the destination is dynamic and
           already has its own `loading.tsx`, so eager prefetching buys a
           shell the route provides anyway. `visited:` distinguishes the
           merchants already looked at on a page worked through in passes. */
        prefetch={false}
        className={`inline-flex min-h-11 items-center text-[var(--text-xs)] text-terracotta underline underline-offset-4 visited:text-ink-3 hover:no-underline ${FOCUS_RING}`}
      >
        See all {group.totalRowCount} transaction
        {group.totalRowCount === 1 ? "" : "s"} →
      </Link>
    );

  if (group.sampleMemos.length === 0) {
    return (
      <div className="min-w-0 sm:col-start-1 sm:row-start-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* Holds the chevron's column so a row with nothing to disclose still
              starts its name on the same x as the rows around it. */}
          <span aria-hidden className={CHEVRON_SLOT} />
          <span
            className={`truncate font-medium${hasMerchantName(merchant) ? "" : " text-ink-3"}`}
            title={merchantLabel(merchant)}
          >
            {merchantLabel(merchant)}
          </span>
          {badge}
        </div>
        {/* The drilldown is NOT part of what the disclosure hides. Nesting it
            there made it unreachable for exactly the groups that need it most:
            "nothing to disclose" means the group has no memo that adds
            anything to its key — every memo equalling the key once trimmed
            (`loadSampleMemos` compares `TRIM(raw_memo)`, and blank memos are
            dropped by the same query) — so the row shows a bare key it cannot
            elaborate on and the only way to see the underlying transactions
            was gone. Measured live on a four-group fixture: the one group with
            no distinct memos rendered no link at all. */}
        {drilldown === null ? null : <div className="mt-1 pl-4">{drilldown}</div>}
      </div>
    );
  }

  return (
    <details className="group min-w-0 sm:col-start-1 sm:row-start-1">
      <summary
        /* `py-2.5 -my-2.5` buys the 44px touch floor (DS66) without making
           the row itself taller. `list-none` + the explicit chevron replaces
           the UA marker, which sits outside the padded hit area. */
        /* Chrome keeps `::-webkit-details-marker` once `display:flex` takes
           the summary out of `list-item`, so `list-none` alone leaves a second
           stray triangle beside ours. */
        className={`flex cursor-pointer list-none items-baseline gap-2 py-2.5 -my-2.5 text-terracotta underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}
        title={merchantLabel(merchant)}
      >
        <span
          aria-hidden
          className={`${CHEVRON_SLOT} self-center text-[9px] leading-none transition-transform group-open:rotate-90`}
          style={{ transitionDuration: "var(--motion-quick)", transitionTimingFunction: "var(--motion-ease)" }}
        >
          ▶
        </span>
        <span className={`truncate font-medium${hasMerchantName(merchant) ? "" : " text-ink-3"}`}>
          {merchantLabel(merchant)}
        </span>
        {badge}
      </summary>
      <div className="mt-2 space-y-1.5 border-l border-[var(--rule-faint)] pl-3">
        <ul className="space-y-0.5">
          {group.sampleMemos.map((memo) => (
            <li key={memo} className="break-words font-mono text-[var(--text-xs)] text-ink-3">
              {memo}
            </li>
          ))}
        </ul>
        {drilldown}
      </div>
    </details>
  );
}
