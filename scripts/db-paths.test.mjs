import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";

async function freshDbPaths() {
  // db-paths.mjs reads process.env at call time (no module-level caching),
  // so a plain re-import is enough — no vi.resetModules() needed.
  return import("./db-paths.mjs");
}

describe("db-paths", () => {
  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  it("defaults to ./data/money.db under process.cwd()", async () => {
    const { dbPath } = await freshDbPaths();
    expect(dbPath()).toBe(path.join(process.cwd(), "data", "money.db"));
  });

  it("DATA_DIR overrides the data directory, matching src/lib/paths.ts", async () => {
    process.env.DATA_DIR = "/tmp/mm-data";
    const { dbPath } = await freshDbPaths();
    expect(dbPath()).toBe(path.join("/tmp/mm-data", "money.db"));
  });
});
