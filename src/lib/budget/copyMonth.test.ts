import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { copyPreviousMonth, hasAnyAllocations } from "./copyMonth";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let categoryCounter = 0;
function seedCategory(name: string, archivedAt: Date | null = null) {
  categoryCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-${categoryCounter}`, archivedAt })
    .returning()
    .all();
  return cat;
}

function seedAllocation(categoryId: number, year: number, month: number, allocatedCents: number) {
  handle.db.insert(schema.budgetPeriods).values({ categoryId, year, month, allocatedCents }).run();
}

function readAllocation(categoryId: number, year: number, month: number) {
  return handle.db
    .select()
    .from(schema.budgetPeriods)
    .where(
      and(
        eq(schema.budgetPeriods.categoryId, categoryId),
        eq(schema.budgetPeriods.year, year),
        eq(schema.budgetPeriods.month, month),
      ),
    )
    .get();
}

describe("copyPreviousMonth — TC8", () => {
  it("copies missing rows and skips existing ones", () => {
    const groceries = seedCategory("Groceries");
    const rent = seedCategory("Rent");
    seedAllocation(groceries.id, 2026, 8, 40000);
    seedAllocation(rent.id, 2026, 8, 180000);
    // Rent already has a September row the user set by hand — must not be
    // overwritten (there is no undo for this).
    seedAllocation(rent.id, 2026, 9, 999900);

    const result = copyPreviousMonth(handle.db, 2026, 9);

    expect(result).toEqual({ copied: 1, skipped: 1, skippedArchived: 0 });
    expect(readAllocation(groceries.id, 2026, 9)?.allocatedCents).toBe(40000);
    expect(readAllocation(rent.id, 2026, 9)?.allocatedCents).toBe(999900); // untouched
  });

  it("returns {copied: 0, skipped: 0} when the prior month is empty", () => {
    const result = copyPreviousMonth(handle.db, 2026, 9);
    expect(result).toEqual({ copied: 0, skipped: 0, skippedArchived: 0 });
  });
});

describe("copyPreviousMonth — TC24 (DS12)", () => {
  it("excludes an archived category's prior-month allocation and counts it separately", () => {
    const active = seedCategory("Groceries");
    const archived = seedCategory("Old Streaming Service", new Date("2026-08-15"));
    seedAllocation(active.id, 2026, 8, 40000);
    seedAllocation(archived.id, 2026, 8, 1500);

    const result = copyPreviousMonth(handle.db, 2026, 9);

    expect(result).toEqual({ copied: 1, skipped: 0, skippedArchived: 1 });
    expect(readAllocation(active.id, 2026, 9)?.allocatedCents).toBe(40000);
    expect(readAllocation(archived.id, 2026, 9)).toBeUndefined();
  });
});

describe("hasAnyAllocations (DS7)", () => {
  it("returns false when the month has no budget_periods rows", () => {
    expect(hasAnyAllocations(handle.db, 2026, 9)).toBe(false);
  });

  it("returns true when the month has at least one budget_periods row", () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 9, 40000);
    expect(hasAnyAllocations(handle.db, 2026, 9)).toBe(true);
  });

  it("is scoped to the exact year/month — a row in an adjacent month doesn't count", () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 8, 40000);
    expect(hasAnyAllocations(handle.db, 2026, 9)).toBe(false);
  });
});

describe("copyPreviousMonth — invalidation and transaction safety", () => {
  it("invalidates forward rollover for every copied category starting at the target month", () => {
    const cat = seedCategory("Gifts");
    seedAllocation(cat.id, 2026, 8, 5000);
    seedAllocation(cat.id, 2026, 10, 5000);
    handle.db
      .update(schema.budgetPeriods)
      .set({ effectiveAllocationCents: 12345 })
      .where(and(eq(schema.budgetPeriods.categoryId, cat.id), eq(schema.budgetPeriods.month, 10)))
      .run();

    copyPreviousMonth(handle.db, 2026, 9);

    expect(readAllocation(cat.id, 2026, 10)?.effectiveAllocationCents).toBeNull();
  });

  it("does not invalidate a category that was skipped (already set this month)", () => {
    const cat = seedCategory("Rent");
    seedAllocation(cat.id, 2026, 8, 180000);
    seedAllocation(cat.id, 2026, 9, 180000);
    seedAllocation(cat.id, 2026, 10, 5000);
    handle.db
      .update(schema.budgetPeriods)
      .set({ effectiveAllocationCents: 999 })
      .where(and(eq(schema.budgetPeriods.categoryId, cat.id), eq(schema.budgetPeriods.month, 10)))
      .run();

    copyPreviousMonth(handle.db, 2026, 9);

    expect(readAllocation(cat.id, 2026, 10)?.effectiveAllocationCents).toBe(999);
  });

  it("crosses a year boundary correctly (December's prior month is November, not January)", () => {
    const cat = seedCategory("Gifts");
    seedAllocation(cat.id, 2026, 11, 7500);

    const result = copyPreviousMonth(handle.db, 2026, 12);

    expect(result.copied).toBe(1);
    expect(readAllocation(cat.id, 2026, 12)?.allocatedCents).toBe(7500);
  });

  it("crosses a January boundary (prior month is December of the prior year)", () => {
    const cat = seedCategory("Gifts");
    seedAllocation(cat.id, 2026, 12, 8000);

    const result = copyPreviousMonth(handle.db, 2027, 1);

    expect(result.copied).toBe(1);
    expect(readAllocation(cat.id, 2027, 1)?.allocatedCents).toBe(8000);
  });
});
