import { execFileSync } from "node:child_process";

/**
 * Resolves the actual named-volume name Compose will use, rather than
 * guessing one. compose.yaml pins `name: my_money_manager` specifically so
 * this is stable across different checkout directory names — but that pin
 * is NOT the last word: `COMPOSE_PROJECT_NAME` overrides it (verified:
 * `COMPOSE_PROJECT_NAME=x docker compose config` reports the volume as
 * `x_mm_data` regardless of the pinned `name:` field), and this script
 * shells out to plain `docker run -v <name>:...` for some steps (bypassing
 * `docker compose`, which resolves the name itself). A hardcoded default
 * would silently target a different, empty, auto-created volume than the
 * one `docker compose cp`/`docker compose run` calls in the same script
 * actually touch — `docker run -v` auto-creates a missing named volume with
 * no error, so a mismatch here fails silently rather than loudly.
 */
export function resolveVolumeName(logicalName = "mm_data") {
  if (process.env.MM_VOLUME_NAME) return process.env.MM_VOLUME_NAME;
  const output = execFileSync("docker", ["compose", "config", "--format", "json"], {
    encoding: "utf8",
  });
  const config = JSON.parse(output);
  const resolved = config.volumes?.[logicalName]?.name;
  if (!resolved) {
    throw new Error(
      `could not resolve the "${logicalName}" volume's actual name from \`docker compose config\` — is compose.yaml valid, and does it define a "${logicalName}" volume?`,
    );
  }
  return resolved;
}
