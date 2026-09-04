import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadAllCategories } from "./loadAllCategories";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
  handle.db.delete(schema.categories).where(ne(schema.categories.name, "Uncategorized")).run();
});

afterEach(() => {
  handle.close();
});

let seq = 0;
function seedCategory(
  name: string,
  opts: { parentId?: number | null; kind?: "income" | "expense" | "fund"; archivedAt?: Date | null } = {},
) {
  seq += 1;
  const [cat] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: opts.parentId ?? null,
      kind: opts.kind ?? "expense",
      archivedAt: opts.archivedAt ?? null,
    })
    .returning()
    .all();
  return cat;
}

describe("loadAllCategories (DS20/§7.2)", () => {
  it("includes archived categories, unlike listLeafCategories' default", () => {
    const archived = seedCategory("Old Gym", { archivedAt: new Date() });
    const rows = loadAllCategories(handle.db);
    expect(rows.some((r) => r.id === archived.id)).toBe(true);
  });

  it("resolves parentName for a child, null for a top-level row", () => {
    const parent = seedCategory("Housing");
    const child = seedCategory("Rent", { parentId: parent.id });
    const rows = loadAllCategories(handle.db);
    expect(rows.find((r) => r.id === child.id)?.parentName).toBe(parent.name);
    expect(rows.find((r) => r.id === parent.id)?.parentName).toBeNull();
  });

  it("flags a category referenced as someone else's parent as isGroup", () => {
    const parent = seedCategory("Housing");
    seedCategory("Rent", { parentId: parent.id });
    const rows = loadAllCategories(handle.db);
    expect(rows.find((r) => r.id === parent.id)?.isGroup).toBe(true);
  });

  it("does not flag an ordinary leaf as isGroup", () => {
    const leaf = seedCategory("Groceries");
    const rows = loadAllCategories(handle.db);
    expect(rows.find((r) => r.id === leaf.id)?.isGroup).toBe(false);
  });

  it("sorts by kind, then parentName, then name — the documented three-level order", () => {
    // Deliberately seeded out of order so a passing test can't be an
    // accident of insertion order.
    seedCategory("Zz Zebra Leaf", { kind: "income" });
    const zHousing = seedCategory("Zz Housing", { kind: "expense" });
    const aHousing = seedCategory("Aa Housing", { kind: "expense" });
    const underZebra = seedCategory("Zz Under Zebra", { parentId: zHousing.id, kind: "expense" });
    const underAlpha = seedCategory("Zz Under Alpha", { parentId: aHousing.id, kind: "expense" });
    const unparentedExpense = seedCategory("Aa Unparented", { kind: "expense" });

    const rows = loadAllCategories(handle.db);
    const names = rows.map((r) => r.name);

    // Level 1 — kind: "expense" (all seeded above) sorts before "income".
    const lastExpenseIdx = Math.max(...rows.map((r, i) => (r.kind === "expense" ? i : -1)));
    const firstIncomeIdx = rows.findIndex((r) => r.kind === "income");
    expect(lastExpenseIdx).toBeLessThan(firstIncomeIdx);

    // Level 2 — parentName: within "expense", a row with no parent
    // ("Aa Unparented", parentName null -> "") sorts before any row whose
    // parentName is a real string ("Aa Housing", "Zz Housing").
    expect(names.indexOf(unparentedExpense.name)).toBeLessThan(names.indexOf(underAlpha.name));
    expect(names.indexOf(unparentedExpense.name)).toBeLessThan(names.indexOf(underZebra.name));

    // Level 2 continued — "Aa Housing" sorts before "Zz Housing" as a
    // parentName, so children under Aa Housing precede children under Zz Housing.
    expect(names.indexOf(underAlpha.name)).toBeLessThan(names.indexOf(underZebra.name));
  });
});
