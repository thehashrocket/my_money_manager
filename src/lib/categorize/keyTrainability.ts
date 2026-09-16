/**
 * Can `normalized_merchant` legitimately back a global `exact` category rule?
 *
 * Both categorize paths upsert a rule from the stored key when the user ticks
 * "Remember" (`bulkCategorize`, `categorizeTransaction` → `createOrUpdateRule`).
 * Before this module they did so with no check on whether the key means
 * anything. The checkbox defaults to unchecked at both render sites, so that
 * was never silent at the moment of the click — but a rule trained on the wrong
 * kind of key is silent from then on: `buildRuleMatcher` files every future
 * matching row without asking again, and nothing surfaces it.
 *
 * Two key classes are wrong to train, and they fail for opposite reasons:
 *
 *   LOSSY          the key is not a merchant at all. The normalizer discarded
 *                  the part that identified one, so every future row lands on
 *                  the same key regardless of who was paid.
 *
 *   MULTI-CATEGORY the key IS a merchant, but this ledger files it to more
 *                  than one category. No single exact rule can be right for
 *                  all of them.
 *
 * The two halves are derived differently ON PURPOSE. Multi-category is read
 * from the data — no list to maintain, and it tracks the user's own filing as
 * it changes. Lossy cannot be read from the data (the discarded text is gone by
 * the time the key exists), so it is a curated set.
 *
 * ZERO RUNTIME IMPORTS, on purpose — same constraint as `limits.ts` and
 * `merchantLabel.ts`. `/categorize` and `/transactions` both evaluate this
 * predicate client-side so the Remember checkbox can disable itself against
 * the category currently picked, and importing anything with a module-scope
 * drizzle or zod construct here would drag it into those routes' bundles
 * (measured at +376 KB the last time this happened). The database half lives
 * in `resolveKeyTrainability.ts`. A
 * `import type` (below, for `ExistingRule`) is exempt — it is fully erased at
 * build time, the same reasoning `_submit-button.tsx`'s `satisfies keyof
 * ResolveReversalInput` already relies on elsewhere in this app.
 */
import type { ExistingRule } from "@/lib/rules";

/**
 * Keys the normalizer produces when it had nothing to work with.
 *
 * `ONLINE` and `MOBILE` come from Star One's transfer/bill-pay memo shape,
 * `Online MM/DD/YYYY HH:MM:SS [MEMO: <free text>] Ref# XXXXX`. `normalize.ts`
 * strips `EMBEDDED_TIMESTAMP`, `MEMO_TAIL` and the `Ref#` token — and the
 * `MEMO:` tail is the ONLY thing naming a counterparty, when it is present at
 * all. Measured on the live ledger 2026-09-08: across ALL rows (not just the
 * uncategorized backlog) `ONLINE` covers 39 and `MOBILE` 27, with memos
 * including "From Refinance", "Lesa's Prescription", "Taco Bell 8/1/26" and
 * "Mistaken Payment". One rule over either would file every future online
 * transfer into one envelope.
 *
 * The bar for an entry is evidence rather than suspicion, but it is not
 * "live rows" alone: `""` carries zero rows today and belongs here because it
 * is a REACHABLE normalizer output whose meaning is unambiguous — a blank Memo
 * cell normalizes to `""` (see `merchantLabel`, which exists because that case
 * is reachable), and an exact rule on `""` would claim every future memo-less
 * row. So: live rows, or a demonstrably reachable output that by construction
 * names nobody.
 *
 * Deliberately NOT here: `WITHDRAWAL-OVERDRAFT` / `DEPOSIT-OVERDRAFT`. Those
 * are accurate names for an overdraft sweep rather than lossy ones, and every
 * live row carrying them is transfer-paired, so `/categorize` never offers
 * them. Adding a key here costs the user the ability to train a rule they may
 * legitimately want.
 */
export const LOSSY_MERCHANT_KEYS: ReadonlySet<string> = new Set([
  "",
  "ONLINE",
  "MOBILE",
]);

export type TrainabilityVerdict =
  | { trainable: true }
  | {
      trainable: false;
      reason: "lossy-key" | "multi-category";
      /** One sentence, rendered to the user verbatim. */
      message: string;
    };

/** The refusing half of {@link TrainabilityVerdict}, for result payloads. */
export type TrainabilityRefusal = Extract<
  TrainabilityVerdict,
  { trainable: false }
>;

