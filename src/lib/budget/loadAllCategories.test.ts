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
});
