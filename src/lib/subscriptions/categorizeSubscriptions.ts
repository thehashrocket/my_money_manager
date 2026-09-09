import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { bulkCategorize } from "@/lib/categorize/bulkCategorize";
import { describeRuleRefusalPostCommit } from "@/lib/categorize/refusalNotice";
import { guardPostCommitRead } from "@/lib/categorize/postCommitRead";
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
  // EVERY READ BELOW FOLLOWS A COMMITTED WRITE, and this surface is the one
  // where a throw costs most. `fileAllSubscriptions` catches a per-merchant
  // throw into `failures`, so an unguarded read here reported the merchant as a
  // FAILURE after `bulkCategorize` had already filed its rows and possibly
  // repointed a hand-trained rule — and `/subscriptions` has no undo anywhere
  // (rule 6), so `refusal`/`retargetedRule` are the only record that either
  // thing happened. The fourth, fifth and sixth instances of the class
  // `guardPostCommitRead` was written for; the first three were in the two
  // categorize actions and `runBulkRetarget`.
  const notice = describeRuleRefusalPostCommit(db, "/subscriptions", result.ruleRefusal);
  return {
    normalizedMerchant,
    filedCount: result.updatedCount,
    refusal: notice === null ? null : notice.message,
    retargetedRule:
      result.priorRule === null
        ? null
        : `The existing rule for "${normalizedMerchant}" now files it under ${categoryName(db, categoryId)} instead of ${categoryName(db, result.priorRule.categoryId)}.`,
  };
}

/**
 * Guarded, because both of its callers run AFTER the write has committed.
 *
 * The `?? \`category N\`` fallback covered a MISSING ROW; it never covered a
 * THROWING read, which is the case `SQLITE_BUSY` produces (WAL mode,
 * `VACUUM INTO` snapshots, `db:export` all hold readers). Degrading to the same
 * id-shaped string is the right answer for both — the sentence is still true,
 * just less specific — but only one of them used to reach it.
 */
function categoryName(db: Db, categoryId: number): string {
  return guardPostCommitRead(
    "/subscriptions",
    () => {
      const row = db
        .select({ name: schema.categories.name })
        .from(schema.categories)
        .where(eq(schema.categories.id, categoryId))
        .get();
      return row?.name ?? `category ${categoryId}`;
    },
    `category ${categoryId}`,
  );
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
