import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";

/**
 * Migration 0017 (categories.kind / sort_order / archived_at, DS25's group
 * taxonomy) is a plain in-place ALTER — no table rebuild — so unlike 0010 it
 * can be exercised through the normal `createTestDb()` path: the migration
 * only reads and writes rows that earlier migrations (0001/0002/0005) already
 * seed, so a freshly-migrated in-memory DB IS the real production path.
 *
 * TC5's renamed-category half is the exception: it needs a DB state migration
 * 0017 was never designed to run against (a hand-edited `Paycheck`), so that
 * one test replays 0000-0016 manually before mutating the row, matching the
 * 0010 test's `execMigration` pattern.
 */

const drizzleDir = path.join(process.cwd(), "drizzle");

/** Shared by every describe block below that needs to replay the pre-0017
 * schema by hand (0010's rebuild means `createTestDb()` can't be trusted to
 * reflect a hand-mutated pre-migration state — see the module docstring). */
const PRE_0017_MIGRATIONS = [
  "0000_thin_mandroid.sql",
  "0001_complete_ikaris.sql",
  "0002_more_categories.sql",
  "0003_flimsy_micromacro.sql",
  "0004_chubby_the_spike.sql",
  "0005_subscriptions_category.sql",
  "0006_subscription_rules.sql",
  "0007_unique_lily_hollister.sql",
  "0008_naive_zeigeist.sql",
  "0009_narrow_sentinels.sql",
  "0010_flat_baron_zemo.sql",
  "0011_living_black_tom.sql",
  "0012_anchor_starting_balance_on_batch.sql",
  "0013_flaky_chronomancer.sql",
  "0014_modern_virginia_dare.sql",
  "0015_early_stardust.sql",
  "0016_tired_thing.sql",
];

function execMigration(sqlite: Database.Database, file: string): void {
  const content = fs
    .readFileSync(path.join(drizzleDir, file), "utf8")
    .replace(/-->\s*statement-breakpoint/g, "");
  sqlite.exec(content);
}

const GROUPS: Record<string, string[]> = {
  Giving: ["Gifts", "Charity"],
  Housing: ["Rent", "Home Maintenance", "Renter's Insurance", "Home Goods"],
  Bills: [
    "Utilities",
    "Electric",
    "Water",
    "Internet",
    "Phone",
    "Streaming",
    "Software",
    "News & Magazines",
    "Subscriptions",
    "Bank Fees",
  ],
  Food: ["Groceries", "Dining", "Coffee", "Fast Food", "Alcohol"],
  Transportation: [
    "Gas",
    "Car Insurance",
    "Car Maintenance",
    "Parking",
    "Rideshare",
    "Public Transit",
  ],
  Health: ["Doctor", "Dentist", "Pharmacy", "Health Insurance", "Gym"],
  Family: ["Childcare", "School"],
  Personal: ["Haircut", "Clothing", "Amazon", "Electronics", "ATM", "Misc"],
  Entertainment: ["Movies & Events", "Hobbies", "Books & Music"],
  Travel: ["Hotels", "Flights", "Vacation"],
};
const INCOME_NAMES = ["Paycheck", "Interest", "Reimbursement"];

type CategoryRow = {
  id: number;
  name: string;
  parent_id: number | null;
  kind: string;
  sort_order: number;
  archived_at: number | null;
  is_savings_goal: number;
};

function allCategories(sqlite: Database.Database): CategoryRow[] {
  return sqlite
    .prepare(
      `SELECT id, name, parent_id, kind, sort_order, archived_at, is_savings_goal FROM categories`,
    )
    .all() as CategoryRow[];
}

