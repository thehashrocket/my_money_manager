import { defineConfig } from "drizzle-kit";
import { dbPath, MIGRATIONS_FOLDER } from "./scripts/db-paths.mjs";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: MIGRATIONS_FOLDER,
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath(),
  },
  strict: true,
  verbose: true,
});
