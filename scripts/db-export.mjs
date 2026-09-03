#!/usr/bin/env node
/**
 * `pnpm db:export` — runs the bundled snapshot-cli.mjs INSIDE the running
 * container (so it snapshots the live volume, not a stale host copy), then
 * copies the result out to ./backups.
 *
 * Never a bare `docker compose cp` of the live money.db: copying a WAL-mode
 * SQLite file out of a running container while a reader holds an open read
 * transaction is the exact failure src/lib/snapshot.ts documents —
 * `PRAGMA wal_checkpoint` doesn't throw when it can't take the lock, and the
 * resulting copy can fail to open at all with SQLITE_CORRUPT. `VACUUM INTO`
 * (via createSnapshot, run inside the container by snapshot-cli.mjs) avoids
 * that by construction; this script only copies the *result* of that.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SERVICE = process.env.MM_COMPOSE_SERVICE ?? "app";
const BACKUPS_DIR = path.join(process.cwd(), "backups");

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Parses snapshot-cli.mjs's stdout (the last line of it — `docker compose
 * exec` output can carry warnings above the JSON) and decides whether it's
 * safe to copy the result out. Pure and docker-free, so it's unit-testable
 * without a live container.
 */
export function evaluateSnapshotOutput(rawOutput) {
  const line = rawOutput.trim().split("\n").pop() ?? "";
  let result;
  try {
    result = JSON.parse(line);
  } catch {
    return {
      ok: false,
      message: `snapshot-cli.mjs produced no readable JSON — last line of output: ${JSON.stringify(line)}`,
    };
  }

  if (result.error) {
    return { ok: false, message: `Snapshot failed inside the container: ${result.error}` };
  }
  if (!result.consistent) {
    return {
      ok: false,
      message:
        `Snapshot degraded to a plain copy (${result.degradedReason}) — refusing to export it. ` +
        "It may be missing recent writes, or fail to open at all if restored. No file was copied out.",
    };
  }
  return { ok: true, snapshotPath: result.snapshotPath };
}

export function main() {
  let raw;
  try {
    raw = execFileSync(
      "docker",
      ["compose", "exec", "-T", SERVICE, "node", "/app/scripts/snapshot-cli.mjs"],
      { encoding: "utf8" },
    );
  } catch (err) {
    // snapshot-cli.mjs always prints one line of diagnostic JSON to stdout
    // before exiting non-zero (see its own file comment) — but execFileSync's
    // thrown error's `.message` is just "Command failed: docker compose exec
    // ...", not the child's output. The real reason lives on `err.stdout`.
    const stdout = typeof err.stdout === "string" ? err.stdout.trim() : "";
    let detail = stdout;
    if (stdout) {
      try {
        detail = JSON.parse(stdout.split("\n").pop()).error ?? stdout;
      } catch {
        // stdout wasn't JSON either — fall back to the raw text above.
      }
    }
    fail(`snapshot-cli.mjs failed inside the container: ${detail || err.message}`);
  }

  const evaluated = evaluateSnapshotOutput(raw);
  if (!evaluated.ok) fail(evaluated.message);

  if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });

  const containerPath = evaluated.snapshotPath; // e.g. /app/backups/money.db.export-...
  const filename = path.basename(containerPath);
  const destPath = path.join(BACKUPS_DIR, filename);

  // With the default SNAPSHOT_DIR=/app/backups (compose.yaml), containerPath
  // and destPath are the same file on the ./backups bind mount — `docker
  // compose cp` would unlink/truncate destPath while the daemon is still
  // reading that same inode as its source, a race that only wins by luck.
  // Skip the copy entirely when it would be a same-file no-op; only actually
  // shell out when SNAPSHOT_DIR was overridden to somewhere else inside the
  // container.
  if (!existsSync(destPath)) {
    execFileSync("docker", [
      "compose",
      "cp",
      `${SERVICE}:${containerPath}`,
      destPath,
    ]);
  }

  console.log(`Exported ${destPath} (consistent: true)`);
  return destPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
