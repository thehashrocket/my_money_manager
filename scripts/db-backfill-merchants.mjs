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
 * and, only if the dry run reports a collision whose rules disagree about the
 * category, additionally `--resolve-conflicts`.
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

export function main(argv = process.argv.slice(2)) {
  try {
    execFileSync(
      "docker",
      ["compose", "exec", "-T", SERVICE, "node", SCRIPT, ...argv],
      { stdio: "inherit" },
    );
  } catch (err) {
    // Exit 2 is the script's own deliberate refusal (a category-conflicting
    // collision), not a crash — it has already printed the offending rules and
    // the exact command to re-run, so adding a failure banner on top would bury
    // that. Anything else is a real failure worth naming.
    if (err.status === 2) process.exit(2);
    if (err.status === 127 || /ENOENT/.test(String(err.message))) {
      console.error(
        `Could not run ${SCRIPT} in the "${SERVICE}" container.\n` +
          "It is a build artifact produced during the Docker builder stage, so an image\n" +
          "built before this change won't have it. Rebuild and retry:\n" +
          "    docker compose build && docker compose up -d",
      );
      process.exit(1);
    }
    process.exit(err.status ?? 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
