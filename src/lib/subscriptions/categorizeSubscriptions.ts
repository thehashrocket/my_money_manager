import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { bulkCategorize } from "@/lib/categorize/bulkCategorize";
import { describeRuleRefusal } from "@/lib/categorize/refusalNotice";
import { loadSubscriptions } from "./loadSubscriptions";

type Db = typeof defaultDb;

/** One merchant's outcome, for the toast on the control that asked for it. */
export type SubscriptionCategorizeOutcome = {
  normalizedMerchant: string;
  /** Rows flipped from uncategorized onto the Subscriptions category. */
  filedCount: number;
  /**
   * Why no rule was trained for this merchant, or `null` when one was.
   *
   * `/subscriptions` used to discard `bulkCategorize`'s whole return value, so a
   * refusal here was invisible — and "Categorize all" could produce one per
   * merchant in a single click with no feedback of any kind.
   */
  refusal: string | null;
  /**
   * Why an EXISTING rule for this merchant now points somewhere else, or `null`
   * when nothing was overwritten.
   *
   * "This page cannot remove a rule" is true and was not enough: on a trainable
   * verdict `applyRuleWrite` still reaches `createOrUpdateRule`, whose upsert
   * retargets an existing exact rule's category, priority and source. That is
   * reachable without any crafted input — undo a batch's import-time
   * categorization (which by design resets rows to NULL and leaves the rule
   * standing, rule 6) and the key reads as UNFILED, so the verdict is trainable
   * and one click repoints a hand-trained rule. There is no undo on this page, so
   * saying so is the whole mitigation.
   */
  retargetedRule: string | null;
};

export type CategorizeAllSubscriptionsOutcome = {
  /** Merchants that filed at least one row. */
  merchantsFiled: number;
  /** Total rows flipped across every merchant. */
  filedCount: number;
  /** Merchants whose rule was withheld, in list order. */
  refusals: SubscriptionCategorizeOutcome[];
  /** Merchants whose existing rule this sweep repointed, in list order. */
  retargets: SubscriptionCategorizeOutcome[];
  /**
   * Merchants whose own `bulkCategorize` threw.
   *
   * The sweep keeps going rather than propagating. Each merchant commits in its
   * own transaction, so a throw at iteration K used to abandon every merchant
   * after it AND leave no record of how far it got. Wrapping the whole sweep in
   * one transaction is the other option and is worse: one unfilable merchant
   * would discard every good filing with it.
   */
  failures: { normalizedMerchant: string; message: string }[];
};

/**
 * File one detected subscription, training its rule where that is legitimate.
 *
 * Note the absence of `allowRuleRemoval`. This is a one-click sweep of a
 * merchant the PAGE suggested, not a deliberate retrain of a key the user chose,
 * so a refusal withholds the rule and leaves any existing one exactly as it was.
 * `applyRuleWrite` carries the reasoning; the short version is that
 * `loadSubscriptions` does not filter on `category_id`, so a merchant already
 * filed under a correct rule is still on this list, and removal here would have
 * deleted that rule with no undo surface anywhere on the page.
 */
export function fileSubscription(
  db: Db,
  normalizedMerchant: string,
  categoryId: number,
): SubscriptionCategorizeOutcome {
  const result = bulkCategorize(db, {
    normalizedMerchant,
    categoryId,
    rememberMerchant: true,
  });
  return {
    normalizedMerchant,
    filedCount: result.updatedCount,
    refusal:
      result.ruleRefusal === null
        ? null
        : describeRuleRefusal(db, result.ruleRefusal).message,
    retargetedRule:
      result.priorRule === null
        ? null
        : `The existing rule for "${normalizedMerchant}" now files it under ${categoryName(db, categoryId)} instead of ${categoryName(db, result.priorRule.categoryId)}.`,
  };
}

function categoryName(db: Db, categoryId: number): string {
  const row = db
    .select({ name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  return row?.name ?? `category ${categoryId}`;
}

/** {@link fileSubscription} over every active detection, reporting each outcome. */
export function fileAllSubscriptions(
  db: Db,
  categoryId: number,
): CategorizeAllSubscriptionsOutcome {
  const { active } = loadSubscriptions(db);
  const outcome: CategorizeAllSubscriptionsOutcome = {
    merchantsFiled: 0,
    filedCount: 0,
    refusals: [],
    retargets: [],
    failures: [],
  };
  for (const sub of active) {
    try {
      const one = fileSubscription(db, sub.normalizedMerchant, categoryId);
      outcome.filedCount += one.filedCount;
      if (one.filedCount > 0) outcome.merchantsFiled += 1;
      if (one.refusal !== null) outcome.refusals.push(one);
      if (one.retargetedRule !== null) outcome.retargets.push(one);
    } catch (err) {
      outcome.failures.push({
        normalizedMerchant: sub.normalizedMerchant,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcome;
}
