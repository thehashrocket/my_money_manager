import type { AnyDb } from "@/db";
import { createOrUpdateRule, deleteExactRule, readExactRule } from "@/lib/rules";
import type { TrainabilityRefusal } from "./keyTrainability";
import {
  toPriorRuleSnapshot,
  type PriorRuleSnapshot,
} from "./priorRuleSnapshot";
import { resolveKeyTrainability } from "./resolveKeyTrainability";

/**
 * A refusal, plus what it did to the rule that was already there.
 *
 * ONE nullable field rather than a `ruleRefusal` / `refusalDeletedRule` pair:
 * those two were correlated by prose only, so `{refusal: null, deleted: true}`
 * was representable and meaningless, and both toast sites read the boolean
 * exclusively inside the null check anyway. Carrying the removed ROW rather
 * than a flag is also what lets the surfaces name the category it pointed at,
 * which is the one fact a user needs to decide whether to restore it.
 */
export type RuleRefusalReport = TrainabilityRefusal & {
  removedRule: PriorRuleSnapshot | null;
};

/** Everything a categorize call did to `category_rules`, and why. */
export type RuleWriteOutcome = {
  /**
   * True when this call changed the rules table — the rule was upserted, or a
   * refusal removed the one already there. Both give the undo something to
   * reverse, which is the only thing this flag is read for.
   */
  ruleTouched: boolean;
  /**
   * The rule row as it stood before this call: `null` when no exact rule
   * existed, otherwise the row that was overwritten (upsert) or removed
   * (refusal). The undo restores this row either way and cannot tell the two
   * apart, because `restorePriorRule` reads the DB's current state rather than
   * trusting a recorded intent.
   */
  priorRule: PriorRuleSnapshot | null;
  /**
   * ID of the newly inserted rule row when `priorRule = null`. The undo
   * deletes by primary key rather than by (match_type, match_value,
   * category_id), which is unsafe once a second writer can retarget the same
   * row mid-window — and `/subscriptions` is such a writer.
   */
  insertedRuleId: number | null;
  /** Set when Remember was ticked and the key cannot back a rule. */
  ruleRefusal: RuleRefusalReport | null;
};

const NO_RULE_WRITE: RuleWriteOutcome = {
  ruleTouched: false,
  priorRule: null,
  insertedRuleId: null,
  ruleRefusal: null,
};

