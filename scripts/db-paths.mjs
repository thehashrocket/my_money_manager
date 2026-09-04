// Single source of truth for the SQLite file and migrations folder,
// imported by both drizzle.config.ts (drizzle-kit) and scripts/migrate.mjs
// (the hand-rolled runner) so the two can't drift apart.
//
// DATA_DIR resolution here duplicates src/lib/paths.ts's dataDir() rather
// than importing it: both of this file's consumers run as plain `node`/
// `drizzle-kit` processes with no TS loader, so a `.ts` import isn't
// available to them the way it is to the esbuild-bundled Docker entrypoint.
// Keep the two in sync by hand if the DATA_DIR rule ever changes.
import path from "node:path";

export function dbPath() {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), "data");
  return path.join(dataDir, "money.db");
}

export const MIGRATIONS_FOLDER = "./drizzle";
