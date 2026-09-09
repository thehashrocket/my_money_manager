/**
 * Errors specific to the bulk-retarget path. Both are reachable from ordinary
 * use rather than only from a crafted post, which is why each carries the
 * facts a person needs instead of a generic failure.
 */

/**
 * The retarget's source and destination are the same category.
 *
 * The form disables Submit for this, so reaching it means a stale tab or a
 * second window — but it must be refused rather than run, because a "move"
 * that changes nothing would still hand `applyRuleWrite` a rememberMerchant
 * tick and could delete the key's rule for a no-op.
 */
export class SameCategoryRetargetError extends Error {
  constructor(
    readonly categoryId: number,
    readonly categoryName: string,
  ) {
    super(
      `Those rows are already filed as "${categoryName}". Pick a different category to move them to.`,
    );
    this.name = "SameCategoryRetargetError";
  }
}

/**
 * No rows are filed under the source category for this merchant any more.
 *
 * The commonest way to see this is the honest one: a second tab (or the Undo
 * on an earlier move) already emptied that category, and this page's counts
 * are a beat stale. Refusing is not politeness — `applyRuleWrite` runs on the
 * key, not on the rows, so proceeding would let a zero-row "move" retrain or
 * DELETE the merchant's rule with nothing to show for it.
 */
export class NoRowsToRetargetError extends Error {
  constructor(
    readonly normalizedMerchant: string,
    readonly fromCategoryId: number,
    readonly fromCategoryName: string,
  ) {
    super(
      `No rows are filed as "${fromCategoryName}" for this merchant any more — nothing to move. Reload to see the current counts.`,
    );
    this.name = "NoRowsToRetargetError";
  }
}
