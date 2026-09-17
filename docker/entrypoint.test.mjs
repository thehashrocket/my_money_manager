import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  checkTz,
  checkCwd,
  runMigrations,
  hasPendingMigrations,
  checkPreMigrateSnapshot,
  quarantineDegradedSnapshot,
} from "./entrypoint.src.mjs";

describe("entrypoint guards", () => {
  it("checkTz fails when TZ is unset", () => {
    expect(checkTz({})).toEqual({
      ok: false,
      message: expect.stringContaining("TZ is required"),
    });
  });

  it("checkTz passes when TZ is set, to anything including UTC", () => {
    expect(checkTz({ TZ: "America/Los_Angeles" })).toEqual({ ok: true });
    expect(checkTz({ TZ: "UTC" })).toEqual({ ok: true });
  });

  it("checkTz fails on a typo'd TZ instead of silently behaving as UTC", () => {
    // Verified this is a real Node behavior, not a hypothetical: an invalid
    // IANA zone name doesn't throw anywhere on its own — Node just silently
    // renders as UTC, reintroducing the exact bug this file exists to catch.
    const result = checkTz({ TZ: "America/Los_Angelss" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a recognized IANA timezone");
  });

  it("checkCwd fails when process.cwd() is not /app", () => {
    const result = checkCwd("/");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("/app");
    expect(result.message).toContain("got / instead");
  });

  it("checkCwd passes when process.cwd() is /app", () => {
    expect(checkCwd("/app")).toEqual({ ok: true });
  });
});

describe("runMigrations", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies the repo's real migrations cleanly (pragmas set before migrate)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-migrate-"));
    const dbPath = path.join(dir, "money.db");

    const result = runMigrations(dbPath, path.join(process.cwd(), "drizzle"));

    expect(result.migrationError).toBeNull();
    expect(result.violations).toEqual([]);

    // journal_mode is persisted in the file itself (unlike foreign_keys,
    // which is connection-scoped) — reopening and reading it back proves
    // the pragma was actually applied, not just requested.
    const reopened = new Database(dbPath, { readonly: true });
    expect(reopened.pragma("journal_mode", { simple: true })).toBe("wal");
    reopened.close();
  });

  it("migrate throws → migrationError is set, and the schema is not left half-applied unnoticed", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-migrate-fail-"));
    const dbPath = path.join(dir, "money.db");
    const migrationsFolder = path.join(dir, "drizzle");
    const metaDir = path.join(migrationsFolder, "meta");
    mkdirSync(metaDir, { recursive: true });

    // A migration journal pointing at SQL that doesn't parse — the same
    // failure shape as a bad hand-written migration reaching a container.
    writeFileSync(
      path.join(metaDir, "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [{ idx: 0, version: "6", when: Date.now(), tag: "0000_broken", breakpoints: true }],
      }),
    );
    writeFileSync(path.join(migrationsFolder, "0000_broken.sql"), "THIS IS NOT VALID SQL;");

    const result = runMigrations(dbPath, migrationsFolder);

    expect(result.migrationError).not.toBeNull();
  });

  it("catches a dangling FK reference even when migrate() itself reports no error", () => {
    // CLAUDE.md rule 7: a partially-applied rebuild is exactly the case where
    // a dangling reference is most likely, and it can coexist with migrate()
    // succeeding — this asserts main()'s foreign_key_check runs regardless.
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-fk-"));
    const dbPath = path.join(dir, "money.db");
    const migrationsFolder = path.join(process.cwd(), "drizzle");

    runMigrations(dbPath, migrationsFolder);

    // Only possible because runMigrations leaves foreign_keys OFF — the same
    // condition under which a real rebuild migration could leave a dangling
    // reference behind unnoticed.
    const sqlite = new Database(dbPath);
    sqlite.pragma("foreign_keys = OFF");
    sqlite
      .prepare(
        "INSERT INTO category_rules (category_id, match_type, match_value, priority, source) VALUES (999999, 'exact', 'test', 50, 'manual')",
      )
      .run();
    sqlite.close();

    const result = runMigrations(dbPath, migrationsFolder);

    expect(result.migrationError).toBeNull();
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

describe("hasPendingMigrations", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is true when there is no database file yet, but there are real migrations", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-nodb-"));
    const dbPath = path.join(dir, "money.db");
    const migrationsFolder = path.join(process.cwd(), "drizzle");

    expect(hasPendingMigrations(dbPath, migrationsFolder)).toBe(true);
  });

  it("is false once every migration in the folder has been applied", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-applied-"));
    const dbPath = path.join(dir, "money.db");
    const migrationsFolder = path.join(process.cwd(), "drizzle");

    runMigrations(dbPath, migrationsFolder);

    expect(hasPendingMigrations(dbPath, migrationsFolder)).toBe(false);
  });

  it("is true again once a new migration is added to the folder after the database last applied one", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-new-"));
    const dbPath = path.join(dir, "money.db");
    const realMigrationsFolder = path.join(process.cwd(), "drizzle");

    // Apply every real migration first, matching a container that has
    // already caught up to the image it booted from.
    runMigrations(dbPath, realMigrationsFolder);
    expect(hasPendingMigrations(dbPath, realMigrationsFolder)).toBe(false);

    // Then simulate a NEWER image landing with one more migration than the
    // database has ever seen — the exact situation an ordinary restart
    // (nothing new) has to be told apart from.
    const migrationsFolder = path.join(dir, "drizzle-with-one-more");
    const metaDir = path.join(migrationsFolder, "meta");
    mkdirSync(metaDir, { recursive: true });
    const realJournal = JSON.parse(readFileSync(path.join(realMigrationsFolder, "meta", "_journal.json"), "utf8"));
    for (const entry of realJournal.entries) {
      writeFileSync(
        path.join(migrationsFolder, `${entry.tag}.sql`),
        readFileSync(path.join(realMigrationsFolder, `${entry.tag}.sql`)),
      );
    }
    const newEntry = {
      idx: realJournal.entries.length,
      version: "6",
      when: Date.now() + 1000,
      tag: "9999_not_yet_applied",
      breakpoints: true,
    };
    writeFileSync(path.join(migrationsFolder, "9999_not_yet_applied.sql"), "SELECT 1;");
    writeFileSync(
      path.join(metaDir, "_journal.json"),
      JSON.stringify({ ...realJournal, entries: [...realJournal.entries, newEntry] }),
    );

    expect(hasPendingMigrations(dbPath, migrationsFolder)).toBe(true);
  });

  it("is false when the journal lists zero migrations", () => {
    // Renamed (red-team finding): this creates a WELL-FORMED journal whose
    // entries array is empty, not a genuinely missing/empty migrations
    // folder — the original name claimed coverage this test doesn't
    // provide. See the next test for the actually-missing-folder case.
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-empty-"));
    const dbPath = path.join(dir, "money.db");
    const migrationsFolder = path.join(dir, "empty-migrations");
    const metaDir = path.join(migrationsFolder, "meta");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(path.join(metaDir, "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries: [] }));

    expect(hasPendingMigrations(dbPath, migrationsFolder)).toBe(false);
  });

  it("throws when the migrations folder has no meta/_journal.json at all", () => {
    // The genuinely-missing case the renamed test above does not cover
    // (red-team finding): an image build that failed to bundle drizzle/, or
    // a MIGRATIONS_FOLDER typo. `readMigrationFiles` (drizzle-orm/migrator)
    // throws "Can't find meta/_journal.json file" here, which main() must
    // NOT mislabel as a database problem — see the sibling fix in
    // entrypoint.src.mjs that reads migration files in their own try/catch
    // before this function ever opens the database.
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-nofolder-"));
    const dbPath = path.join(dir, "money.db");
    const migrationsFolder = path.join(dir, "does-not-exist");

    expect(() => hasPendingMigrations(dbPath, migrationsFolder)).toThrow();
  });

  it("is true when the db file exists but has never been migrated at all (no __drizzle_migrations table)", () => {
    // Distinct from "no db file yet" above — a zero-byte or bare file left by
    // a container that crashed before the migrator's own CREATE TABLE IF NOT
    // EXISTS ran (pre-landing review, testing specialist).
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-notable-"));
    const dbPath = path.join(dir, "money.db");
    new Database(dbPath).close();
    const migrationsFolder = path.join(process.cwd(), "drizzle");

    expect(hasPendingMigrations(dbPath, migrationsFolder)).toBe(true);
  });

  it("is true when __drizzle_migrations exists but holds zero rows", () => {
    // Distinct from both the missing-table case above and the fully-applied
    // case earlier — MAX(created_at) over an empty table is NULL, a third
    // branch nothing else here exercises (pre-landing review, testing
    // specialist).
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-emptytable-"));
    const dbPath = path.join(dir, "money.db");
    const db = new Database(dbPath);
    db.exec('CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC)');
    db.close();
    const migrationsFolder = path.join(process.cwd(), "drizzle");

    expect(hasPendingMigrations(dbPath, migrationsFolder)).toBe(true);
  });

  it("throws rather than silently reporting no pending migrations against a corrupt db file", () => {
    // Pins the precondition main() now guards with try/catch (pre-landing
    // review, testing specialist): a truncated or non-SQLite file at
    // dbPath — plausible in the same crash-loop scenario this function
    // exists to help with — must fail loudly, never read as "nothing to do".
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-pending-corrupt-"));
    const dbPath = path.join(dir, "money.db");
    writeFileSync(dbPath, "not a sqlite file");
    const migrationsFolder = path.join(process.cwd(), "drizzle");

    expect(() => hasPendingMigrations(dbPath, migrationsFolder)).toThrow();
  });
});

