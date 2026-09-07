#!/usr/bin/env node
/**
 * `pnpm db:backfill-merchants` — host half. Runs the bundled
 * scripts/backfill-merchants.mjs INSIDE the running container, so it operates on
 * the live `mm_data` volume rather than on either stale host copy of money.db.
 *
 * Flags are passed straight through, so the two real invocations are:
 *
 *     pnpm db:backfill-merchants                     # dry run, writes nothing
 *     pnpm db:backfill-merchants --apply             # snapshot + write
 *
 * Two refusals each need their own opt-in, and each exits with a distinct code:
 * `--resolve-conflicts` (exit 2) for a collision whose rules disagree about the
 * category, and `--allow-degraded-snapshot` (exit 3) when the pre-write snapshot
 * could not be taken cleanly — usually fixed by stopping the app container so
 * nothing holds a read, rather than by passing the flag. Exit 1 is a post-write
 * verification failure. All are passed through untouched.
 *
 * The container must have been rebuilt from the branch carrying the normalizer
 * change (`docker compose build && docker compose up -d`), for two reasons: the
 * bundled script is produced in the Docker builder stage and won't exist in an
 * older image, and backfilling to a normalizer the running app doesn't have
 * would put the ledger a generation AHEAD of the code writing to it — the same
 * mismatch this script exists to close, pointed the other way.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SERVICE = process.env.MM_COMPOSE_SERVICE ?? "app";
const SCRIPT = "/app/scripts/backfill-merchants.mjs";

const REBUILD_HINT =
  `Could not find ${SCRIPT} in the "${SERVICE}" container.\n` +
  "It is a build artifact produced during the Docker builder stage, so an image\n" +
  "built before this change won't have it. Rebuild and retry:\n" +
  "    docker compose build && docker compose up -d";

const NO_DOCKER_HINT =
  'Could not run "docker" — it is not installed, or not on PATH.\n' +
  "The live ledger is in the mm_data volume, so this has to run inside the\n" +
  "container. Start Docker and retry.";

export function main(argv = process.argv.slice(2), { exec = execFileSync } = {}) {
  // Probe for the bundled artifact FIRST, as its own command, because the real
  // run cannot report its absence distinguishably. The missing file is an
  // ARGUMENT to `node`, not the executable, so node exits 1 — not the 127 a
  // shell gives for a missing binary — and `stdio: "inherit"` sends its
  // MODULE_NOT_FOUND straight to the terminal, never into `err.message`. Both
  // signals an earlier version keyed on were therefore unreachable, which left
  // the single most likely first-run failure printing a raw stack trace.
  //
  // `node -e` rather than `test -f`: it is the same binary the real run needs,
  // so the probe cannot fail for a reason the run wouldn't have.
  try {
    exec(
      "docker",
      [
        "compose", "exec", "-T", SERVICE, "node", "-e",
        `process.exit(require("node:fs").existsSync(${JSON.stringify(SCRIPT)}) ? 0 : 1)`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(NO_DOCKER_HINT);
      process.exit(1);
    }
    // The probe prints nothing of its own, so a silent non-zero is the file
    // genuinely being absent. Anything on stderr came from compose itself
    // (service not running, unknown service, daemon down) and is a different
    // problem that deserves its own words rather than a rebuild instruction.
    const stderr = String(err.stderr ?? "").trim();
    if (stderr) {
      console.error(stderr);
      process.exit(err.status ?? 1);
    }
    console.error(REBUILD_HINT);
    process.exit(1);
  }

  try {
    exec("docker", ["compose", "exec", "-T", SERVICE, "node", SCRIPT, ...argv], {
      stdio: "inherit",
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(NO_DOCKER_HINT);
      process.exit(1);
    }
    // Exit 2 is the script's own deliberate refusal (a category-conflicting
    // collision), and exit 1 can be its post-write verification failure — both
    // have already printed what happened and what to do, so a banner on top
    // would only bury it. Pass the status through untouched.
    process.exit(err.status ?? 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
