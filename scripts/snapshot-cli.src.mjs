/**
 * Callable snapshot entry point for `pnpm db:export`, run **inside** the
 * container (`docker compose exec app node /app/scripts/snapshot-cli.mjs`).
 *
 * Bundled (not run as-is) by scripts/build-docker-artifacts.mjs into
 * scripts/snapshot-cli.mjs during the Docker builder stage, the same way
 * and for the same reason as docker/entrypoint.src.mjs: the runner image
 * has no src/ tree and no devDependencies, so this can't stay a thin
 * `import` of src/lib/snapshot.ts. `better-sqlite3` is excluded from the
 * bundle (external) — see docker/entrypoint.src.mjs's file comment for why.
 *
 * Always prints one line of JSON and exits 0, even when the snapshot
 * degraded to a plain copy — deciding whether `consistent: false` is fatal
 * is scripts/db-export.mjs's job (it runs on the host, has the container
 * exec output, and decides whether to still `docker compose cp` the file
 * out). Exits 1 only when createSnapshot itself throws, e.g. no db file.
 */
import { createSnapshot, EXPORT_PREFIX } from "../src/lib/snapshot.ts";
import { dbPath, snapshotDir } from "../src/lib/paths.ts";

try {
  // EXPORT_PREFIX, not the default pre-import- prefix: this is a deliberate,
  // manually-triggered backup, not an automatic one — sharing the pre-import
  // pool would make it indistinguishable from (and vulnerable to eviction by)
  // the retention-of-10 prune that commitImport/syncSimpleFin run on every
  // write.
  const result = createSnapshot(dbPath(), snapshotDir(), new Date(), EXPORT_PREFIX);
  console.log(JSON.stringify(result));
} catch (err) {
  console.log(
    JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
  );
  process.exit(1);
}
