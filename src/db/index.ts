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

function openClient(): { sqlite: Database.Database; drizzleDb: SqliteDb } {
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite, drizzleDb: drizzle(sqlite, { schema }) };
}

function getClient(): SqliteDb {
  const cached = globalForDb.__mm_sqlite;
  if (cached && cached.open && globalForDb.__mm_drizzle) {
    return globalForDb.__mm_drizzle;
  }
  const { sqlite, drizzleDb } = openClient();
  globalForDb.__mm_sqlite = sqlite;
  globalForDb.__mm_drizzle = drizzleDb;
  return drizzleDb;
}

export const db = new Proxy({} as SqliteDb, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as SqliteDb;

export { schema };
