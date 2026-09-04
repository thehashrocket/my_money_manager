import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { archiveCategory, unarchiveCategory } from "./archiveCategory";
import {
  CategoryArchiveRefusedError,
  CategoryHasChildrenError,
  CategoryNotFoundError,
  UncategorizedArchiveError,
} from "@/lib/categoryErrors";

let handle: TestDbHandle;
const NOW = new Date("2026-04-15T12:00:00Z"); // "current" month is 2026-4

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let categoryCounter = 0;
function seedCategory(name: string, opts: { parentId?: number | null } = {}) {
  categoryCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-${categoryCounter}`, parentId: opts.parentId ?? null })
    .returning()
    .all();
  return cat;
}

function seedAllocation(categoryId: number, year: number, month: number, allocatedCents: number) {
  handle.db.insert(schema.budgetPeriods).values({ categoryId, year, month, allocatedCents }).run();
}

describe("archiveCategory — TC11 (F4/§7.2)", () => {
  it("refuses Uncategorized", () => {
    // Seeded by migration 0001, already present in every test DB.
    const [uncategorized] = handle.db.select().from(schema.categories).where(eq(schema.categories.name, "Uncategorized")).all();
    expect(() => archiveCategory(handle.db, uncategorized.id, NOW)).toThrow(UncategorizedArchiveError);
  });

  it("refuses a category with children", () => {
    const parent = seedCategory("Housing");
    seedCategory("Rent", { parentId: parent.id });
    expect(() => archiveCategory(handle.db, parent.id, NOW)).toThrow(CategoryHasChildrenError);
  });

  it("refuses when the CURRENT month has a non-zero allocation", () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 4, 40000);
    expect(() => archiveCategory(handle.db, cat.id, NOW)).toThrow(CategoryArchiveRefusedError);
  });

  it("refuses when a FUTURE month has a non-zero allocation", () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 7, 40000);
    expect(() => archiveCategory(handle.db, cat.id, NOW)).toThrow(CategoryArchiveRefusedError);
  });

  it("does NOT refuse when only a PAST month has a non-zero allocation", () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 3, 40000);
    const result = archiveCategory(handle.db, cat.id, NOW);
    expect(result.archivedAt).toEqual(NOW);
  });

  it("does NOT refuse a current-month allocation of exactly zero", () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 4, 0);
    const result = archiveCategory(handle.db, cat.id, NOW);
    expect(result.archivedAt).toEqual(NOW);
  });

  it("succeeds on a fully unused category and persists archived_at", () => {
    const cat = seedCategory("Groceries");
    const result = archiveCategory(handle.db, cat.id, NOW);
    expect(result.archivedAt).toEqual(NOW);

    const [row] = handle.db.select().from(schema.categories).where(eq(schema.categories.id, cat.id)).all();
    expect(row.archivedAt).toEqual(NOW);
  });

  it("is idempotent — archiving an already-archived category returns the original timestamp", () => {
    const cat = seedCategory("Groceries");
    const first = archiveCategory(handle.db, cat.id, NOW);
    const later = new Date("2026-05-01T00:00:00Z");
    const second = archiveCategory(handle.db, cat.id, later);
    expect(second.archivedAt).toEqual(first.archivedAt);
  });

  it("throws CategoryNotFoundError for an unknown id", () => {
    expect(() => archiveCategory(handle.db, 999_999, NOW)).toThrow(CategoryNotFoundError);
  });
});

describe("unarchiveCategory", () => {
  it("clears archived_at", () => {
    const cat = seedCategory("Groceries");
    archiveCategory(handle.db, cat.id, NOW);
    unarchiveCategory(handle.db, cat.id);

    // Re-archiving should succeed again (proves archived_at is really null,
    // not just that unarchiveCategory returned without throwing).
    const result = archiveCategory(handle.db, cat.id, NOW);
    expect(result.archivedAt).toEqual(NOW);
  });

  it("is a no-op on an already-active category", () => {
    const cat = seedCategory("Groceries");
    const result = unarchiveCategory(handle.db, cat.id);
    expect(result.categoryId).toBe(cat.id);
  });

  it("throws CategoryNotFoundError for an unknown id", () => {
    expect(() => unarchiveCategory(handle.db, 999_999)).toThrow(CategoryNotFoundError);
  });
});
