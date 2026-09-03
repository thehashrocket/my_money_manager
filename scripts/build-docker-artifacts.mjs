#!/usr/bin/env node
/**
 * Bundles the two scripts the Docker runner image needs to run standalone,
 * with no src/ tree and no devDependencies: docker/entrypoint.mjs (the
 * container CMD) and scripts/snapshot-cli.mjs (db:export's in-container
 * half). Both outputs are gitignored build artifacts — see docker/
 * entrypoint.src.mjs's file comment for why they can't stay thin wrappers.
 *
 * Run in the Docker builder stage, after `pnpm build`. Requires devDependencies
 * (esbuild), so it never runs in the runner stage or in production.
 */
import { build } from "esbuild";

const targets = [
  { entry: "docker/entrypoint.src.mjs", outfile: "docker/entrypoint.mjs" },
  { entry: "scripts/snapshot-cli.src.mjs", outfile: "scripts/snapshot-cli.mjs" },
];

for (const { entry, outfile } of targets) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // better-sqlite3: the one dependency the tracer is guaranteed to copy
    // correctly (it's in Next's serverExternalPackages list) — everything
    // else must be inlined. /app/server.js: doesn't exist yet at bundle
    // time (this runs before the runner stage assembles the image) and
    // must stay a plain runtime import resolved by Node, not esbuild.
    external: ["better-sqlite3", "/app/server.js"],
    banner: { js: "#!/usr/bin/env node" },
  });
  console.log(`built ${outfile}`);
}
