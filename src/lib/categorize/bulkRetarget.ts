import { and, eq, isNull, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRolloverMany } from "@/lib/budget";
import { parseIsoMonth } from "@/lib/budget/monthOfIso";
import { CategoryNotFoundError } from "@/lib/categoryErrors";
import { applyRuleWrite, type RuleRefusalReport } from "./applyRuleWrite";
import { assertAssignableCategory } from "./assertAssignableCategory";
import {
  NoRowsToRetargetError,
  SameCategoryRetargetError,
} from "./bulkRetargetErrors";
import type { PriorRuleSnapshot } from "./priorRuleSnapshot";
import type { BulkRetargetInput } from "./validateBulkRetargetInput";

type Db = typeof defaultDb;

export type BulkRetargetSnapshot = {
  normalizedMerchant: string;
  /** The category the rows were filed under before this call. */
  fromCategoryId: number;
  /** The category every `txnIds` row now points at. */
  categoryId: number;
  /**
   * IDs of the transactions actually moved from `fromCategoryId` →
   * `categoryId`.
   *
   * Every one of them had the SAME prior category, which is the single
   * property that keeps this undo as simple as `undoBulkCategorize`'s. The
   * sibling gets away with a hardcoded `null` because its rows were all
   * uncategorized; this one gets away with a single `fromCategoryId` because
   * the row set is defined BY that category. A control that moved "everything
   * for this merchant, wherever it is filed" would need a prior category per
   * row and an undo that groups by it — see the note on `bulkRetarget` for
   * why that control does not exist.
   */
  txnIds: number[];
  /**
   * True when this call changed the rules table — either Remember was ticked
   * and a rule was upserted, or the trainability guard refused and deleted the
   * rule that was already there. Both give the undo something to reverse.
   */
  ruleTouched: boolean;
  /**
   * The rule row as it stood before this call: `null` when no exact rule
   * existed, otherwise the row that was overwritten (upsert) or removed
   * (refusal). The undo restores it either way and cannot tell the two apart.
   */
  priorRule: PriorRuleSnapshot | null;
  /**
   * ID of the newly inserted rule row when `priorRule = null`. The undo
   * deletes by primary key rather than by (match_type, match_value,
   * category_id) — unsafe once a second writer can retarget that row inside
   * the 10s window, and `/subscriptions` is such a writer.
   */
  insertedRuleId: number | null;
  /** Earliest `date` among `txnIds` (YYYY-MM-DD). Never null — the call
   *  refuses an empty row set rather than returning one. */
  earliestDate: string;
};

export type BulkRetargetOptions = {
  /**
   * Let a refusal REMOVE the exact rule the user has just contradicted. Off by
   * default and never sourced from a form — `applyRuleWrite` owns the
   * reasoning. `/transactions`' retarget opts in, for the same reason its row
   * form does: this is a deliberate, per-merchant retrain.
   */
  allowRuleRemoval?: boolean;
};

export type BulkRetargetResult = BulkRetargetSnapshot & {
  /** Rows actually moved (== `txnIds.length`, and always ≥ 1). */
  updatedCount: number;
  /** Destination category name — for the Sonner toast. */
  categoryName: string;
  /** Source category name — for the same toast, and for the undo's. */
  fromCategoryName: string;
  /**
   * Set when Remember was ticked but the key still cannot back a rule, and
   * this is the one path where that answer routinely CHANGES as a result of
   * the call — see the `excludeTxnIds` note below. Rows are still moved; only
   * the rule is withheld. Deliberately not part of the snapshot: it is the
   * reason for a decision, not state to reverse.
   */
  ruleRefusal: RuleRefusalReport | null;
};