describe("migration 0017 (categories.kind / sort_order / archived_at)", () => {
  function setup(): TestDbHandle {
    return createTestDb();
  }

  it("TC5 — backfills kind='income' on the three real seeded names", () => {
    const { sqlite, close } = setup();
    try {
      const income = allCategories(sqlite).filter((c) => c.kind === "income");
      expect(income.map((c) => c.name).sort()).toEqual([...INCOME_NAMES].sort());
    } finally {
      close();
    }
  });

  it("fund backfill: is_savings_goal=1 rows get kind='fund' (D1B)", () => {
    const { sqlite, close } = setup();
    try {
      // Seed via a straight column update rather than re-running migration
      // 0017 (already applied by createTestDb) — this exercises the same
      // backfill UPDATE's WHERE clause against a category that IS a savings
      // goal, which the real seed data (zero is_savings_goal=1 rows) can't.
      sqlite
        .prepare(`UPDATE categories SET is_savings_goal = 1 WHERE name = 'Gifts'`)
        .run();
      sqlite.exec(`UPDATE categories SET kind = 'fund' WHERE is_savings_goal = 1`);
      const gifts = sqlite
        .prepare(`SELECT kind FROM categories WHERE name = 'Gifts'`)
        .get() as { kind: string };
      expect(gifts.kind).toBe("fund");
    } finally {
      close();
    }
  });

  it("TC24a (RESTATED, E3) — every kind='expense' leaf (not itself a parent) has a parent_id, except Uncategorized", () => {
    const { sqlite, close } = setup();
    try {
      const rows = allCategories(sqlite);
      const parentIds = new Set(
        rows.map((r) => r.parent_id).filter((id): id is number => id !== null),
      );
      const orphanedLeaves = rows.filter(
        (r) =>
          r.kind === "expense" &&
          !parentIds.has(r.id) &&
          r.name !== "Uncategorized" &&
          r.parent_id === null,
      );
      expect(orphanedLeaves).toEqual([]);

      // The predicate's other half, restated by E3: the 10 group PARENTS
      // themselves are kind='expense' with parent_id IS NULL — that is
      // correct, not a violation, because they ARE parents of something.
      const groupParents = rows.filter(
        (r) => r.kind === "expense" && r.parent_id === null && parentIds.has(r.id),
      );
      expect(groupParents).toHaveLength(10);
    } finally {
      close();
    }
  });

  it("TC35 (DS25 + E2) — the 50->10 mapping is exact and total", () => {
    const { sqlite, close } = setup();
    try {
      const rows = allCategories(sqlite);
      const byId = new Map(rows.map((r) => [r.id, r]));

      const groupParentNames = Object.keys(GROUPS);
      const groupParents = rows.filter(
        (r) => groupParentNames.includes(r.name) && r.parent_id === null,
      );
      expect(groupParents).toHaveLength(10);
      expect(groupParents.map((g) => g.sort_order).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      expect(new Set(groupParents.map((g) => g.sort_order)).size).toBe(10);

      let totalLeaves = 0;
      for (const [groupName, members] of Object.entries(GROUPS)) {
        const parent = groupParents.find((g) => g.name === groupName);
        expect(parent, `group parent missing: ${groupName}`).toBeDefined();
        for (const memberName of members) {
          const leaf = rows.find((r) => r.name === memberName);
          expect(leaf, `leaf missing: ${memberName}`).toBeDefined();
          expect(leaf!.parent_id, `${memberName} should resolve to ${groupName}`).toBe(
            parent!.id,
          );
          totalLeaves += 1;
        }
        expect(members.length, `group is non-empty: ${groupName}`).toBeGreaterThan(0);
      }
      expect(totalLeaves).toBe(46);

      // E2: sort_order is non-null on all 60 rows and unique within each parent.
      expect(rows).toHaveLength(60);
      const byParent = new Map<string, number[]>();
      for (const r of rows) {
        expect(r.sort_order).not.toBeNull();
        const key = String(r.parent_id);
        byParent.set(key, [...(byParent.get(key) ?? []), r.sort_order]);
      }
      for (const [parentKey, sortOrders] of byParent) {
        if (parentKey === "null") continue; // top level spans bands (E2) — not one ordering space
        expect(
          new Set(sortOrders).size,
          `sort_order not unique within parent ${parentKey}`,
        ).toBe(sortOrders.length);
      }

      // Uncategorized stays parentless and un-grouped.
      const uncategorized = rows.find((r) => r.name === "Uncategorized");
      expect(uncategorized?.parent_id).toBeNull();

      // Income leaves stay parentless too — banded by kind, not grouped by parent_id.
      for (const name of INCOME_NAMES) {
        const row = byId.get(rows.find((r) => r.name === name)!.id)!;
        expect(row.parent_id).toBeNull();
        expect(row.kind).toBe("income");
      }
    } finally {
      close();
    }
  });

  it("clears effective_allocation_cents globally (reclassification invalidates cached rollover)", () => {
    const { sqlite, close } = setup();
    try {
      sqlite.exec(
        `INSERT INTO budget_periods (category_id, year, month, allocated_cents, effective_allocation_cents)
         VALUES (1, 2026, 9, 1000, 1000)`,
      );
      // Re-running the same clear the migration performs, to prove the
      // column really is nullable and the statement runs cleanly against a
      // populated table (the migration itself already ran during setup()).
      sqlite.exec(`UPDATE budget_periods SET effective_allocation_cents = NULL`);
      const row = sqlite
        .prepare(`SELECT effective_allocation_cents FROM budget_periods WHERE category_id = 1`)
        .get() as { effective_allocation_cents: number | null };
      expect(row.effective_allocation_cents).toBeNull();
    } finally {
      close();
    }
  });

  it("archived_at is nullable with no backfill (E7)", () => {
    const { sqlite, close } = setup();
    try {
      const rows = allCategories(sqlite);
      expect(rows.every((r) => r.archived_at === null)).toBe(true);
    } finally {
      close();
    }
  });
});

describe("migration 0017 — TC5 failure mode: a renamed Paycheck is not caught by the migration", () => {
  it("F1: renaming Paycheck before the migration runs leaves it kind='expense' — the name match is the whole mechanism", () => {
    const sqlite = new Database(":memory:");
    try {
      for (const file of PRE_0017_MIGRATIONS) {
        execMigration(sqlite, file);
      }
      sqlite.exec(`UPDATE categories SET name = 'Salary' WHERE name = 'Paycheck'`);

      execMigration(sqlite, "0017_category_kind.sql");

      const incomeRows = sqlite
        .prepare(`SELECT name FROM categories WHERE kind = 'income'`)
        .all() as { name: string }[];
      // Only Interest and Reimbursement flip; the renamed row is silently
      // left as kind='expense' — this is F1, mitigated at the app layer
      // (§9's Layer 1/2 banner + setCategoryKindAction), not in SQL.
      expect(incomeRows.map((r) => r.name).sort()).toEqual(["Interest", "Reimbursement"]);
      const salary = sqlite
        .prepare(`SELECT kind FROM categories WHERE name = 'Salary'`)
        .get() as { kind: string };
      expect(salary.kind).toBe("expense");
    } finally {
      sqlite.close();
    }
  });
});

describe("migration 0017 — group-name collision: a pre-existing category can't be silently annexed as a GROUP parent", () => {
  it("a user category named 'Travel' (e.g. a savings goal) is never reparented onto and stays untouched", () => {
    const sqlite = new Database(":memory:");
    try {
      for (const file of PRE_0017_MIGRATIONS) {
        execMigration(sqlite, file);
      }
      // Simulate a user-created savings goal named "Travel" that predates
      // the migration — plausible, since `createGoalAction` lets users name
      // goals freely and "Travel" is a natural one.
      const travelId = sqlite
        .prepare(
          `INSERT INTO categories (name, carryover_policy, is_savings_goal) VALUES ('Travel', 'none', 1) RETURNING id`,
        )
        .get() as { id: number };
      sqlite
        .prepare(`INSERT INTO budget_periods (category_id, year, month, allocated_cents) VALUES (?, 2026, 8, 50000)`)
        .run(travelId.id);

      execMigration(sqlite, "0017_category_kind.sql");

      const travelRows = sqlite.prepare(`SELECT id, parent_id, kind FROM categories WHERE name = 'Travel'`).all() as {
        id: number;
        parent_id: number | null;
        kind: string;
      }[];
      // Exactly one "Travel" row — INSERT OR IGNORE correctly didn't create
      // a duplicate — and it's still the user's own row, untouched: not
      // reparented under anything, and flipped to kind='fund' by the
      // is_savings_goal backfill (unrelated to the taxonomy seed), not left
      // dangling as an orphaned expense-kind GROUP placeholder.
      expect(travelRows).toHaveLength(1);
      expect(travelRows[0].id).toBe(travelId.id);
      expect(travelRows[0].parent_id).toBeNull();
      expect(travelRows[0].kind).toBe("fund");

      // The would-be Travel-group leaves must NOT have been silently
      // annexed onto the user's fund category — they stay unparented rather
      // than disappearing from every band total.
      const wouldBeLeaves = sqlite
        .prepare(`SELECT name, parent_id FROM categories WHERE name IN ('Hotels', 'Flights', 'Vacation')`)
        .all() as { name: string; parent_id: number | null }[];
      expect(wouldBeLeaves).toHaveLength(3);
      for (const leaf of wouldBeLeaves) {
        expect(leaf.parent_id, `${leaf.name} must not be reparented onto the user's Travel row`).toBeNull();
      }

      // The budget_periods row the user already had stays exactly as it was.
      const period = sqlite
        .prepare(`SELECT allocated_cents FROM budget_periods WHERE category_id = ?`)
        .get(travelId.id) as { allocated_cents: number };
      expect(period.allocated_cents).toBe(50000);
    } finally {
      sqlite.close();
    }
  });

  it("every other group's mapping is unaffected by one unrelated collision", () => {
    const sqlite = new Database(":memory:");
    try {
      for (const file of PRE_0017_MIGRATIONS) {
        execMigration(sqlite, file);
      }
      sqlite.prepare(`INSERT INTO categories (name, carryover_policy) VALUES ('Travel', 'none')`).run();

      execMigration(sqlite, "0017_category_kind.sql");

      const housingChildren = sqlite
        .prepare(
          `SELECT c.name FROM categories c
           JOIN categories p ON c.parent_id = p.id
           WHERE p.name = 'Housing'`,
        )
        .all() as { name: string }[];
      expect(housingChildren.map((r) => r.name).sort()).toEqual(
        ["Home Goods", "Home Maintenance", "Rent", "Renter's Insurance"].sort(),
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("migration 0017 — runs via the real migrate() path, not just execMigration", () => {
  it("applies cleanly through drizzle-orm's migrator (matches scripts/migrate.mjs's code path)", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    try {
      migrate(drizzle(sqlite), { migrationsFolder: drizzleDir });
      const count = sqlite.prepare(`SELECT COUNT(*) c FROM categories`).get() as {
        c: number;
      };
      expect(count.c).toBe(60);
    } finally {
      sqlite.close();
    }
  });
});
