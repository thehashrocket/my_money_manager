/**
 * Can `normalized_merchant` legitimately back a global `exact` category rule?
 *
 * Both categorize paths upsert a rule from the stored key whenever the user
 * ticks "Remember" (`bulkCategorize`, `categorizeTransaction` → `createOrUpdateRule`),
 * with no check on whether the key means anything. The checkbox defaults to
 * unchecked at both render sites, so this was never silent — but a rule trained
 * on the wrong kind of key is silent from then on: `buildRuleMatcher` files
 * every future matching row without asking again, and nothing surfaces it.
 *
 * Two key classes are wrong to train, and they fail for opposite reasons:
 *
 *   LOSSY          the key is not a merchant at all. The normalizer discarded
 *                  the part that identified one, so every future row lands on
 *                  the same key regardless of who was paid.
 *
 *   MULTI-CATEGORY the key IS a merchant, but this ledger has already filed it
 *                  to more than one category. No single exact rule can be right
 *                  for all of them.
 *
 * The two halves are derived differently ON PURPOSE. Multi-category is read
 * from the data — no list to maintain, and it tracks the user's own filing as
 * it changes. Lossy cannot be read from the data (the discarded text is gone by
 * the time the key exists), so it is a curated set, held to the same
 * evidence-only discipline `KNOWN_CITIES` and `STATE_CODES` are held to in
 * `normalize.ts`: an entry needs live rows behind it.
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
 * all. Measured on the live ledger 2026-09-08: `ONLINE` covers 39 rows whose
 * memos include "From Refinance", "Lesa's Prescription", "Taco Bell 8/1/26" and
 * "Mistaken Payment"; `MOBILE` covers 27 more of the same shape. One rule over
 * either would file every future online transfer into one envelope.
 *
 * The empty key is here for the same reason and carries zero rows today: a
 * blank Memo cell normalizes to `""` (see `merchantLabel`, which exists because
 * that case is reachable), and an exact rule on `""` would claim every future
 * memo-less row.
 *
 * Deliberately NOT here: `WITHDRAWAL-OVERDRAFT` / `DEPOSIT-OVERDRAFT`. Those
 * are accurate names for an overdraft sweep rather than lossy ones, and every
 * live row carrying them is transfer-paired, so `/categorize` never offers
 * them. Adding a key here costs the user the ability to train a rule they may
 * legitimately want, so the bar is live evidence, not suspicion.
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
 * `categoryIds` is every category this key would be filed to once the action in
 * flight commits — existing filings UNION the category being assigned now. It
 * is a union rather than "what is already filed" so the verdict does not depend
 * on whether the caller checks before or after its own UPDATE, and so the most
 * important case is caught: the user is filing this merchant to a second
 * category right now, which is the moment a single exact rule stops being able
 * to be right.
 *
 * Note there is no sample-size floor. One prior filing is thin evidence, but
 * this function tests for CONTRADICTION, not confidence — one filing cannot
 * contradict anything, so it cannot be what makes a key untrainable.
 */
export function classifyKeyTrainability(
  normalizedMerchant: string,
  categoryIds: readonly number[],
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

  const distinct = new Set(categoryIds);
  if (distinct.size >= 2) {
    return {
      trainable: false,
      reason: "multi-category",
      message: `"${normalizedMerchant}" is already filed under ${distinct.size} different categories, so no single rule can be right for all of them.`,
    };
  }

  return { trainable: true };
}