/**
 * Move every non-transfer row for `normalizedMerchant` that is currently filed
 * under `fromCategoryId` onto `categoryId`, in one transaction.
 *
 * **This is the repair path for a bulk categorize that went to the wrong
 * category.** Until it existed, `applyToPast` on both write paths only touched
 * `category_id IS NULL` rows, so once a merchant group had been filed the only
 * way back was one row at a time through `/transactions`' row form, after the
 * 10-second Sonner undo had expired.
 *
 * ## Why the source is a category and not "everything for this merchant"
 *
 * The row set is `(merchant, fromCategoryId)`, so every moved row shares one
 * prior category and the snapshot needs a single `fromCategoryId` rather than
 * a prior category per row. That is not only an implementation convenience: a
 * merchant filed across three categories is a merchant whose rows the user has
 * distinguished on purpose (`AMAZON` is the standing example in this repo, and
 * split transactions are an explicit V1 exclusion), and a control that
 * collapsed all three in one click could not be described honestly in a toast.
 * Moving two of three categories is two deliberate acts, each separately
 * undoable.
 *
 * ## Why the row set is the whole KEY and not the visible list
 *
 * `/transactions` can be narrowed by date, account, amount and search, and the
 * header's breakdown deliberately describes the filtered list. This action does
 * not: like `bulkCategorize`, it derives its rows server-side from the key, and
 * the caller sends no filters. The alternative — round-tripping the live filter
 * set through the form so the write matches the list — means re-entering the
 * URL-contract machinery `_filter-bar.test.ts` exists to guard, on a write
 * path, in exchange for a narrowing nobody asked for. The UI's job is
 * therefore to show the KEY-wide count, which it does by summarising on
 * `{ merchant }` alone rather than on the page's predicates.
 *
 * ## Rules
 *
 * `applyRuleWrite` decides, as everywhere else. `excludeTxnIds` is the whole
 * row set, and it matters more here than on any other caller: the rows being
 * moved are exactly the evidence that made the key look multi-category, so
 * without the exclusion the guard would refuse to retrain a key THIS CALL is
 * about to make unanimous. Retarget 49 `Gas` rows to `Groceries` on a key
 * whose only other rows are already `Groceries`, and the verdict has to be
 * read against the ledger the action leaves behind. That is the "two-step the
 * user could actually complete" that `TODOS.md` records as missing: move the
 * history, then let the rule follow it.
 *
 * ## Invalidation
 *
 * BOTH categories, from the earliest moved month. Spend left `fromCategoryId`
 * and arrived on `categoryId` starting that month, so every downstream
 * rollover row for either must recompute. `bulkCategorize` invalidates one
 * because its rows came from NULL; this one always has a real source.
 *
 * Throws rather than returning a no-op result when there is nothing to move
 * (`NoRowsToRetargetError`) or when source and destination match
 * (`SameCategoryRetargetError`). Both are refusals with teeth: `applyRuleWrite`
 * keys off the merchant, not off the rows, so either case would otherwise let
 * a zero-effect "move" retrain or DELETE the key's rule.
 */
export function bulkRetarget(
  db: Db,
  input: BulkRetargetInput,
  options: BulkRetargetOptions = {},
): BulkRetargetResult {
  const { normalizedMerchant, fromCategoryId, categoryId, rememberMerchant } =
    input;

  return db.transaction((tx) => {
    const category = assertAssignableCategory(tx, categoryId);

    /* The SOURCE gets a name lookup and nothing else — deliberately none of
       `assertAssignableCategory`'s checks. Rows are moving OFF it, so an
       archived source is not an obstacle, it is one of the better reasons to
       be here; and a parent or a fund holding rows would be a state this
       action should help drain rather than refuse to touch. */
    const fromCategory = tx
      .select({ id: schema.categories.id, name: schema.categories.name })
      .from(schema.categories)
      .where(eq(schema.categories.id, fromCategoryId))
      .get();
    if (!fromCategory) throw new CategoryNotFoundError(fromCategoryId);
    if (fromCategoryId === categoryId) {
      throw new SameCategoryRetargetError(categoryId, category.name);
    }

    /* `isNull(transferPairId)` matches every other categorize predicate in the
       app: a paired row is owned by the transfer machinery and is not spending
       (rule 4). It is a silent FILTER here rather than the throw
       `categorizeTransaction` uses on its single target, because this path
       operates on a set — refusing the whole move over one paired row that the
       user never named would be the wrong trade. */
    const matchingRows = tx
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.normalizedMerchant, normalizedMerchant),
          eq(schema.transactions.categoryId, fromCategoryId),
          isNull(schema.transactions.transferPairId),
        ),
      )
      .all();

    if (matchingRows.length === 0) {
      throw new NoRowsToRetargetError(
        normalizedMerchant,
        fromCategoryId,
        fromCategory.name,
      );
    }

    const txnIds = matchingRows.map((r) => r.id);
    const earliestDate = matchingRows.reduce(
      (acc, r) => (r.date < acc ? r.date : acc),
      matchingRows[0].date,
    );

    /* Hoisted above the UPDATE for readability only — `excludeTxnIds` is what
       makes the verdict the same on either side of it. See the header. */
    const rule = applyRuleWrite(tx, {
      normalizedMerchant,
      categoryId,
      rememberMerchant,
      excludeTxnIds: txnIds,
      allowRuleRemoval: options.allowRuleRemoval,
    });

    tx.update(schema.transactions)
      .set({ categoryId, updatedAt: new Date() })
      .where(inArray(schema.transactions.id, txnIds))
      .run();

    const { year, month } = parseIsoMonth(earliestDate);
    // One UPDATE across both categories, not one per category — D8A is why
    // the `Many` form exists (`copyMonth.ts` calls it the same way).
    invalidateForwardRolloverMany(tx, [categoryId, fromCategoryId], year, month);

    return {
      normalizedMerchant,
      fromCategoryId,
      categoryId,
      txnIds,
      ruleTouched: rule.ruleTouched,
      priorRule: rule.priorRule,
      insertedRuleId: rule.insertedRuleId,
      earliestDate,
      updatedCount: txnIds.length,
      categoryName: category.name,
      fromCategoryName: fromCategory.name,
      ruleRefusal: rule.ruleRefusal,
    };
  });
}
