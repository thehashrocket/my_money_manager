#!/usr/bin/env node
/**
 * First-run host -> volume database copy (`pnpm db:seed-volume`).
 *
 * Run this BEFORE the first `docker compose up`. The named volume
 * (`mm_data`, see compose.yaml — a named volume, not a bind mount, because
 * SQLite WAL-mode locking over VirtioFS/gRPC-FUSE is a known corruption
 * hazard) starts empty, and `.dockerignore` excludes `data/`, so without
 * this step the container serves a brand-new empty ledger — the headline
 * containerization goal silently unmet.
 *
 * Idempotent-by-refusal, not idempotent-by-overwrite: if the volume
 * already has a `money.db` (including one just migrated-empty by a prior
 * `docker compose up`), this refuses rather than clobbering it. Overwriting
 * a live containerized ledger with a stale host copy is a worse outcome
 * than an error message.
 *
 * The seed is never a bare `cp` of `data/money.db`: the host database runs
 * in WAL mode, so committed rows can live only in `money.db-wal`, and a
 * plain file copy would silently drop them (or worse, pair an old main file
 * with a newer WAL). `createSnapshot()`'s `VACUUM INTO` produces a single
 * consistent, self-contained file through the connection, seeing
 * WAL-resident commits by construction — the same mechanism CLAUDE.md rule
 * 5 requires for every pre-write snapshot, not a weaker one here.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createSnapshot, listSnapshots } from "../src/lib/snapshot.ts";
import { dbPath, snapshotDir } from "../src/lib/paths.ts";

const VOLUME_NAME = process.env.MM_VOLUME_NAME ?? "my_money_manager_mm_data";
const SERVICE = process.env.MM_COMPOSE_SERVICE ?? "app";
const BACKUPS_DIR = path.join(process.cwd(), "backups");

function fail(message) {
  console.error(message);
  process.exit(1);
}

export function accountBalances(sqlitePath) {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const accounts = db.prepare("SELECT id, starting_balance_cents, starting_balance_date FROM accounts").all();
    const balances = {};
    for (const a of accounts) {
      const row = db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND date > ?",
        )
        .get(a.id, a.starting_balance_date);
      balances[a.id] = a.starting_balance_cents + row.total;
    }
    return balances;
  } finally {
    db.close();
  }
}

export function tableCounts(sqlitePath, tables) {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const counts = {};
    for (const t of tables) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    }
    return counts;
  } finally {
    db.close();
  }
}

const TABLES = [
  "accounts",
  "categories",
  "transactions",
  "import_batches",
  "budget_periods",
];

function volumeHasDb() {
  try {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${VOLUME_NAME}:/data`,
        "busybox",
        "test",
        "-e",
        "/data/money.db",
      ],
      { stdio: "ignore" },
    );
    return true; // exit 0 => file exists
  } catch (err) {
    if (err.status === 1) return false; // test's own "false" exit code
    throw err; // docker itself failed (no daemon, image pull failure, ...)
  }
}

export function assertVolumeEmpty(hasDb) {
  if (hasDb) {
    return {
      ok: false,
      message:
        `${VOLUME_NAME} already has a money.db — refusing to overwrite it. ` +
        "If you mean to replace a live containerized ledger, use `pnpm db:import` (which takes an explicit snapshot file and a stopped container), not this script.",
    };
  }
  return { ok: true };
}

export function assertConsistentSnapshot(snapshot) {
  if (!snapshot.consistent) {
    return {
      ok: false,
      message: `Pre-seed snapshot degraded to a plain copy (${snapshot.degradedReason}) — refusing to seed from a copy that may be missing recent writes or fail to open at all. Nothing was written to the volume.`,
    };
  }
  return { ok: true };
}

/** First mismatch wins — enough to point at what to investigate by hand. */
export function verifySeed({ tables, sourceCounts, sourceBalances, volumeCounts, volumeBalances }) {
  for (const t of tables) {
    if (volumeCounts[t] !== sourceCounts[t]) {
      return {
        ok: false,
        message: `Row count mismatch after seeding table "${t}": source has ${sourceCounts[t]}, volume has ${volumeCounts[t]}. The volume was written but does not match the source — investigate before using it.`,
      };
    }
  }
  for (const [accountId, expected] of Object.entries(sourceBalances)) {
    if (volumeBalances[accountId] !== expected) {
      return {
        ok: false,
        message: `Balance mismatch after seeding account ${accountId}: source computes ${expected}, volume computes ${volumeBalances[accountId]}.`,
      };
    }
  }
  return { ok: true };
}