/**
 * The trainability decision, with no database in it.
 *
 * `filedCategoryIds` is what the key is filed under, and `pendingCategoryId`
 * is the category the action in flight is assigning (`null` when nothing is
 * picked yet, which is the `/categorize` first-paint state). They are SEPARATE
 * parameters rather than one pre-unioned list for two reasons:
 *
 *   1. The verdict needs the union — the moment a single exact rule stops
 *      being able to be right is the moment the user files this merchant to a
 *      second category, and that is the case that most needs the warning.
 *   2. The MESSAGE must not. Reporting the union's cardinality as history told
 *      the user something false: a key filed under one category, with a second
 *      picked, rendered as "already filed under 2 different categories" — and
 *      that sentence is their only explanation for a disabled checkbox and for
 *      a rule that just got removed. The two halves need different numbers.
 *
 * Taking the pick as `number | null` rather than a pre-widened `number[]` is
 * also what keeps `Number("")` → `0` and `Number("garbage")` → `NaN` out of the
 * set: the caller hands over what it has, and this function decides what counts
 * (see {@link isRealCategoryId}). Doing the union at the call site meant every
 * caller had to remember that, and the two callers are on opposite sides of the
 * network boundary.
 *
 * Note there is no sample-size floor. One prior filing is thin evidence, but
 * this function tests for CONTRADICTION, not confidence — one filing cannot
 * contradict anything, so it cannot be what makes a key untrainable.
 */
export function classifyKeyTrainability(
  normalizedMerchant: string,
  filedCategoryIds: readonly number[],
  pendingCategoryId: number | null,
): TrainabilityVerdict {
  if (LOSSY_MERCHANT_KEYS.has(normalizedMerchant)) {
    return {
      trainable: false,
      reason: "lossy-key",
      message:
        normalizedMerchant === ""
          ? "These rows have no merchant name, so a rule would match every future transaction with a blank memo."
          : `"${normalizedMerchant}" is the bank's channel, not a merchant — these rows have nothing else in common, so a rule would file every future one the same way.`,
    };
  }

  const filed = new Set(filedCategoryIds.filter(isRealCategoryId));
  const pending = isRealCategoryId(pendingCategoryId)
    ? pendingCategoryId
    : null;

  if (filed.size >= 2) {
    return {
      trainable: false,
      reason: "multi-category",
      message: `"${normalizedMerchant}" is already filed under ${filed.size} different categories, so no single rule can be right for all of them.`,
    };
  }

  if (filed.size === 1 && pending !== null && !filed.has(pending)) {
    return {
      trainable: false,
      reason: "multi-category",
      message: `"${normalizedMerchant}" is already filed under a different category, so filing it here as well means no single rule can be right for both.`,
    };
  }

  return { trainable: true };
}

/**
 * What ticking "Remember" would actually do, given the verdict above.
 *
 * `message` on EVERY non-`"train"` branch (PR review, type-design pass,
 * finding A): the old shape left `"none"` bare, so both render sites had to
 * keep the source `TrainabilityVerdict` alive next to this value and
 * reconstruct the same six-line ternary by hand to get a message out of
 * either branch — the exact hand-duplication class `loadExactRulesByMerchant`
 * was extracted to stop elsewhere in this same PR. Every reader now needs
 * only `RuleAction` itself.
 *
 * `reason` on `"remove-conflicting"` (same review pass, finding B) replaces
 * `existingCategoryName`, which had zero production readers — the `message`
 * already names the category. What DID need a field was which of the two
 * removal grounds fired: a lossy key removes its rule unconditionally
 * (nothing "conflicts"), while the other case is a genuine contradiction
 * between the pick and the rule's target. A shared UI label built only from
 * `kind` said "Remove conflicting rule" for the lossy case too — a false
 * claim the `message` right below it was written specifically to avoid, and
 * which `keyTrainability.test.ts`'s own coincidental-match test caught once
 * put side by side.
 */
export type RuleAction =
  | { kind: "train" }
  | {
      kind: "remove-conflicting";
      /** Which of `shouldDelete`'s two grounds fired — drives the label text. */
      reason: "lossy-key" | "contradicted";
      /** One sentence, rendered to the user verbatim — same convention as {@link TrainabilityVerdict}'s `message`. */
      message: string;
    }
  | { kind: "none"; message: string };

