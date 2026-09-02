#!/usr/bin/env node
/**
 * One-time: exchange a SimpleFIN setup token for a long-lived access URL.
 *
 * The setup token is SINGLE USE. Once claimed it cannot be claimed again --
 * if this script fails after the POST succeeds, it prints the raw access URL
 * as a last resort so the claim isn't lost. Losing the credential is worse
 * than echoing it into your own terminal.
 *
 *   SIMPLEFIN_SETUP_TOKEN=... node scripts/simplefin-claim.mjs
 *   node scripts/simplefin-claim.mjs <token>
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";

const ENV_PATH = path.join(process.cwd(), ".env.local");
const KEY = "SIMPLEFIN_ACCESS_URL";

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

const token = process.env.SIMPLEFIN_SETUP_TOKEN ?? process.argv[2];
if (!token) {
  fail(
    "No setup token.\n" +
      "    SIMPLEFIN_SETUP_TOKEN=... node scripts/simplefin-claim.mjs\n" +
      "  or\n" +
      "    node scripts/simplefin-claim.mjs <token>",
  );
}

const force = process.argv.includes("--force");
const existingEnv = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
if (existingEnv.includes(`${KEY}=`) && !force) {
  fail(
    `${KEY} already exists in .env.local.\n` +
      "  Claiming again would burn a fresh setup token and overwrite a working\n" +
      "  credential. Re-run with --force if that's really what you want.",
  );
}

// The setup token is a base64-encoded claim URL.
let claimUrl;
try {
  claimUrl = Buffer.from(token.trim(), "base64").toString("utf8").trim();
} catch {
  fail("Token is not valid base64.");
}

let parsed;
try {
  parsed = new URL(claimUrl);
} catch {
  fail(`Decoded token is not a URL. Got: ${claimUrl.slice(0, 80)}`);
}
if (parsed.protocol !== "https:") {
  fail(`Refusing to POST credentials over ${parsed.protocol} (expected https).`);
}

console.log(`\n  Claiming against ${parsed.origin} ...`);

const res = await fetch(claimUrl, { method: "POST" });
const body = (await res.text()).trim();

if (!res.ok) {
  fail(
    `Claim failed: HTTP ${res.status}\n  ${body.slice(0, 300)}\n\n` +
      "  A 403 usually means the token was already claimed. Generate a new one\n" +
      "  at the SimpleFIN Bridge and try again.",
  );
}

let accessUrl;
try {
  accessUrl = new URL(body);
} catch {
  fail(`Claim returned something that isn't a URL:\n  ${body.slice(0, 300)}`);
}
if (!accessUrl.username) {
  fail("Access URL has no embedded credentials -- unexpected. Aborting.");
}

// Append or replace the key, preserving everything else in the file.
const line = `${KEY}=${body}`;
const next = existingEnv.includes(`${KEY}=`)
  // Replacer FUNCTION, not a string: `$&`/`$'` sequences inside the credential
  // would otherwise be expanded, silently corrupting an unrepeatable token.
  ? existingEnv.replace(new RegExp(`^${KEY}=.*$`, "m"), () => line)
  : (existingEnv && !existingEnv.endsWith("\n") ? existingEnv + "\n" : existingEnv) +
    line +
    "\n";

try {
  writeFileSync(ENV_PATH, next, { mode: 0o600 });
  // `mode` only applies when the file is CREATED, and .env.local usually
  // already exists — enforce owner-only on the existing-file path too.
  chmodSync(ENV_PATH, 0o600);
} catch (err) {
  console.error(
    "\n  ✗ Claim SUCCEEDED but writing .env.local failed. The token is now spent,\n" +
      "    so save this by hand immediately -- it cannot be re-claimed:\n\n" +
      `    ${KEY}=${body}\n`,
  );
  fail(String(err));
}

console.log(
  `  ✓ Saved ${KEY} to .env.local (host: ${accessUrl.host}, user: ${accessUrl.username.slice(0, 4)}…)\n` +
    "\n  Next: pnpm simplefin:sample\n",
);