function main() {
  const HOST_DB = dbPath();
  if (!existsSync(HOST_DB)) {
    console.log(
      `No host database at ${HOST_DB} — nothing to seed. ` +
        "A fresh `docker compose up` will start with an empty ledger; import a CSV or run `pnpm db:migrate` first if that's not what you want.",
    );
    return;
  }

  const emptyCheck = assertVolumeEmpty(volumeHasDb());
  if (!emptyCheck.ok) fail(emptyCheck.message);

  const tmpDir = mktempSeedDir();
  try {
    const snapshot = createSnapshot(HOST_DB, tmpDir);
    const consistentCheck = assertConsistentSnapshot(snapshot);
    if (!consistentCheck.ok) fail(consistentCheck.message);

    const sourceCounts = tableCounts(snapshot.snapshotPath, TABLES);
    const sourceBalances = accountBalances(snapshot.snapshotPath);

    execFileSync("docker", [
      "run",
      "--rm",
      "-v",
      `${VOLUME_NAME}:/data`,
      "-v",
      `${tmpDir}:/seed:ro`,
      "busybox",
      "cp",
      `/seed/${path.basename(snapshot.snapshotPath)}`,
      "/data/money.db",
    ]);

    // A brand-new named volume's mount point is created (and, via `cp`
    // above, populated) as root, because `busybox` runs as root by default.
    // The app itself runs as the unprivileged `node` user (uid 1000, see
    // Dockerfile) — left root-owned, its own pre-write snapshots (rule 5)
    // would fail with EACCES the first time anything writes to the volume.
    execFileSync("docker", [
      "run",
      "--rm",
      "-v",
      `${VOLUME_NAME}:/data`,
      "busybox",
      "chown",
      "-R",
      "1000:1000",
      "/data",
    ]);

    const verifyScript = `
      const Database = require("better-sqlite3");
      const db = new Database("/app/data/money.db", { readonly: true });
      const tables = ${JSON.stringify(TABLES)};
      const counts = {};
      for (const t of tables) counts[t] = db.prepare("SELECT COUNT(*) AS n FROM " + t).get().n;
      const accounts = db.prepare("SELECT id, starting_balance_cents, starting_balance_date FROM accounts").all();
      const balances = {};
      for (const a of accounts) {
        const row = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND date > ?").get(a.id, a.starting_balance_date);
        balances[a.id] = a.starting_balance_cents + row.total;
      }
      console.log(JSON.stringify({ counts, balances }));
    `;
    const output = execFileSync(
      "docker",
      ["compose", "run", "--rm", "--entrypoint", "node", SERVICE, "-e", verifyScript],
      { encoding: "utf8" },
    );
    const { counts: volumeCounts, balances: volumeBalances } = JSON.parse(
      output.trim().split("\n").pop(),
    );

    const verifyResult = verifySeed({
      tables: TABLES,
      sourceCounts,
      sourceBalances,
      volumeCounts,
      volumeBalances,
    });
    if (!verifyResult.ok) fail(verifyResult.message);

    // Existing snapshot files survive the move onto the new host bind mount;
    // import_batches.snapshot_path rows are left exactly as they are (they
    // are absolute host paths, display-only — rewriting them to a container
    // path that was never true would trade a true-but-stale string for a
    // false one).
    const existingSnapshots = listSnapshots(snapshotDir()).filter(
      (p) => p !== snapshot.snapshotPath,
    );
    if (existingSnapshots.length > 0) {
      execFileSync("mkdir", ["-p", BACKUPS_DIR]);
      for (const p of existingSnapshots) {
        copyFileSync(p, path.join(BACKUPS_DIR, path.basename(p)));
      }
      console.log(`Copied ${existingSnapshots.length} existing snapshot(s) to ${BACKUPS_DIR}`);
    }

    console.log(
      `Seeded ${VOLUME_NAME} from ${HOST_DB} — ${TABLES.map((t) => `${t}: ${sourceCounts[t]}`).join(", ")}. Balances verified for ${Object.keys(sourceBalances).length} account(s).`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function mktempSeedDir() {
  return mkdtempSync(path.join(tmpdir(), "mm-seed-"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
