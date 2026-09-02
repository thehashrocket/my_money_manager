#!/usr/bin/env node
/**
 * Pull one real /accounts response and dump it to .context/ for analysis.
 *
 * Read-only against SimpleFIN. Touches nothing in data/money.db. The point is
 * to answer the questions we can't answer from the spec:
 *   - does `extra` carry a bank transaction number? (decides transfer matching)
 *   - what do `description` strings look like? (decides merchant normalization)
 *   - do pending transactions show up, and how?
 *
 *   node scripts/simplefin-fetch-sample.mjs [--days 90]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const OUT_PATH = path.join(process.cwd(), ".context", "simplefin-sample.json");
const ENV_PATH = path.join(process.cwd(), ".env.local");

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

function readEnvLocal(key) {
  if (process.env[key]) return process.env[key];
  if (!existsSync(ENV_PATH)) return null;
  for (const raw of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const raw = readEnvLocal("SIMPLEFIN_ACCESS_URL");
if (!raw) fail("No SIMPLEFIN_ACCESS_URL in .env.local. Run `pnpm simplefin:claim` first.");

let access;
try {
  access = new URL(raw);
} catch {
  fail("SIMPLEFIN_ACCESS_URL is not a valid URL.");
}

const daysArg = process.argv.indexOf("--days");
const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) : 90;
if (!Number.isFinite(days) || days <= 0) fail("--days must be a positive number.");

// Send credentials as an Authorization header rather than inline in the URL.
const auth = Buffer.from(
  `${decodeURIComponent(access.username)}:${decodeURIComponent(access.password)}`,
).toString("base64");

const startDate = Math.floor(Date.now() / 1000) - days * 86400;
const endpoint = new URL(`${access.origin}${access.pathname.replace(/\/$/, "")}/accounts`);
endpoint.searchParams.set("start-date", String(startDate));
endpoint.searchParams.set("pending", "1");

console.log(`\n  GET ${endpoint.pathname}?${endpoint.searchParams} (last ${days} days)`);

const res = await fetch(endpoint, { headers: { Authorization: `Basic ${auth}` } });
const text = await res.text();
if (!res.ok) fail(`HTTP ${res.status}\n  ${text.slice(0, 500)}`);

let data;
try {
  data = JSON.parse(text);
} catch {
  fail(`Response was not JSON:\n  ${text.slice(0, 500)}`);
}

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });

// ---- structural summary: the stuff the spec wouldn't tell us ----

const accounts = data.accounts ?? [];
const allTxns = accounts.flatMap((a) => a.transactions ?? []);
const keysOf = (objs) => [...new Set(objs.flatMap((o) => Object.keys(o ?? {})))].sort();

console.log(`\n  Wrote ${OUT_PATH}`);
if (data.errors?.length) console.log(`\n  ⚠ errors[]: ${JSON.stringify(data.errors)}`);

console.log(`\n  ACCOUNTS (${accounts.length})`);
for (const a of accounts) {
  const n = (a.transactions ?? []).length;
  const when = a["balance-date"]
    ? new Date(a["balance-date"] * 1000).toISOString().slice(0, 16).replace("T", " ")
    : "?";
  console.log(
    `    [${a.id}] ${a.org?.name ?? "?"} / ${a.name}\n` +
      `        balance ${a.balance}  available ${a["available-balance"] ?? "—"}  as of ${when} UTC  ·  ${n} txns`,
  );
}

console.log(`\n  TRANSACTION KEYS (union over ${allTxns.length} txns)`);
console.log(`    ${keysOf(allTxns).join(", ") || "(none)"}`);

const extras = allTxns.map((t) => t.extra).filter(Boolean);
console.log(`\n  extra{} KEYS  — ${extras.length}/${allTxns.length} txns have one`);
console.log(`    ${keysOf(extras).join(", ") || "(no extra field at all)"}`);
if (extras.length) console.log(`    first extra: ${JSON.stringify(extras[0])}`);

const pending = allTxns.filter((t) => t.pending);
console.log(`\n  PENDING: ${pending.length} of ${allTxns.length}`);
if (pending.length) console.log(`    example: ${JSON.stringify(pending[0])}`);

console.log(`\n  SAMPLE DESCRIPTIONS (up to 15)`);
for (const t of allTxns.slice(0, 15)) {
  const d = new Date((t.posted || t.transacted_at || 0) * 1000).toISOString().slice(0, 10);
  console.log(`    ${d}  ${String(t.amount).padStart(10)}  ${JSON.stringify(t.description)}`);
}
console.log("");
