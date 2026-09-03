import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { checkTz, checkCwd, runMigrations } from "./entrypoint.src.mjs";

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
