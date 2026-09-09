import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getEffectiveAllocation } from "@/lib/budget";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  createCategory,
  createCategoryGroup,
  moveCategory,
  renameCategory,
  setCarryoverPolicy,
} from "./manageCategories";
import { CategoryNameTakenError, CategoryNotFoundError } from "@/lib/categoryErrors";

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

  /* An ARCHIVED category still holds its name in the unique index, and is
     invisible on every surface that could explain the collision — out of every
     picker (rule 8), out of `loadGoals` as of v0.24.0, and out of a month's
     `/budget` rows unless it has activity there. So the message has to name
     the archive and point at the one page that can unarchive it; "already
     exists" alone sends the user looking for something they cannot find. */
  it("says the colliding category is archived, and where to unarchive it", () => {
    const group = createCategoryGroup(handle.db, "Zz Sabbatical");
    handle.db
      .update(schema.categories)
      .set({ archivedAt: new Date() })
      .where(eq(schema.categories.id, group.id))
      .run();

    expect(() => createCategoryGroup(handle.db, "Zz Sabbatical")).toThrow(
      /archived.*Budget → Categories/,
    );
  });

  it("does not mention archiving when the collision is with a live category", () => {
    createCategoryGroup(handle.db, "Zz Live");
    expect(() => createCategoryGroup(handle.db, "Zz Live")).toThrow(
      /^A category named "Zz Live" already exists\.$/,
    );
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

  it("(T5/D1B/A2) dual-writes is_savings_goal to true when creating a fund-kind category", () => {
    const leaf = createCategory(handle.db, { name: "Zz New Fund", kind: "fund", parentId: null });
    expect(readCategory(leaf.id).isSavingsGoal).toBe(true);
  });

  it("(T5/D1B/A2) leaves is_savings_goal false for a non-fund category", () => {
    const leaf = createCategory(handle.db, { name: "Zz Utilities Bill", kind: "expense", parentId: null });
    expect(readCategory(leaf.id).isSavingsGoal).toBe(false);
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
  it("updates the policy, and April stops carrying March's unspent balance", () => {
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    handle.db.insert(schema.budgetPeriods).values({ categoryId: cat.id, year: 2026, month: 3, allocatedCents: 5000 }).run();
    handle.db.insert(schema.budgetPeriods).values({ categoryId: cat.id, year: 2026, month: 4, allocatedCents: 1000 }).run();

    // While rolling over, April opens at its own $10 plus March's unspent $50.
    expect(getEffectiveAllocation(handle.db, cat.id, 2026, 4)?.effectiveCents).toBe(6000);

    setCarryoverPolicy(handle.db, cat.id, "none");

    expect(readCategory(cat.id).carryoverPolicy).toBe("none");
    // This used to assert a cleared cache column. The cache is gone, so it
    // asserts the consequence the clearing existed to produce.
    expect(getEffectiveAllocation(handle.db, cat.id, 2026, 4)).toEqual({
      allocatedCents: 1000,
      rolloverCents: 0,
      effectiveCents: 1000,
    });
  });

  it("throws CategoryNotFoundError for an unknown id", () => {
    expect(() => setCarryoverPolicy(handle.db, 999_999, "rollover")).toThrow(CategoryNotFoundError);
  });

  it("updates the policy without error when the category has no budget_periods row yet", () => {
    // A category with no budget_periods row at all: the policy write must
    // stand on its own. (This existed because the removed invalidation had to
    // skip a nonexistent starting month rather than throw.)
    const cat = seedCategory("Gifts");
    const result = setCarryoverPolicy(handle.db, cat.id, "rollover");
    expect(result).toEqual({ categoryId: cat.id, carryoverPolicy: "rollover" });
    expect(readCategory(cat.id).carryoverPolicy).toBe("rollover");
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

  it("breaks a sort_order tie by name (the documented secondary sort key)", () => {
    const group = seedCategory("Group");
    // Same sort_order on purpose — the tie-break must fall back to name ASC,
    // matching the order `loadMonthView` itself renders in.
    const alpha = seedCategory("Alpha", { parentId: group.id, sortOrder: 5 });
    const bravo = seedCategory("Bravo", { parentId: group.id, sortOrder: 5 });

    // With the tie broken by name, Alpha is first and Bravo is second —
    // moving Alpha "down" should swap it with Bravo.
    const result = moveCategory(handle.db, alpha.id, "down");
    expect(result.swappedWithId).toBe(bravo.id);
  });
});