/**
 * The whole "what happens to this key's exact rule" decision, in one place.
 *
 * Both write paths ran a hand-maintained copy of this block with a four-field
 * return assembled by hand, and the two copies had already drifted:
 * `categorizeTransaction` never captured `insertedRuleId`, so its undo deleted
 * by a triple the sibling's own doc comment called unsafe. Extracting it is
 * also what makes the deletion rule below exist once rather than twice.
 *
 * Call it INSIDE the caller's write transaction, and pass the ids of any
 * already-filed rows the caller is about to retarget as `excludeTxnIds` — see
 * `resolveKeyTrainability`, which is what makes the verdict independent of
 * whether this runs before or after the caller's own UPDATE.
 *
 * ## Who may remove a rule at all
 *
 * `allowRuleRemoval` defaults to FALSE, and that default is the point. Removal
 * is licensed only by a gesture that is a deliberate, per-merchant retrain of
 * THIS key — the Remember checkbox on `/categorize` or on a `/transactions`
 * row, where the user chose the merchant and the category. It is an argument
 * rather than anything reachable from a form, the same way rule 4 keeps
 * `allowSameAccountReversal` out of the request body.
 *
 * `/subscriptions` is why. "Categorize all" loops every active subscription
 * with `rememberMerchant: true` and no per-merchant intent at all, so with
 * removal on it could delete a working rule per merchant in one click — and
 * `loadSubscriptions` does not filter on `category_id`, so a merchant that is
 * already filed with a correct rule is still on that list. A safe default means
 * a future caller has to ask for the destructive half explicitly.
 *
 * ## When a refusal deletes the existing rule, and when it must not
 *
 * Refusing the upsert alone was not enough: a rule pointing a key somewhere the
 * user has contradicted keeps auto-filing every future import (rule 6), and the
 * guard itself closes the repair path — `/categorize` never lists the merchant,
 * because the rule leaves no NULL-category rows to group, and `/transactions`
 * refuses the retrain, because the rows that same rule filed are what push the
 * key over two categories. There is no rules-management surface, so the rule
 * would have been permanent. That is why a refusal removes it.
 *
 * But "remove it" is not right for every refusal. Deleting unconditionally
 * destroyed a rule in the case where the user is CONFIRMING it: key filed to A
 * and B from earlier hand work, rule `K → A`, user picks A and ticks Remember.
 * The refusal is correct (the key really does span two categories), but the
 * rule pointed exactly where the user had just pointed, and deleting it left
 * every future K row uncategorized — strictly worse than the rule, and nothing
 * about the gesture asked for it. So:
 *
 *   - a MULTI-CATEGORY refusal removes the rule only when the user has
 *     CONTRADICTED its target (`existing.categoryId !== categoryId`);
 *   - a LOSSY refusal always removes it, because a lossy key cannot back a
 *     correct rule pointing anywhere at all.
 *
 * Where the removal is skipped the refusal still stands and is still reported —
 * the rows file, the rule is left exactly as the user found it.
 *
 * What this deliberately does NOT do is spare a rule that a lot of history
 * agrees with. Retarget one of 50 rows filed to Shopping by rule `K → Shopping`
 * and the rule goes. That looks harsh, and it is the same shape as the case the
 * deletion exists for — the difference is the user's intent, which is not in the
 * data, so no predicate can separate them. Removing it is the better of the two
 * available wrongs: afterwards every new K row lands uncategorized and shows up
 * on `/categorize`, where the user decides. Keeping it means every new K row is
 * silently filed to a category the user has just told us is not the only answer.
 * Rule 6's whole thesis is that a silent wrong rule is the worst outcome
 * available, and visible backlog is the honest failure. The costs of getting
 * this wrong are handled where they belong instead: the surfaces name the
 * removed rule's category, and its Undo is on the front toast (see
 * `refusalNotice` and the toast comments in `_merchant-row` /
 * `_transaction-row`).
 */
export function applyRuleWrite(
  tx: AnyDb,
  params: {
    normalizedMerchant: string;
    categoryId: number;
    rememberMerchant: boolean;
    excludeTxnIds?: readonly number[];
    /** See "Who may remove a rule at all" above. Defaults to `false`. */
    allowRuleRemoval?: boolean;
  },
): RuleWriteOutcome {
  const { normalizedMerchant, categoryId, rememberMerchant } = params;
  if (!rememberMerchant) return NO_RULE_WRITE;

  const verdict = resolveKeyTrainability(
    tx,
    normalizedMerchant,
    categoryId,
    params.excludeTxnIds,
  );
  const existing = readExactRule(tx, normalizedMerchant);

  if (verdict.trainable) {
    const priorRule = existing ? toPriorRuleSnapshot(existing) : null;
    const upserted = createOrUpdateRule(tx, {
      normalizedMerchant,
      categoryId,
      source: "manual",
    });
    return {
      ruleTouched: true,
      priorRule,
      insertedRuleId: priorRule === null ? upserted.id : null,
      ruleRefusal: null,
    };
  }

  const shouldDelete =
    params.allowRuleRemoval === true &&
    existing !== undefined &&
    (verdict.reason === "lossy-key" || existing.categoryId !== categoryId);
  if (!shouldDelete) {
    return { ...NO_RULE_WRITE, ruleRefusal: { ...verdict, removedRule: null } };
  }

  const removed = deleteExactRule(tx, normalizedMerchant);
  /* `removed` is non-null here — `readExactRule` just found it inside this same
     transaction — but the delete is what decides, so the outcome is built from
     its return rather than from the read. */
  const removedRule = removed ? toPriorRuleSnapshot(removed) : null;
  return {
    ruleTouched: removedRule !== null,
    priorRule: removedRule,
    insertedRuleId: null,
    ruleRefusal: { ...verdict, removedRule },
  };
}
