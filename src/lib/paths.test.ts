import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";

const ENV_KEYS = ["DATA_DIR", "SNAPSHOT_DIR"] as const;

async function freshPaths() {
  // paths.ts reads process.env at call time (no module-level caching), so a
  // plain re-import is enough — no vi.resetModules() needed.
  return import("./paths");
}

describe("paths", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("defaults are byte-identical to today's process.cwd()-derived paths", async () => {
    const { dataDir, dbPath, snapshotDir, pendingDir } = await freshPaths();
    expect(dataDir()).toBe(path.join(process.cwd(), "data"));
    expect(dbPath()).toBe(path.join(process.cwd(), "data", "money.db"));
    expect(snapshotDir()).toBe(path.join(process.cwd(), "data"));
    expect(pendingDir()).toBe(
      path.join(process.cwd(), "data", ".pending-imports"),
    );
  });

  it("DATA_DIR overrides the data directory and everything under it", async () => {
    process.env.DATA_DIR = "/tmp/mm-data";
    const { dataDir, dbPath, snapshotDir, pendingDir } = await freshPaths();
    expect(dataDir()).toBe("/tmp/mm-data");
    expect(dbPath()).toBe(path.join("/tmp/mm-data", "money.db"));
    expect(snapshotDir()).toBe("/tmp/mm-data");
    expect(pendingDir()).toBe(path.join("/tmp/mm-data", ".pending-imports"));
  });

  it("SNAPSHOT_DIR overrides only the snapshot directory", async () => {
    process.env.DATA_DIR = "/tmp/mm-data";
    process.env.SNAPSHOT_DIR = "/tmp/mm-backups";
    const { dataDir, snapshotDir } = await freshPaths();
    expect(dataDir()).toBe("/tmp/mm-data");
    expect(snapshotDir()).toBe("/tmp/mm-backups");
  });
});
