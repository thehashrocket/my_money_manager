// Single source of truth for the SQLite file and migrations folder,
// imported by both drizzle.config.ts (drizzle-kit) and scripts/migrate.mjs
// (the hand-rolled runner) so the two can't drift apart.
export const DB_PATH = "./data/money.db";
export const MIGRATIONS_FOLDER = "./drizzle";
