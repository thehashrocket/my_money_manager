import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  CategoryNotFoundError,
  ParentAllocationError,
  upsertAllocation,
} from "@/lib/budget/upsertAllocation";
import {
  getEffectiveAllocation,
  invalidateForwardRollover,
} from "@/lib/budget";
import { validateAllocateInput } from "@/lib/budget/validateAllocateInput";

/**
 * Integration tests for the `upsertBudgetAllocationAction` wrapper.
 *
 * The action itself calls Next.js-only helpers (`revalidatePath`,
 * `redirect`) and closes over the singleton DB. These tests exercise the
 * exact mutation pipeline the action runs (`upsertAllocation(db, input)`)
 * against a `:memory:` DB, plus the full chain
 * `validateAllocateInput → upsertAllocation` to mirror what the action
 * does end-to-end minus the Next.js shell.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let catCounter = 0;
function seedCategory(
  name: string,
  opts: {
    parentId?: number | null;
    carryoverPolicy?: "none" | "rollover" | "reset";
    isSavingsGoal?: boolean;
  } = {},
) {
  catCounter += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${catCounter}`,
      parentId: opts.parentId ?? null,
      carryoverPolicy: opts.carryoverPolicy ?? "none",
      isSavingsGoal: opts.isSavingsGoal ?? false,
    })
    .returning()
    .all();
  return cat;
}

function seedAllocation(
  categoryId: number,
  year: number,
  month: number,
  allocatedCents: number,
) {
  handle.db
    .insert(schema.budgetPeriods)
    .values({ categoryId, year, month, allocatedCents })
    .run();
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

describe("upsertAllocation — create", () => {
  it("inserts a new budget_periods row when none exists", () => {
    const cat = seedCategory("Groceries");

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 40000,
    });

    const row = readAllocation(cat.id, 2026, 4);
    expect(row?.allocatedCents).toBe(40000);
    expect(row?.effectiveAllocationCents).toBeNull();
  });

  it("preserves existing rows for other (category, year, month) tuples", () => {
    const a = seedCategory("A");
    const b = seedCategory("B");
    seedAllocation(b.id, 2026, 4, 9999);

    upsertAllocation(handle.db, {
      categoryId: a.id,
      year: 2026,
      month: 4,
      allocatedCents: 1000,
    });

    expect(readAllocation(a.id, 2026, 4)?.allocatedCents).toBe(1000);
    expect(readAllocation(b.id, 2026, 4)?.allocatedCents).toBe(9999);
  });
});

describe("upsertAllocation — update", () => {
  it("overwrites allocated_cents when a row already exists", () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 4, 10000);

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 25000,
    });

    expect(readAllocation(cat.id, 2026, 4)?.allocatedCents).toBe(25000);
  });

  it("clears effective_allocation_cents on the edited row", () => {
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 3, 5000);
    seedAllocation(cat.id, 2026, 4, 1000);
    // Prime the April cache.
    getEffectiveAllocation(handle.db, cat.id, 2026, 4, { persist: true });
    expect(readAllocation(cat.id, 2026, 4)?.effectiveAllocationCents).toBe(6000);

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 2000,
    });

    expect(readAllocation(cat.id, 2026, 4)?.effectiveAllocationCents).toBeNull();
  });

  it("bumps updated_at on UPDATE", async () => {
    const cat = seedCategory("Groceries");
    seedAllocation(cat.id, 2026, 4, 1000);
    const before = readAllocation(cat.id, 2026, 4)!.updatedAt;

    // `updated_at` is stored in whole seconds (integer timestamp mode).
    // Wait just past a second boundary so a later write is observably newer.
    await new Promise((r) => setTimeout(r, 1100));

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 2000,
    });

    const after = readAllocation(cat.id, 2026, 4)!.updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

describe("upsertAllocation — forward invalidation", () => {
  it("clears downstream cached effective_allocation_cents for the same category", () => {
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 4, 1000);
    seedAllocation(cat.id, 2026, 5, 1000);
    seedAllocation(cat.id, 2026, 6, 1000);
    getEffectiveAllocation(handle.db, cat.id, 2026, 6, { persist: true });

    expect(readAllocation(cat.id, 2026, 5)?.effectiveAllocationCents).not.toBeNull();
    expect(readAllocation(cat.id, 2026, 6)?.effectiveAllocationCents).not.toBeNull();

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 9999,
    });

    expect(readAllocation(cat.id, 2026, 4)?.effectiveAllocationCents).toBeNull();
    expect(readAllocation(cat.id, 2026, 5)?.effectiveAllocationCents).toBeNull();
    expect(readAllocation(cat.id, 2026, 6)?.effectiveAllocationCents).toBeNull();
  });

  it("does not clear prior months' cached values", () => {
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 2, 2000);
    seedAllocation(cat.id, 2026, 3, 2000);
    seedAllocation(cat.id, 2026, 4, 1000);
    getEffectiveAllocation(handle.db, cat.id, 2026, 4, { persist: true });

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 5000,
    });

    // Feb and March caches from the persist above survive.
    expect(readAllocation(cat.id, 2026, 2)?.effectiveAllocationCents).toBe(2000);
    expect(readAllocation(cat.id, 2026, 3)?.effectiveAllocationCents).toBe(4000);
    // April was edited → its cache is cleared.
    expect(readAllocation(cat.id, 2026, 4)?.effectiveAllocationCents).toBeNull();
  });

  it("only touches the target category", () => {
    const a = seedCategory("A", { carryoverPolicy: "rollover" });
    const b = seedCategory("B", { carryoverPolicy: "rollover" });
    seedAllocation(a.id, 2026, 4, 1000);
    seedAllocation(a.id, 2026, 5, 1000);
    seedAllocation(b.id, 2026, 4, 2000);
    seedAllocation(b.id, 2026, 5, 2000);
    getEffectiveAllocation(handle.db, a.id, 2026, 5, { persist: true });
    getEffectiveAllocation(handle.db, b.id, 2026, 5, { persist: true });

    upsertAllocation(handle.db, {
      categoryId: a.id,
      year: 2026,
      month: 4,
      allocatedCents: 5000,
    });

    expect(readAllocation(a.id, 2026, 5)?.effectiveAllocationCents).toBeNull();
    // b is rollover; April had $20 allocated, 0 spent → $20 rolls into May.
    // May effective = 20 + 20 = 40 (persist cached this before the upsert).
    expect(readAllocation(b.id, 2026, 5)?.effectiveAllocationCents).toBe(4000);
  });

  it("crosses the year boundary when invalidating forward", () => {
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 12, 3000);
    seedAllocation(cat.id, 2027, 1, 1000);
    getEffectiveAllocation(handle.db, cat.id, 2027, 1, { persist: true });

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 12,
      allocatedCents: 5000,
    });

    expect(readAllocation(cat.id, 2026, 12)?.effectiveAllocationCents).toBeNull();
    expect(readAllocation(cat.id, 2027, 1)?.effectiveAllocationCents).toBeNull();
  });
});

describe("upsertAllocation — rejections", () => {
  it("throws CategoryNotFoundError for an unknown category", () => {
    expect(() =>
      upsertAllocation(handle.db, {
        categoryId: 999_999,
        year: 2026,
        month: 4,
        allocatedCents: 100,
      }),
    ).toThrow(CategoryNotFoundError);
  });

  it("throws ParentAllocationError when the category has any child", () => {
    const parent = seedCategory("Housing");
    seedCategory("Rent", { parentId: parent.id });

    expect(() =>
      upsertAllocation(handle.db, {
        categoryId: parent.id,
        year: 2026,
        month: 4,
        allocatedCents: 100,
      }),
    ).toThrow(ParentAllocationError);
  });

  it("does not insert a row when the call rejects (parent category)", () => {
    const parent = seedCategory("Housing");
    seedCategory("Rent", { parentId: parent.id });

    try {
      upsertAllocation(handle.db, {
        categoryId: parent.id,
        year: 2026,
        month: 4,
        allocatedCents: 100,
      });
    } catch {
      // expected
    }

    expect(readAllocation(parent.id, 2026, 4)).toBeUndefined();
  });
});

describe("upsertAllocation — end-to-end chain (mirrors the Server Action)", () => {
  it("validate → upsert recomputes downstream effective allocation on next read", () => {
    const cat = seedCategory("Gifts", { carryoverPolicy: "rollover" });
    seedAllocation(cat.id, 2026, 4, 0);

    // Simulate the Server Action body minus Next.js shell.
    const parsed = validateAllocateInput({
      categoryId: String(cat.id),
      year: "2026",
      month: "4",
      allocatedCents: "5000",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    upsertAllocation(handle.db, parsed.data);

    // April effective = 50 + 0 rollover = 50.
    const april = getEffectiveAllocation(handle.db, cat.id, 2026, 4);
    expect(april?.effectiveCents).toBe(5000);
  });

  it("second upsert on the same (cat, year, month) overwrites — idempotent by key", () => {
    const cat = seedCategory("Groceries");

    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 10000,
    });
    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 20000,
    });

    const rows = handle.db
      .select()
      .from(schema.budgetPeriods)
      .where(eq(schema.budgetPeriods.categoryId, cat.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].allocatedCents).toBe(20000);
  });
});

describe("upsertAllocation — interaction with prior external invalidation", () => {
  it("leaves the row's newly-written allocated_cents intact if invalidate runs separately", () => {
    // Sanity check: invalidateForwardRollover nulls effective_allocation_cents
    // only; it does not touch allocated_cents. The upsert's own allocated_cents
    // write is what survives.
    const cat = seedCategory("Groceries");
    upsertAllocation(handle.db, {
      categoryId: cat.id,
      year: 2026,
      month: 4,
      allocatedCents: 12345,
    });
    invalidateForwardRollover(handle.db, cat.id, 2026, 4);
    expect(readAllocation(cat.id, 2026, 4)?.allocatedCents).toBe(12345);
  });
});
