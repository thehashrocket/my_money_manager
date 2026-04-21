import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDbHandle } from "./db";
import * as schema from "@/db/schema";

describe("migration parse (integration)", () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = createTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("applies all migrations cleanly against :memory:", () => {
    const tables = handle.sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%'`,
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "accounts",
        "budget_periods",
        "categories",
        "category_rules",
        "import_batches",
        "transactions",
      ].sort(),
    );
  });

  it("adds budget_periods.effective_allocation_cents (nullable integer)", () => {
    const cols = handle.sqlite
      .prepare(`PRAGMA table_info(budget_periods)`)
      .all() as { name: string; type: string; notnull: number }[];
    const col = cols.find((c) => c.name === "effective_allocation_cents");
    expect(col).toBeDefined();
    expect(col!.type.toLowerCase()).toBe("integer");
    expect(col!.notnull).toBe(0);
  });

  it("seeds Uncategorized + 5 default leaf categories + 43 expanded categories", () => {
    const rows = handle.db.select().from(schema.categories).all();
    const names = rows.map((r) => r.name);
    // Original 6
    expect(names).toContain("Uncategorized");
    expect(names).toContain("Groceries");
    expect(names).toContain("Gas");
    expect(names).toContain("Dining");
    expect(names).toContain("Utilities");
    expect(names).toContain("Misc");
    // Sample of expanded categories
    expect(names).toContain("Rent");
    expect(names).toContain("Streaming");
    expect(names).toContain("Pharmacy");
    expect(names).toContain("Flights");
    expect(rows.length).toBeGreaterThanOrEqual(49);
  });

  it("creates the BEFORE DELETE trigger on Uncategorized", () => {
    const trigger = handle.sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name='categories_uncategorized_no_delete'`,
      )
      .get();
    expect(trigger).toBeDefined();
  });

  it("refuses to delete the Uncategorized category", () => {
    const row = handle.sqlite
      .prepare(`SELECT id FROM categories WHERE name = 'Uncategorized'`)
      .get() as { id: number } | undefined;
    expect(row).toBeDefined();
    expect(() =>
      handle.sqlite
        .prepare(`DELETE FROM categories WHERE id = ?`)
        .run(row!.id),
    ).toThrowError(/Cannot delete the Uncategorized category/);
  });

  it("permits deleting other seed categories (trigger only guards Uncategorized)", () => {
    const result = handle.sqlite
      .prepare(`DELETE FROM categories WHERE name = 'Misc'`)
      .run();
    expect(result.changes).toBe(1);
  });

  it("is isolated: each createTestDb gets a fresh seed (no leakage between tests)", () => {
    handle.db
      .insert(schema.categories)
      .values({ name: "ScratchOnly" })
      .run();
    handle.close();

    const fresh = createTestDb();
    try {
      const hit = fresh.db
        .select()
        .from(schema.categories)
        .where(sql`${schema.categories.name} = 'ScratchOnly'`)
        .all();
      expect(hit).toHaveLength(0);
    } finally {
      fresh.close();
    }
  });
});
