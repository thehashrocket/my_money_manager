import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // esbuild-bundled Docker-image-only artifacts (gitignored) — these
    // inline drizzle-orm's own source, which isn't ours to lint.
    "docker/entrypoint.mjs",
    "scripts/snapshot-cli.mjs",
  ]),
]);

export default eslintConfig;
