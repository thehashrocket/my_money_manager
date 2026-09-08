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
 * ZERO IMPORTS, on purpose — same constraint as `limits.ts` and
 * `merchantLabel.ts`. `/categorize` evaluates this predicate client-side so the
 * Remember checkbox can disable itself against the category currently picked,
 * and importing anything with a module-scope drizzle or zod construct here
 * would drag it into that route's bundle (measured at +376 KB the last time
 * this happened). The database half lives in `resolveKeyTrainability.ts`.
 */

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
