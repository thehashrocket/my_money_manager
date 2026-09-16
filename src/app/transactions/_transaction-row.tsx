"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import type { LeafCategory } from "@/lib/categories";
import { resolveRememberUi } from "@/lib/categorize/keyTrainability";
import { describeRuleUndo } from "@/lib/categorize/describeRuleUndo";
import type { TransactionRow } from "@/lib/categorize/loadTransactions";
import { formatCents } from "@/lib/money";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import { notifyUndo, notifyWrite } from "@/components/ledger/write-toast";
import { useRememberConsent } from "@/components/ledger/use-remember-consent";
import { hasMerchantName, NO_MERCHANT_NAME } from "@/lib/transactions/merchantLabel";
import type { AccountOption } from "@/lib/accounts/listAccounts";
import { buildHref, type TransactionsFilterValues } from "./_filter-bar";
import { TransactionRowMenu, type ImportingCardOption } from "./_row-menu";
import { cn } from "@/lib/utils";
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
  /** DS52 — credit cards, for the row menu's "Mark as payment to". */
  cardAccounts: AccountOption[];
  /** T9 — cards whose own transactions come in from the feed, with candidates. */
  importingCards: ImportingCardOption[];
  /** Refresh the page after a pairing change, which alters what this list shows. */
  onPairingChanged: () => void;
  /** The whole active filter set — a row's merchant link MERGES into it (D23). */
  filterValues: TransactionsFilterValues;
};

/**
 * T9 (Codex adversarial finding) — is `accountId` a checking/savings account,
 * as opposed to a card? Both `cardAccounts` (non-importing) and
 * `importingCards` are already fetched for this page, so membership in
 * either set is cheaper and more honest than a third server round trip —
 * "not a card we know about" is exactly "an asset account" for every row
 * `/transactions` can render (a mortgage never appears here at all, per
 * `listAccounts`'s own E15 exclusion).
 */
function isAssetAccount(
  accountId: number,
  cardAccounts: AccountOption[],
  importingCards: ImportingCardOption[],
): boolean {
  return (
    !cardAccounts.some((c) => c.id === accountId) &&
    !importingCards.some((c) => c.id === accountId)
  );
}

/**
 * D17 — shared by every row variant and by `TransactionColumnHeaders`, so a
 * column cannot drift out from under its own label.
 *
 * Row 1 is the transaction as a ledger line (merchant · category · date ·
 * account · amount). Row 2 carries the bank memo under the merchant and the
 * per-row controls to its right, which is what lets T8's new memo line cost
 * nothing in height: the controls already needed two lines' worth of room.
 */