/**
 * Ship review (Codex adversarial + structured, cross-model, both flagged
 * this independently): `trainable === false` used to mean the checkbox is
 * simply disabled, full stop — but `applyRuleWrite` does something on a
 * refusal too, when an exact rule already exists and the pick CONTRADICTS
 * it: it deletes that rule (rule 6's "a refusal MAY also delete the exact
 * rule the key already had"). Disabling the checkbox unconditionally on
 * `!trainable` meant `rememberMerchant` could never reach the server as
 * `true` for that case either, so the ONE gesture rule 6 documents as the
 * repair path for a poisoned rule became unreachable through either
 * `/categorize` or `/transactions` — a contradicted rule just kept
 * auto-filing future imports, silently, with no way back short of hand-editing
 * the database.
 *
 * This is the exact same three-way split `applyRuleWrite`'s `shouldDelete`
 * already computes server-side (`allowRuleRemoval && existing !== undefined
 * && (reason === "lossy-key" || existing.categoryId !== categoryId)`), read
 * from the client's own already-duplicated verdict rather than a new
 * derivation — `/categorize` and `/transactions` both already pass
 * `allowRuleRemoval: true` unconditionally (`applyRuleWrite`'s own docstring:
 * "Removal is licensed only by a gesture that is a deliberate, per-merchant
 * retrain of THIS key — the Remember checkbox on `/categorize` or on a
 * `/transactions` row, where the user chose the merchant and the category"),
 * so that half of the condition is a constant here and is not
 * re-parameterized.
 *
 * `pendingCategoryId` failing {@link isRealCategoryId} — `null` (nothing
 * picked yet), `0` (the combobox's empty-selection value through `Number("")`),
 * or `NaN` (a corrupted parked pick, see the LOSSY section above) — never
 * returns `"remove-conflicting"`. There is no real pick to contradict
 * anything with in any of those cases, so offering to remove a rule would be
 * a guess, not a repair. Before this check was added here (PR review, test
 * coverage pass, finding 3), a `NaN` pending id reached the `!== pendingCategoryId`
 * comparison below, which is true for every real category id — so a
 * corrupted parked pick rendered "Remove conflicting rule" as ENABLED,
 * diverging from `classifyKeyTrainability`, which already filters
 * `pendingCategoryId` the same way for the exact same reason. (It can still
 * return `"train"` on a null/invalid pick: with nothing real to compare
 * against, `classifyKeyTrainability` reports trainable whenever the key's
 * history alone is not yet a contradiction — that branch is checked first
 * and returns before this one is reached.)
 */
export function describeRuleAction(
  normalizedMerchant: string,
  verdict: TrainabilityVerdict,
  existingRule: ExistingRule | null,
  pendingCategoryId: number | null,
): RuleAction {
  if (verdict.trainable) return { kind: "train" };
  if (existingRule === null || !isRealCategoryId(pendingCategoryId)) {
    return { kind: "none", message: verdict.message };
  }
  // A lossy key removes its rule unconditionally (rule 6: "a LOSSY refusal
  // always removes it, because a lossy key cannot back a correct rule
  // pointing anywhere at all") — that is true even in the coincidental case
  // where the existing rule already points at the category being picked, so
  // the message must not blame "this pick" for a removal the key's own
  // shape already demanded on its own.
  if (verdict.reason === "lossy-key") {
    return {
      kind: "remove-conflicting",
      reason: "lossy-key",
      message: `"${normalizedMerchant}" is too lossy a key to back any rule, so ticking Remember will remove its existing one (→ ${existingRule.categoryName}) instead of training a new one.`,
    };
  }
  if (existingRule.categoryId === pendingCategoryId) {
    return { kind: "none", message: verdict.message };
  }
  return {
    kind: "remove-conflicting",
    reason: "contradicted",
    message: `"${normalizedMerchant}" can't train a rule from this pick, but ticking Remember will still remove its existing rule (→ ${existingRule.categoryName}), which this pick contradicts.`,
  };
}

/**
 * The checkbox label for a {@link RuleAction} — the ONE spelling, shared by
 * `_merchant-row.tsx` and `_transaction-row.tsx` (PR review, type-design
 * pass, finding A/B). A label built from `kind` alone said "Remove
 * conflicting rule" for the LOSSY case too, directly contradicting the
 * `message` shown right below it (which is written specifically to avoid
 * blaming "this pick" when nothing about the pick is at fault) — `reason`
 * is what lets the label agree with its own explanation.
 *
 * Both switches are exhaustive rather than `if`/ternary chains (PR review,
 * type-design pass, finding I2) — this is the one function that has to make
 * a statement to the USER about which operation Remember is about to
 * perform, so a `RuleAction` or `reason` variant with no label decision
 * should be a build error, the same discipline `accountClass.ts`,
 * `isCreditCard.ts` and four other modules already apply to this shape.
 */
export function ruleActionLabel(action: RuleAction): string {
  switch (action.kind) {
    case "train":
    case "none":
      return "Remember";
    case "remove-conflicting":
      switch (action.reason) {
        case "lossy-key":
          return "Remove unusable rule";
        case "contradicted":
          return "Remove conflicting rule";
        default: {
          const unreachable: never = action.reason;
          return unreachable;
        }
      }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/**
 * Is this a category id at all?
 *
 * The client passes the combobox's raw string through `Number()`, where an
 * empty selection becomes `0` and a corrupted parked pick (`sessionStorage`,
 * see `_pending-pick.ts`) becomes `NaN`. Both used to read as a distinct
 * "second category" and disabled the checkbox with the multi-category
 * explanation on a merchant with one filing or none. Category ids are
 * `AUTOINCREMENT` primary keys, so positive integers is the whole test.
 */
function isRealCategoryId(id: number | null): id is number {
  return id !== null && Number.isInteger(id) && id > 0;
}
