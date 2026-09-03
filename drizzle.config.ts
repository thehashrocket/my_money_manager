import { defineConfig } from "drizzle-kit";
import { DB_PATH, MIGRATIONS_FOLDER } from "./scripts/db-paths.mjs";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: MIGRATIONS_FOLDER,
  dialect: "sqlite",
  dbCredentials: {
    url: DB_PATH,
  },
  strict: true,
  verbose: true,
});