export const TXN_ROW_GRID =
  "grid grid-cols-1 items-baseline gap-x-4 gap-y-1.5 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_7rem_6.5rem_8rem_7rem]";

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
  cardAccounts,
  importingCards,
  onPairingChanged,
  onCategorized,
  onUndone,
  filterValues,
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
  const [applyToPast, setApplyToPast] = useState(false);
  const [isPending, startTransition] = useTransition();

  /* "Adjust state during render" — React's documented pattern for resetting
     derived state when a prop changes, and the same shape `_month-editor.tsx`
     uses for its three band props. Using state rather than a ref or an effect
     is enforced here by lint (`react-hooks/refs`, `react-hooks/set-state-in-effect`).

     Without this the three fields above were seeded once at mount and never
     resynced, so anything that recategorized this row WITHOUT going through
     this form left the badge asserting the old category indefinitely. That was
     already reachable from a second tab; `bulkRetargetAction` made it reachable
     in one click on this very page — move 49 rows and the header said
     "49 filed as Groceries" directly above 49 rows each badged GAS. `rows` is
     a new object graph only when the server component actually re-executes, so
     this fires on a genuine fresh payload rather than on any local re-render.

     `pickerValue` is resynced only when it is UNTOUCHED — still equal to the
     row's own category. It is an input holding a half-finished intent, and an
     unrelated revalidation (another row's submit revalidates the whole path)
     must not throw away a category the user has picked but not yet saved. The
     badge has no such claim on it: it reports stored state, so it always
     follows the server. */
  const [prevRow, setPrevRow] = useState(row);
  if (prevRow !== row) {
    const pickerUntouched =
      pickerValue === (prevRow.categoryId !== null ? String(prevRow.categoryId) : "");
    setPrevRow(row);
    setCurrentCategoryId(row.categoryId);
    setCurrentCategoryName(row.categoryName);
    if (pickerUntouched) {
      setPickerValue(row.categoryId !== null ? String(row.categoryId) : "");
    }
    // No explicit reset needed for Remember here — `useRememberConsent`'s
    // mask stops matching on its own the moment `row.existingRule` or
    // `row.filedCategoryIds` changes underneath it (the exact case that used
    // to need this comment), on this same render.
  }

  const merchantFiltered = filterValues.merchant !== undefined;

  const pendingCategoryId = pickerValue === "" ? null : Number(pickerValue);

  /**
   * Everything the checkbox needs, from one call — mirrors
   * `_merchant-row.tsx`'s `rememberUi`, same three-argument call (plus the
   * merchant key) so this agrees with the server's `categorizeTransaction`
   * (which excludes the row itself from the evidence, since it is the one
   * about to move — `row.filedCategoryIds` already does that exclusion, see
   * its own docstring in `loadTransactions.ts`, so this agrees with the
   * server exactly, not just conservatively).
   */
  const rememberUi = resolveRememberUi(
    row.normalizedMerchant,
    row.filedCategoryIds,
    row.existingRule,
    pendingCategoryId,
  );
  // Shared with `_merchant-row.tsx` (`use-remember-consent.ts`,
  // maintainability review finding) — see that hook's own docstring.
  const remember = useRememberConsent(row.normalizedMerchant, rememberUi.action, pendingCategoryId);
  // See the Save button's own comment (PR review, code-reviewer pass,
  // finding 2) for why the escape hatch needs this.
  const pickIsSelectable = leafCategories.some((c) => String(c.id) === pickerValue);

  const handlePick = (next: string) => {
    setPickerValue(next);
    // No consent to clear here — `consentedSignature` is a mask, so a
    // repick that changes what Remember would do simply stops matching it
    // on this same render. See the field's own docstring above.
  };

  const rowId = useId();
  const reasonId = `${rowId}-reason`;

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
        remember.reset();
        setApplyToPast(false);
        onCategorized(priorCategoryId, result.updatedCount);

        /* ONE toast, not a success plus a warning — rule 6. The
           collapsed-stack argument for why two toasts cannot both be read, and
           why `result.warning` (a `revalidatePath` that threw AFTER the write
           committed) merges in rather than stacking behind, is in
           `notifyWrite`'s docstring; this was one of the three hand-copies it
           replaced.

           The Remember checkbox below is disabled up front against
           `row.filedCategoryIds`, the same as `/categorize`'s — so this toast
           is the second channel for a refusal (catching the verdict moving
           under a stale page), not the only one anymore. */
        const filed = `Categorized ${result.updatedCount} row${result.updatedCount === 1 ? "" : "s"} as ${result.categoryName}.`;
        notifyWrite(filed, [result.ruleRefusal?.message, result.warning], {
          onUndo: async () => {
            try {
              const undo = await undoCategorizeTransactionAction(
                result.snapshot,
              );
              const reverted =
                (undo.targetReverted ? 1 : 0) + undo.revertedApplyToPastCount;
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
              notifyUndo(
                `Reverted ${reverted} row${reverted === 1 ? "" : "s"}.${describeRuleUndo(undo.ruleAction)}`,
                undo.warning,
              );
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Undo failed.");
            }
          },
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Categorize failed.");
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      /* D17 [HARD REJECTION] — was `rounded-md border p-3` inside a
         `ul.space-y-2`, i.e. a stack of card slabs rather than a list.
         DS49 already made this exact move on the dashboard.
         The `opacity-60` dimming of already-filed rows is now conditional:
         under a merchant filter the filed rows are the whole point (D3 shows
         all of a merchant's history because "49 already filed as Gas" is the
         answer), so dimming them would leave the one row you already knew
         about as the only thing at full contrast. Also excluded whenever
         there is a reason line to show (Codex design pass, ship review): CSS
         opacity composites the whole subtree, so a child `<p>` cannot opt
         back to full contrast on its own — the one line the user most needs
         at that moment would otherwise render at 60% until they happened to
         be hovering the row. */
      className={`${TXN_ROW_GRID} transition-opacity ${
        currentCategoryId !== null && !merchantFiltered && rememberUi.message === undefined
          ? "opacity-60 hover:opacity-100"
          : ""
      }`}
    >
      <input type="hidden" name="transactionId" value={row.id} />
      <PrimaryLabel row={row} filterValues={filterValues} />
      <MemoLine row={row} merchantFiltered={merchantFiltered} />
      <span className="sm:col-start-2 sm:row-start-1">
        <CategoryBadge name={currentCategoryName} />
      </span>
      <span className="font-mono text-xs text-ink-2 sm:col-start-3 sm:row-start-1">
        {row.date}
      </span>
      <span className="flex items-baseline gap-2 truncate text-xs text-ink-2 sm:col-start-4 sm:row-start-1">
        <span className="truncate">{row.accountName}</span>
        {row.isPending ? (
          <span className="shrink-0 rounded-sm bg-muted px-1 font-mono text-[10px] uppercase tracking-wide">
            Pending
          </span>
        ) : null}
      </span>
      <span className="font-mono sm:col-start-5 sm:row-start-1 sm:text-right">
        {formatCents(row.amountCents)}
      </span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-4 sm:col-start-2 sm:row-start-2 sm:justify-end">
        <label className="sr-only" htmlFor={`cat-${row.id}`}>
          Category for transaction {row.id}
        </label>
        <CategoryCombobox
          id={`cat-${row.id}`}
          name="categoryId"
          value={pickerValue}
          onValueChange={handlePick}
          categories={leafCategories}
          required
          className="min-w-[10rem]"
        />
        {/* Stacked rather than side by side (round2-B) — two short checkbox
            labels in a column are the same height as the memo line beside
            them, so the new second line costs the list no extra height. */}
        <div className="flex flex-col gap-0.5">
          <label
            className={`flex items-center gap-1.5 text-xs ${
              rememberUi.enabled ? "text-ink-2" : "cursor-not-allowed text-ink-3"
            }`}
            title={rememberUi.message}
          >
            <input
              type="checkbox"
              name="rememberMerchant"
              value="true"
              // `checked={remember.checked}` is a MASK, not the raw click
              // state — see `useRememberConsent`'s own docstring for why.
              checked={remember.checked}
              disabled={!rememberUi.enabled}
              aria-describedby={rememberUi.message === undefined ? undefined : reasonId}
              onChange={remember.onChange}
              className="h-4 w-4 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {rememberUi.label}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
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
        </div>
        <button
          type="submit"
          // Ship review, cycle 2 (Codex structured, second pass): an
          // unchanged pick used to always disable Save, but a lossy key
          // (e.g. `ONLINE`) offers `remove-conflicting` REGARDLESS of
          // whether the pick changed — `applyRuleWrite`'s own
          // `reason === "lossy-key"` branch removes such a rule
          // unconditionally. Without this, ticking "Remove conflicting
          // rule" on an already-correctly-filed row had no way to actually
          // submit: the only route to the checkbox's own action would have
          // been to temporarily miscategorize the row and change it back.
          //
          // `pickIsSelectable` (PR review, code-reviewer pass, finding 2):
          // a row filed under a category that was archived (or turned into
          // a parent) AFTER the fact keeps that id as its stored
          // `categoryId` — `leafCategories` excludes it by default
          // (`listLeafCategories`'s `includeArchived: false`), so the
          // combobox renders BLANK while `pickerValue` still holds that
          // unselectable id. Before this escape hatch existed that row was
          // simply unsubmittable (Save was always disabled on an unchanged
          // pick), which hid the mismatch. The escape hatch alone would have
          // let ticking "Remove conflicting rule" submit that stale id
          // straight to `assertAssignableCategory`, which refuses it —
          // aborting the whole write (categorize AND the rule removal) with
          // a generic "Categorize failed." toast. Requiring the pick to be
          // one `leafCategories` can actually render keeps the escape hatch
          // scoped to rows the picker could have produced.
          disabled={
            isPending ||
            !pickerValue ||
            (pickerValue === String(currentCategoryId) &&
              // `remember.checked` can only be true when `rememberUi.enabled`
              // is (a disabled checkbox's `onChange` can never fire, so
              // `consentedSignature` can never take on a "none" signature) —
              // but that's a property of `ruleActionSignature` never
              // colliding across `kind`s, not something this expression
              // enforces on its own. The explicit conjunct is defense in
              // depth (red-team pass) against a future `RuleAction` variant
              // or signature format change silently breaking that property.
              !(remember.checked && rememberUi.enabled && pickIsSelectable))
          }
          className={`h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        <TransactionRowMenu
          transactionId={row.id}
          amountCents={row.amountCents}
          sourceIsAsset={isAssetAccount(row.accountId, cardAccounts, importingCards)}
          isTransfer={false}
          pairIsAppCreated={false}
          transferPartnerAccountName={null}
          // Hand-entered card activity is the only row with a per-row delete;
          // `removeCardActivity` refuses every other kind. Passed rather than
          // derived in the menu so the menu stays a presenter.
          isManual={row.importSource === "manual"}
          cardAccounts={cardAccounts}
          importingCards={importingCards}
          onChanged={onPairingChanged}
        />
        {rememberUi.message === undefined ? null : (
          // Not a `title=` alone — unreachable by keyboard, unreliable to
          // screen readers. `basis-full` puts it on its own line within the
          // same flex row, matching `_merchant-row.tsx`'s equivalent.
          <p
            id={reasonId}
            className="basis-full text-xs text-ink-3 sm:text-right"
          >
            {rememberUi.message}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * D17 — column headers. T8 turns every row into two lines, and an unlabelled
 * second line has nothing orienting it; all four mockups added a header row
 * unprompted for exactly that reason. Hidden below `sm`, where the row stacks.
 */
export function TransactionColumnHeaders({
  merchantFiltered,
}: {
  merchantFiltered: boolean;
}) {
  return (
    <div
      aria-hidden
      /* `cn()`, not a template string: the grid constant already carries
         `py-3`, and Tailwind resolves a `py-3`/`py-2` collision by
         stylesheet order rather than by class-string order — so the
         header's own `py-2` was dead and it rendered at full row height.
         tailwind-merge makes the later class win, which is what the
         shared-template pattern assumed all along. */
      className={cn(
        TXN_ROW_GRID,
        "hidden border-b border-[var(--rule-strong)] bg-[var(--bg-inset)] py-2 font-mono text-[10px] uppercase tracking-wide text-ink-3 sm:grid",
      )}
    >
      <span>{merchantFiltered ? "Memo" : "Merchant / memo"}</span>
      <span>Category</span>
      <span>Date</span>
      <span>Account</span>
      <span className="text-right">Amount</span>
    </div>
  );
}

/**
 * The row's headline.
 *
 * Under an active merchant filter every visible row carries the SAME key, so
 * repeating it 59 times says nothing — the memo is promoted into the primary
 * slot and the merchant name is dropped entirely (the header block above the
 * list already names it, once). Without a merchant filter the merchant name
 * leads, and links into that filter.
 *
 * D23 — the link MERGES into the active filters rather than replacing them.
 * Replacing would silently discard a date range you had deliberately set (and
 * `pageSize`), producing a much larger result set from what reads as a
 * narrowing action. And a row already matching the active merchant links to
 * the page it is standing on, so it renders as plain text instead.
 *
 * The promoted memo wraps to two lines below `sm`, exactly like `MemoLine` —
 * this branch IS the D9 case, not an exception to it. Measured at 390px on a
 * five-row `?merchant=AMAZON` list: four of the five memos overflowed the
 * 316px available (363-396px needed) and a single `truncate` line cut every
 * one of them at the same `AMAZON MKTPLACE PMTS AMZN.COM/BILL…` prefix, with
 * only the `title` tooltip — which touch does not have — to reveal the tail
 * that told them apart. `MemoLine`'s `line-clamp-2` fix landed on the branch
 * that this case never renders.
 */
function PrimaryLabel({
  row,
  filterValues,
}: {
  row: TransactionRow;
  filterValues: TransactionsFilterValues;
}) {
  const memo = row.rawMemo.trim();
  if (filterValues.merchant !== undefined) {
    return (
      <span
        className="min-w-0 line-clamp-2 font-mono text-xs text-ink-1 sm:col-start-1 sm:row-start-1 sm:truncate"
        title={memo || row.normalizedMerchant || undefined}
      >
        {/* The third alternative is a total-function guard, not a case that
            fires here: this branch only runs when a merchant filter is
            active, and every row was then selected by
            `eq(normalized_merchant, merchant)` against a key `flatten` has
            already refused to let be blank — so `row.normalizedMerchant` is
            non-empty. It uses the shared constant rather than a fourth copy
            of the string, which is the whole reason `merchantLabel.ts`
            exists. */}
        {memo || row.normalizedMerchant || NO_MERCHANT_NAME}
      </span>
    );
  }
  /**
   * An empty key gets plain text, not a link.
   *
   * `filterValuesToSearchParams` refuses to emit `?merchant=`, which stops a
   * bad URL but not a bad LINK: the `<Link>` still rendered, styled live and
   * terracotta-underlined, and clicking it navigated to the current filters
   * unchanged — a control promising "narrow to this merchant" that visibly
   * does nothing. `merchantDrilldownHref` returns `null` on `/categorize` for
   * exactly this case; the guard has to be re-made here because this path
   * builds its href through `buildHref` instead.
   *
   * Reachable, not hypothetical: `parseCsv` passes the Memo column through
   * unchecked, `normalizeMerchant("")` returns `""` (pinned in
   * `normalize.test.ts`), and no write path rejects it — so one blank Memo
   * cell produces a stored key of `""`.
   */
  if (!hasMerchantName(row.normalizedMerchant)) {
    return (
      <span className="min-w-0 truncate font-medium text-ink-3 sm:col-start-1 sm:row-start-1">
        {NO_MERCHANT_NAME}
      </span>
    );
  }
  return (
    <Link
      href={buildHref({ ...filterValues, merchant: row.normalizedMerchant })}
      /* One of these per row; the destination is dynamic and has its own
         `loading.tsx`, so eager prefetch buys a shell the route already
         provides (D8). */
      prefetch={false}
      title={row.normalizedMerchant}
      className={`block min-w-0 truncate font-medium text-terracotta underline underline-offset-4 visited:text-ink-2 hover:no-underline sm:col-start-1 sm:row-start-1 ${FOCUS_RING}`}
    >
      {row.normalizedMerchant}
    </Link>
  );
}

/**
 * D9 — the bank's own text for the row, readable without hovering.
 *
 * `normalized_merchant` is a deliberately lossy key, so a merchant-filtered
 * list used to render 59 rows all labelled `AMAZON`. The memo is what tells
 * them apart. `payee` is not used for this: it is NULL on 99.2% of rows
 * (1,527 of 1,540) because only the SimpleFIN feed carries it.
 *
 * Suppressed when the memo IS the key — true on 151 rows (9.8%) — so one row
 * in ten does not render its first line twice. Also suppressed when the memo
 * has already been promoted into the primary slot above.
 *
 * Two lines below `sm`, one line above it. Measured on the ledger, memos run 8-72 chars (median 40); the merchant-
 * filtered case this is arguing about is the long end — all 59 `AMAZON`
 * memos are exactly 48 —
 * and the desktop escape hatch for the overflow is the `title` tooltip — which
 * does not exist on touch. Truncating to one line at 375px would throw away
 * most of the only text that distinguishes 59 rows all labelled `AMAZON`,
 * with nothing to reveal the rest, which is the exact failure D9 exists to
 * fix. `line-clamp-2` rather than full wrapping keeps the row height bounded.
 */
function MemoLine({
  row,
  merchantFiltered,
}: {
  row: TransactionRow;
  merchantFiltered: boolean;
}) {
  const memo = row.rawMemo.trim();
  if (merchantFiltered || memo === "" || memo === row.normalizedMerchant) return null;
  return (
    <span
      className="min-w-0 line-clamp-2 font-mono text-[var(--text-xs)] text-ink-3 sm:col-start-1 sm:row-start-2 sm:truncate"
      title={memo}
    >
      {memo}
    </span>
  );
}

/**
 * D20 — monochrome, with one exception. 53 leaf categories against 5 accents
 * any cycling palette invents a relationship between whichever categories
 * happen to collide, so the badge carries the name and nothing else. Amber is
 * the exception because `Uncategorized` is not a category, it is a STATE —
 * the same state the backlog strip above the list is counting.
 *
 * T14/D21: the shared `color-mix(… var(--accent-amber) …)` formula, not
 * Tailwind's raw `amber-*` palette. DESIGN.md's audit named this badge as one
 * of the three surfaces that had drifted off the token entirely.
 */
function CategoryBadge({ name }: { name: string | null }) {
  if (name !== null) {
    return (
      <span className="inline-block max-w-full truncate rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-2">
        {name}
      </span>
    );
  }
  return (
    <span
      className="inline-block rounded-sm px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide"
      style={{
        background: "color-mix(in oklch, var(--accent-amber) 22%, var(--background))",
        color: "color-mix(in oklch, var(--accent-amber) 55%, var(--foreground))",
      }}
    >
      Uncategorized
    </span>
  );
}

/**
 * A transfer-paired row, revealed by T26's "show transfers" toggle.
 *
 * Deliberately NOT the categorize form. A paired row is money moving between
 * your own accounts: it is excluded from every spend query by the existing
 * `transfer_pair_id IS NULL` filters, the synthetic mirror carries
 * `category_id = NULL` on purpose, and offering a category picker here would
 * invite a positive amount into an expense category — which produces negative
 * `spentCents`, the exact state `resolveRowDisplay`'s `looksLikeIncome` flag
 * exists to complain about.
 *
 * What it does offer is the way back out, via the same `⋯` menu.
 */
export function TransferRowItem({
  row,
  cardAccounts,
  importingCards,
  onPairingChanged,
  filterValues,
}: {
  row: TransactionRow;
  cardAccounts: AccountOption[];
  importingCards: ImportingCardOption[];
  onPairingChanged: () => void;
  filterValues: TransactionsFilterValues;
}) {
  const merchantFiltered = filterValues.merchant !== undefined;
  return (
    <div
      className={TXN_ROW_GRID}
      style={{
        background: "color-mix(in oklch, var(--accent-indigo) 6%, transparent)",
      }}
    >
      <PrimaryLabel row={row} filterValues={filterValues} />
      <MemoLine row={row} merchantFiltered={merchantFiltered} />
      <span className="sm:col-start-2 sm:row-start-1">
        <span
          className="inline-block max-w-full truncate rounded-sm px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide"
          style={{
            background: "color-mix(in oklch, var(--accent-indigo) 18%, var(--background))",
            color: "color-mix(in oklch, var(--accent-indigo) 60%, var(--foreground))",
          }}
        >
          {row.transferPartnerAccountName
            ? `Paired · ${row.transferPartnerAccountName}`
            : "Paired"}
        </span>
      </span>
      <span className="font-mono text-xs text-ink-2 sm:col-start-3 sm:row-start-1">
        {row.date}
      </span>
      <span className="truncate text-xs text-ink-2 sm:col-start-4 sm:row-start-1">
        {row.accountName}
      </span>
      <span className="font-mono sm:col-start-5 sm:row-start-1 sm:text-right">
        {formatCents(row.amountCents)}
      </span>
      <div className="flex items-center sm:col-span-4 sm:col-start-2 sm:row-start-2 sm:justify-end">
        <TransactionRowMenu
          transactionId={row.id}
          amountCents={row.amountCents}
          // Irrelevant on this branch (isTransfer is always true here, and
          // "Link to a card charge" only renders on the non-transfer branch)
          // — computed honestly anyway rather than hard-coded, same reasoning
          // `isManual` below already documents.
          sourceIsAsset={isAssetAccount(row.accountId, cardAccounts, importingCards)}
          isTransfer
          pairIsAppCreated={row.pairIsAppCreated}
          transferPartnerAccountName={row.transferPartnerAccountName}
          // Always false in effect on this branch — a paired row is a payment
          // leg, which `removeCardActivity` refuses and "Not a card payment"
          // owns. Passed honestly rather than hard-coded so the menu's own
          // precedence rule stays the single place that decides.
          isManual={row.importSource === "manual"}
          cardAccounts={cardAccounts}
          importingCards={importingCards}
          onChanged={onPairingChanged}
        />
      </div>
    </div>
  );
}