describe("checkPreMigrateSnapshot", () => {
  it("is ok when the snapshot is consistent", () => {
    expect(checkPreMigrateSnapshot({ consistent: true })).toEqual({ ok: true });
  });

  it("refuses when the snapshot is degraded, naming the reason and the path", () => {
    const result = checkPreMigrateSnapshot({
      consistent: false,
      degradedReason: "VACUUM INTO failed (reader pinned)",
      snapshotPath: "/app/backups/money.db.pre-migrate-2026-01-01",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("VACUUM INTO failed (reader pinned)");
    expect(result.message).toContain("/app/backups/money.db.pre-migrate-2026-01-01");
    // Not `pnpm db:export` — that requires a RUNNING container, which does
    // not exist at the exact moment this refusal fires (red-team finding).
    expect(result.message).toContain("pnpm db:import");
    // Points at CLAUDE.md's Docker section BY NAME rather than repeating the
    // exact chmod command inline (adversarial review, Codex: a duplicated
    // copy of a security-relevant remedy can drift from the one place it's
    // actually documented and tested).
    expect(result.message).toContain("CLAUDE.md's Docker section");
    expect(result.message).not.toContain("chmod");
  });
});

describe("quarantineDegradedSnapshot", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("renames the file out of the PRE_MIGRATE_PREFIX pool without deleting it", () => {
    // Adversarial review (Codex, cross-model-confirmed): a degraded snapshot
    // left under PRE_MIGRATE_PREFIX competes with real historical snapshots
    // for pruneSnapshots' 10-slot retention — this is what keeps it out.
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-quarantine-"));
    const original = path.join(dir, "money.db.pre-migrate-20260101T000000_000Z");
    writeFileSync(original, "degraded snapshot contents");

    const quarantined = quarantineDegradedSnapshot(original);

    expect(existsSync(original)).toBe(false);
    expect(existsSync(quarantined)).toBe(true);
    expect(path.basename(quarantined)).not.toMatch(/^money\.db\.pre-migrate-/);
    expect(readFileSync(quarantined, "utf8")).toBe("degraded snapshot contents");
  });

  it("does not throw when the rename itself fails — reporting the real refusal must never be blocked by cleanup", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-entrypoint-quarantine-fail-"));
    const missing = path.join(dir, "does-not-exist", "money.db.pre-migrate-x");

    expect(() => quarantineDegradedSnapshot(missing)).not.toThrow();
  });
});
