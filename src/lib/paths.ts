import path from "node:path";

/**
 * `DATA_DIR` / `SNAPSHOT_DIR` let the Docker image point the ledger at a
 * mounted named volume and snapshots at a separate host bind (snapshots must
 * survive `docker compose down -v`; see docs/plans/dockerize-postgres.md,
 * D3.3B) while `pnpm dev` on the host keeps today's defaults byte-identical.
 */
export function dataDir(): string {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), "data");
}

export function dbPath(): string {
  return path.join(dataDir(), "money.db");
}

export function snapshotDir(): string {
  return process.env.SNAPSHOT_DIR
    ? path.resolve(process.env.SNAPSHOT_DIR)
    : dataDir();
}

export function pendingDir(): string {
  return path.join(dataDir(), ".pending-imports");
}
