/**
 * Shared category-related error types.
 *
 * Extracted from `src/lib/budget/upsertAllocation.ts` so the categorize code
 * path can throw the same named errors when a bulk target category is missing
 * or structurally invalid (parent/savings-goal). Keeping error identity in one
 * place means a future `/rules` page or re-categorize path can catch the same
 * sentinels without cross-importing across feature folders.
 */

export class CategoryNotFoundError extends Error {
  constructor(readonly categoryId: number) {
    super(`Category ${categoryId} not found`);
    this.name = "CategoryNotFoundError";
  }
}

export class ParentAllocationError extends Error {
  constructor(readonly categoryId: number, readonly categoryName: string) {
    super(
      `"${categoryName}" is a parent category and cannot hold an allocation. Allocate to one of its children instead.`,
    );
    this.name = "ParentAllocationError";
  }
}

export class SavingsGoalCategoryError extends Error {
  constructor(readonly categoryId: number, readonly categoryName: string) {
    super(
      `"${categoryName}" is a savings goal and cannot receive bulk categorization. Pick a leaf spending category instead.`,
    );
    this.name = "SavingsGoalCategoryError";
  }
}

export class NotASavingsGoalError extends Error {
  constructor(readonly categoryId: number) {
    super(`Category ${categoryId} is not a savings goal`);
    this.name = "NotASavingsGoalError";
  }
}

/** T27/§7.2: a parent category is header-only — archiving it would hide its
 * children's group heading while leaving the children themselves active and
 * still budgetable, an inconsistent half-archived group. Archive the
 * children first, or don't group under this parent at all. */
export class CategoryHasChildrenError extends Error {
  constructor(readonly categoryId: number, readonly categoryName: string) {
    super(`"${categoryName}" has categories grouped under it and cannot be archived. Archive those first.`);
    this.name = "CategoryHasChildrenError";
  }
}

/** T27/§7.2: the `categories_uncategorized_no_delete` trigger (`drizzle/0001`)
 * already refuses to DELETE this row; archive must refuse it for the same
 * reason — it is the landing zone every dedup/import/categorize path assumes
 * always exists and is always visible. */
export class UncategorizedArchiveError extends Error {
  constructor(readonly categoryId: number) {
    super(`"Uncategorized" cannot be archived — it is the landing zone for every unmatched transaction.`);
    this.name = "UncategorizedArchiveError";
  }
}

/** T25/§7.1: `categories_name_unique` enforces this at the DB layer already;
 * checking it first turns a raw SQLite constraint violation into a message
 * naming the actual collision, for create and rename alike. */
export class CategoryNameTakenError extends Error {
  constructor(readonly name: string) {
    super(`A category named "${name}" already exists.`);
    this.name = "CategoryNameTakenError";
  }
}

/** F4/TC11: archiving a category with a non-zero allocation in the current
 * or a future month would hide that money from Left to Budget's equation
 * without ever spending or un-planning it. Past months are exempt — history
 * doesn't need protecting from an archive the way an open plan does. */
export class CategoryArchiveRefusedError extends Error {
  constructor(
    readonly categoryId: number,
    readonly categoryName: string,
    readonly year: number,
    readonly month: number,
  ) {
    super(
      `"${categoryName}" has a budget planned for ${year}-${String(month).padStart(2, "0")} and cannot be archived. Zero out that allocation first.`,
    );
    this.name = "CategoryArchiveRefusedError";
  }
}
