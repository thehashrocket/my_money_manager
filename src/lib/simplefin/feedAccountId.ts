/**
 * A SimpleFIN ACCOUNT id — "which feed produced this row".
 *
 * Branded because rule 3 makes this a different fact from "which local account
 * holds the row", and the codebase has already paid for conflating them:
 * migration `0020` exists because the dedup index was keyed on `account_id` as
 * a proxy for the feed, which is wrong the moment a link moves, and the fix
 * that preceded it cleared `external_id` on relink and caused the very
 * cross-account double-count it was meant to prevent.
 *
 * Concretely, without the brand these all typecheck against a `feedId: string`
 * parameter and none of them is a feed account id:
 *
 *   row.externalId          the TRANSACTION id — unique only WITHIN a feed
 *   account.name            a string that happens to be nearby
 *   ""                      compares unequal to every real link, so a guard
 *                           taking it drops every account with a plausible
 *                           "was re-linked" warning and reports a clean sync
 *
 * Zero runtime imports, same constraint as `limits.ts` — nothing here should
 * pull the DB into a bundle that only needs the type.
 */
declare const feedAccountIdBrand: unique symbol;

export type FeedAccountId = string & { readonly [feedAccountIdBrand]: "simplefin-account-id" };

/**
 * The ONE mint. Rejects `""`, which is never a link and is the value that
 * makes an unbranded parameter silently catastrophic rather than merely wrong.
 */
export function asFeedAccountId(value: string): FeedAccountId {
  if (value === "") throw new Error("empty SimpleFIN account id");
  return value as FeedAccountId;
}
