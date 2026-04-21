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
