import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";
import { assertAssignableCategory } from "./assertAssignableCategory";

/**
 * The four checks `bulkCategorize` and `categorizeTransaction` each carried a
 * hand-maintained copy of, and `bulkRetarget` would have made three of. Each
 * caller's own suite exercises them end to end; this file exists for the two
 * properties that belong to the SHARED function rather than to any caller,
 * and which no caller's test can state:
 *
 *  - the ORDER, which the docstring calls load-bearing in exactly one place;
 *  - that it accepts a transaction handle as readily as the root `db`, since
 *    `bulkCategorize` calls it outside a transaction and the other two inside
 *    one. Nothing else in the codebase pins that both placements stay valid.
 */
let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedCategory(
  name: string,
  opts: {
    kind?: "income" | "expense" | "fund";
    archived?: boolean;
    parentId?: number;
  } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      kind: opts.kind ?? "expense",
      archivedAt: opts.archived ? new Date() : null,
      parentId: opts.parentId ?? null,
    })
    .returning()
    .all();
  return row;
}

describe("assertAssignableCategory", () => {
  it("returns the id and name of an assignable leaf", () => {
    // Not decoration: `categorizeTransaction` and `bulkRetarget` both put this
    // `name` straight into the toast the user reads.
    const cat = seedCategory("Groceries");
    expect(assertAssignableCategory(handle.db, cat.id)).toEqual({
      id: cat.id,
      name: cat.name,
    });
  });

  it.each([
    ["unknown", () => 999_999, CategoryNotFoundError],
    ["a fund", () => seedCategory("Roof", { kind: "fund" }).id, SavingsGoalCategoryError],
    ["archived", () => seedCategory("Old Gym", { archived: true }).id, CategoryArchivedError],
  ])("refuses %s", (_label, makeId, expected) => {
    expect(() => assertAssignableCategory(handle.db, makeId())).toThrow(expected);
  });

  it("refuses a parent category", () => {
    const parent = seedCategory("Food");
    seedCategory("Groceries", { parentId: parent.id });
    expect(() => assertAssignableCategory(handle.db, parent.id)).toThrow(
      ParentAllocationError,
    );
  });

  /* THE ORDERING. `kind` is tested before `archivedAt` on purpose: an archived
     fund must report as a FUND, because `CategoryArchivedError` tells the user
     to unarchive it and unarchiving would not make it assignable. Swap the two
     statements and every caller starts handing out advice that cannot work,
     with no other test in the repo noticing — the three caller suites each
     seed an archived EXPENSE and a live FUND, never the intersection. */
  it("reports an archived FUND as a fund, not as archived", () => {
    const cat = seedCategory("Retired Roof", { kind: "fund", archived: true });
    expect(() => assertAssignableCategory(handle.db, cat.id)).toThrow(
      SavingsGoalCategoryError,
    );
  });

  /* The parent check runs LAST, after the cheap single-row reads. An archived
     parent therefore reports archived — which is the better message of the
     two, since unarchiving is at least a step the user can take before
     discovering it is header-only. */
  it("reports an archived PARENT as archived, not as a parent", () => {
    const parent = seedCategory("Food", { archived: true });
    seedCategory("Groceries", { parentId: parent.id });
    expect(() => assertAssignableCategory(handle.db, parent.id)).toThrow(
      CategoryArchivedError,
    );
  });

  /* `bulkCategorize` runs these on `db` before opening a transaction; the
     other two run them on `tx` inside one. The docstring says both placements
     stay valid because the checks are reads — this is that claim, asserted. */
  it("works identically on a transaction handle", () => {
    const cat = seedCategory("Groceries");
    const fund = seedCategory("Roof", { kind: "fund" });

    handle.db.transaction((tx) => {
      expect(assertAssignableCategory(tx, cat.id)).toEqual({
        id: cat.id,
        name: cat.name,
      });
      expect(() => assertAssignableCategory(tx, fund.id)).toThrow(
        SavingsGoalCategoryError,
      );
    });
  });
});
