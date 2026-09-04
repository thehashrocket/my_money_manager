import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  createCategory,
  createCategoryGroup,
  moveCategory,
  renameCategory,
  setCarryoverPolicy,
} from "./manageCategories";
import { CategoryNameTakenError, CategoryNotFoundError } from "@/lib/categoryErrors";
import { primeCache as primeCacheOnDb } from "@/lib/test/primeCache";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let categoryCounter = 0;
function seedCategory(
  name: string,
  opts: { parentId?: number | null; sortOrder?: number; carryoverPolicy?: "none" | "rollover" | "reset" } = {},
) {
  categoryCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${categoryCounter}`,
      parentId: opts.parentId ?? null,
      sortOrder: opts.sortOrder ?? 0,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
    })
    .returning()
    .all();
  return cat;
}

function readCategory(id: number) {
  return handle.db.select().from(schema.categories).where(eq(schema.categories.id, id)).get()!;
}

// `createTestDb` applies the real migration 0017 seed (46 categories:
// Housing, Food, Rent, Groceries, Health, Giving, Charity, Gifts,
// Utilities... — the actual production taxonomy). Names passed directly to
// `createCategory`/`createCategoryGroup`/`renameCategory` below use a "Zz "
// prefix specifically so they can never collide with a real seeded name;
// `seedCategory`'s counter suffix already protects ITS OWN fixtures, but
// these calls exercise the collision-DETECTION logic itself and need
// deliberately unambiguous names to do that correctly.

describe("createCategoryGroup (T25/DS20)", () => {
  it("creates an unparented category", () => {
    const group = createCategoryGroup(handle.db, "Zz Health");
    expect(readCategory(group.id).parentId).toBeNull();
  });

  it("(DS12) assigns sort_order = max(sort_order) + 1 among top-level siblings, not the column default of 0", () => {
    // The real migration 0017 seed already has 10 top-level groups with
    // explicit sort_order (1-10) — assert relative to whatever that current
    // max is, rather than assuming an empty table.
    const before = handle.db.select().from(schema.categories).where(isNull(schema.categories.parentId)).all();
    const currentMax = Math.max(0, ...before.map((c) => c.sortOrder));

    const group = createCategoryGroup(handle.db, "Zz Health");
    expect(readCategory(group.id).sortOrder).toBe(currentMax + 1);
  });

  it("throws CategoryNameTakenError on a name collision", () => {
    createCategoryGroup(handle.db, "Zz Health");
    expect(() => createCategoryGroup(handle.db, "Zz Health")).toThrow(CategoryNameTakenError);
  });
});

describe("createCategory (T25/DS20)", () => {
  it("creates a leaf under a parent with the given kind and carryover policy", () => {
    const parent = seedCategory("Housing");
    const leaf = createCategory(handle.db, {
      name: "Zz Rent",
      kind: "expense",
      parentId: parent.id,
      carryoverPolicy: "rollover",
    });
    const row = readCategory(leaf.id);
    expect(row.parentId).toBe(parent.id);
    expect(row.kind).toBe("expense");
    expect(row.carryoverPolicy).toBe("rollover");
  });

  it("(DS12) assigns sort_order among siblings sharing the same parent, independent of other groups", () => {
    const housing = seedCategory("Housing");
    const giving = seedCategory("Giving");
    seedCategory("Rent", { parentId: housing.id, sortOrder: 3 });
    seedCategory("Charity", { parentId: giving.id, sortOrder: 99 });

    const leaf = createCategory(handle.db, { name: "Zz Utilities", kind: "expense", parentId: housing.id });
    expect(readCategory(leaf.id).sortOrder).toBe(4); // next after Housing's sibling, unaffected by Giving's 99
  });

  it("creates an unparented leaf (income/fund style)", () => {
    const leaf = createCategory(handle.db, { name: "Zz Side gig", kind: "income", parentId: null });
    expect(readCategory(leaf.id).parentId).toBeNull();
  });

  it("throws CategoryNotFoundError when parentId doesn't exist", () => {
    expect(() => createCategory(handle.db, { name: "Zz Rent", kind: "expense", parentId: 999_999 })).toThrow(
      CategoryNotFoundError,
    );
  });

  it("throws CategoryNameTakenError on a name collision", () => {
    createCategory(handle.db, { name: "Zz Rent", kind: "expense", parentId: null });
    expect(() => createCategory(handle.db, { name: "Zz Rent", kind: "expense", parentId: null })).toThrow(
      CategoryNameTakenError,
    );
  });
});

describe("renameCategory (T25)", () => {
  it("renames a category", () => {
    const cat = seedCategory("Groceries");
    const result = renameCategory(handle.db, cat.id, "Zz Food");
    expect(result.name).toBe("Zz Food");
    expect(readCategory(cat.id).name).toBe("Zz Food");
  });

  it("throws CategoryNameTakenError when the new name collides with a DIFFERENT category", () => {
    createCategory(handle.db, { name: "Zz Food", kind: "expense", parentId: null });
    const cat = seedCategory("Groceries");
    expect(() => renameCategory(handle.db, cat.id, "Zz Food")).toThrow(CategoryNameTakenError);
  });

  it("allows renaming a category to its OWN current name (no-op collision)", () => {
    const cat = seedCategory("Groceries");
    const currentName = readCategory(cat.id).name;
    expect(() => renameCategory(handle.db, cat.id, currentName)).not.toThrow();
  });

  it("throws CategoryNotFoundError for an unknown id", () => {
    expect(() => renameCategory(handle.db, 999_999, "Zz Food")).toThrow(CategoryNotFoundError);
  });
});

describe("setCarryoverPolicy", () => {
  it("updates the policy and invalidates forward rollover from the earliest budget_periods row", () => {
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    handle.db.insert(schema.budgetPeriods).values({ categoryId: cat.id, year: 2026, month: 3, allocatedCents: 5000 }).run();
    handle.db.insert(schema.budgetPeriods).values({ categoryId: cat.id, year: 2026, month: 4, allocatedCents: 1000 }).run();
    primeCacheOnDb(handle.db, cat.id, 2026, 4);

    setCarryoverPolicy(handle.db, cat.id, "none");

    expect(readCategory(cat.id).carryoverPolicy).toBe("none");
    const period = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .all()
      .find((p) => p.month === 4)!;
    expect(period.effectiveAllocationCents).toBeNull();
  });

  it("throws CategoryNotFoundError for an unknown id", () => {
    expect(() => setCarryoverPolicy(handle.db, 999_999, "rollover")).toThrow(CategoryNotFoundError);
  });
});

describe("moveCategory (T29/§6.4)", () => {
  // Nested under a fresh parent in every case: `createTestDb` applies the
  // real migration 0017 seed (46 categories, several already top-level with
  // their own `sort_order`), so testing at the top level directly risks a
  // tie against real seed rows. A freshly created parent's children are an
  // isolated sibling set no seed row can share.
  it("swaps sort_order with the previous sibling on 'up'", () => {
    const group = seedCategory("Group");
    const a = seedCategory("A", { parentId: group.id, sortOrder: 1 });
    const b = seedCategory("B", { parentId: group.id, sortOrder: 2 });

    const result = moveCategory(handle.db, b.id, "up");
    expect(result.swappedWithId).toBe(a.id);
    expect(readCategory(b.id).sortOrder).toBe(1);
    expect(readCategory(a.id).sortOrder).toBe(2);
  });

  it("swaps sort_order with the next sibling on 'down'", () => {
    const group = seedCategory("Group");
    const a = seedCategory("A", { parentId: group.id, sortOrder: 1 });
    const b = seedCategory("B", { parentId: group.id, sortOrder: 2 });

    const result = moveCategory(handle.db, a.id, "down");
    expect(result.swappedWithId).toBe(b.id);
    expect(readCategory(a.id).sortOrder).toBe(2);
    expect(readCategory(b.id).sortOrder).toBe(1);
  });

  it("is a no-op at the start of the list ('up' on the first item)", () => {
    const group = seedCategory("Group");
    const a = seedCategory("A", { parentId: group.id, sortOrder: 1 });
    seedCategory("B", { parentId: group.id, sortOrder: 2 });

    const result = moveCategory(handle.db, a.id, "up");
    expect(result.swappedWithId).toBeNull();
    expect(readCategory(a.id).sortOrder).toBe(1);
  });

  it("is a no-op at the end of the list ('down' on the last item)", () => {
    const group = seedCategory("Group");
    seedCategory("A", { parentId: group.id, sortOrder: 1 });
    const b = seedCategory("B", { parentId: group.id, sortOrder: 2 });

    const result = moveCategory(handle.db, b.id, "down");
    expect(result.swappedWithId).toBeNull();
    expect(readCategory(b.id).sortOrder).toBe(2);
  });

  it("only compares siblings sharing the same parent_id — a different group is unaffected", () => {
    const housing = seedCategory("Housing");
    const giving = seedCategory("Giving");
    const rent = seedCategory("Rent", { parentId: housing.id, sortOrder: 1 });
    const charity = seedCategory("Charity", { parentId: giving.id, sortOrder: 1 });

    const result = moveCategory(handle.db, rent.id, "down");
    expect(result.swappedWithId).toBeNull(); // only sibling in its own group
    expect(readCategory(charity.id).sortOrder).toBe(1); // untouched
  });

  it("throws CategoryNotFoundError for an unknown id", () => {
    expect(() => moveCategory(handle.db, 999_999, "up")).toThrow(CategoryNotFoundError);
  });
});
