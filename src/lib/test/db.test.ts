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
        "import_batch_categorizations",
        "import_batches",
        "subscription_dismissals",
        "transactions",
        "transfer_pair_rejections",
      ].sort(),
    );
  });

  /* Migration 0021 dropped the memoised rollover cache. Inverted rather than
     deleted: this file's job is to prove the migration chain lands on the
     schema the app expects, and "0001 added a column that 0021 removed" is a
     round trip worth pinning — a re-added column would mean a resurrected
     cache with no writer. */
  it("(0021) budget_periods has no effective_allocation_cents column", () => {
    const cols = handle.sqlite
      .prepare(`PRAGMA table_info(budget_periods)`)
      .all() as { name: string; type: string; notnull: number }[];
    expect(cols.find((c) => c.name === "effective_allocation_cents")).toBeUndefined();
    // The columns it sat between are untouched.
    expect(cols.find((c) => c.name === "allocated_cents")).toBeDefined();
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
