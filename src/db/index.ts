import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "node:path";
import * as schema from "./schema";

const DB_PATH = path.join(process.cwd(), "data", "money.db");

type SqliteDb = ReturnType<typeof drizzle<typeof schema>>;

const globalForDb = globalThis as unknown as {
  __mm_sqlite?: Database.Database;
  __mm_drizzle?: SqliteDb;
};

function createClient(): SqliteDb {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  globalForDb.__mm_sqlite = sqlite;
  return drizzle(sqlite, { schema });
}

export const db: SqliteDb =
  globalForDb.__mm_drizzle ?? (globalForDb.__mm_drizzle = createClient());

export { schema };
