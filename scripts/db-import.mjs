#!/usr/bin/env node
/**
 * `pnpm db:import <snapshot-file>` — CLAUDE.md rule 5's rollback path under
 * the named-volume topology: stops the container, then restores a
 * `VACUUM INTO` snapshot file (self-contained, no sidecars) into the volume.
 *
 * Refuses to import a bare `money.db` that has a `-wal` file next to it.
 * "Stopped" is not the same as "checkpointed": if the app was killed rather
 * than shut down cleanly, `money.db-wal` can still hold committed rows, and
 * restoring an older main file beside a newer `-wal` is the one move that
 * can corrupt a ledger that was otherwise fine. A `VACUUM INTO` product
 * (from `pnpm db:export` / `pnpm db:seed-volume` / the entrypoint's
 * pre-migrate snapshot) never has sidecars, so it always passes this check.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { resolveVolumeName } from "./docker-volume.mjs";

const SERVICE = process.env.MM_COMPOSE_SERVICE ?? "app";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `docker compose up -d` returns as soon as the container is told to start,
 * not once it's actually healthy — compose.yaml's healthcheck exists
 * specifically because the entrypoint can refuse to boot (a schema-
 * incompatible restore failing its migration guard, say). Without this,
 * `main()` would print "Restored" while the container silently crash-loops
 * behind it. Timeout/interval mirror the wait loop CI already runs around
 * this same script (.github/workflows/ci.yml).
 */
function waitForHealthy(service, { timeoutMs = 60_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containerId = execFileSync("docker", ["compose", "ps", "-q", service], {
      encoding: "utf8",
    }).trim();
    if (containerId) {
      const status = execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", containerId],
        { encoding: "utf8" },
      ).trim();
      if (status === "healthy") return { ok: true };
      if (status === "unhealthy") {
        return {
          ok: false,
          message: `reported unhealthy — check \`docker compose logs ${service}\`.`,
        };
      }
    }
    sleepSync(intervalMs);
  }
  return {
    ok: false,
    message: `did not report healthy within ${timeoutMs}ms — check \`docker compose logs ${service}\`.`,
  };
}

export function assertNoWalSidecar(snapshotFilePath) {
  const walPath = `${snapshotFilePath}-wal`;
  if (existsSync(walPath)) {
    return {
      ok: false,
      message:
        `${snapshotFilePath} has a -wal file next to it (${walPath}) — this is not a ` +
        "VACUUM INTO snapshot, it's a live (or improperly stopped) database file. " +
        "Restoring it would pair a possibly-stale main file with a newer WAL, which can " +
        "corrupt an otherwise-fine ledger. Use a file produced by `pnpm db:export`, " +
        "`pnpm db:seed-volume`, or the container's own pre-migrate snapshot instead.",
    };
  }
  return { ok: true };
}

/**
 * A 0-byte or truncated file is still a file SQLite will happily open as a
 * valid, empty database — `new Database(path)` doesn't throw, so a corrupt
 * `docker compose cp` mid-copy or a mistakenly-passed empty file would
 * "restore" as a silently empty ledger with no error anywhere. Checking for
 * a known core table catches that before the live volume is ever touched.
 */
export function assertRestorableSnapshot(snapshotFilePath) {
  let db;
  try {
    db = new Database(snapshotFilePath, { readonly: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
      .get();
    if (!row) {
      return {
        ok: false,
        message: `${snapshotFilePath} does not look like a my_money_manager database — no "accounts" table found. It may be empty, truncated, or from something else entirely. Refusing to restore it.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: `${snapshotFilePath} could not be opened as a SQLite database: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    db?.close();
  }
}

export function assertValidImportArgs(snapshotFilePath) {
  if (!snapshotFilePath) {
    return { ok: false, message: "Usage: pnpm db:import <path-to-snapshot-file>" };
  }
  if (!existsSync(snapshotFilePath)) {
    return { ok: false, message: `No such file: ${snapshotFilePath}` };
  }
  const walCheck = assertNoWalSidecar(snapshotFilePath);
  if (!walCheck.ok) return walCheck;
  return assertRestorableSnapshot(snapshotFilePath);
}

export function main(snapshotFilePath) {
  const guard = assertValidImportArgs(snapshotFilePath);
  if (!guard.ok) fail(guard.message);

  // Resolved from `docker compose config`, not hardcoded: COMPOSE_PROJECT_NAME
  // overrides compose.yaml's pinned `name:` field, and the bare `docker run -v`
  // calls below bypass docker compose entirely — a mismatch here would silently
  // touch a different, empty, auto-created volume instead of the real one
  // `docker compose cp` above already restored into.
  const VOLUME_NAME = resolveVolumeName();

  console.log(`Stopping ${SERVICE}...`);
  execFileSync("docker", ["compose", "stop", SERVICE]);

  try {
    // A stopped container's filesystem (volumes included) is still reachable
    // via `docker compose cp`, without needing the app to be running.
    console.log(`Restoring ${snapshotFilePath} -> ${VOLUME_NAME}:/app/data/money.db`);
    execFileSync("docker", [
      "compose",
      "cp",
      snapshotFilePath,
      `${SERVICE}:/app/data/money.db`,
    ]);

    // Restoring a snapshot with no sidecars means any -wal/-shm the old
    // running instance left behind in the volume would now describe a
    // different money.db than the one on disk. Clear them so the app doesn't
    // open the restored file and apply a stale, mismatched log.
    execFileSync("docker", [
      "run",
      "--rm",
      "-v",
      `${VOLUME_NAME}:/data`,
      "busybox",
      "sh",
      "-c",
      "rm -f /data/money.db-wal /data/money.db-shm && chown 1000:1000 /data/money.db",
    ]);
  } catch (err) {
    fail(
      `Restore failed partway through (${err instanceof Error ? err.message : String(err)}). ` +
        `The volume may now hold the new file with stale -wal/-shm siblings from the old one — ` +
        `do NOT run \`docker compose up\` yet. Re-run \`pnpm db:import ${snapshotFilePath}\` to retry the ` +
        `restore (it's safe to repeat), or inspect the volume by hand first: ` +
        `\`docker run --rm -v ${VOLUME_NAME}:/data busybox ls -la /data\`.`,
    );
  }

  console.log(`Starting ${SERVICE}...`);
  execFileSync("docker", ["compose", "up", "-d", SERVICE]);

  const health = waitForHealthy(SERVICE);
  if (!health.ok) {
    fail(
      `The file was restored into the volume, but ${SERVICE} ${health.message} ` +
        "The restore itself likely succeeded — this means the container's own boot guard " +
        "(TZ check, migration, or foreign-key check) may be rejecting the restored database.",
    );
  }

  console.log(`Restored ${path.basename(snapshotFilePath)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]);
}
