# Plan — Containerize my_money_manager, then move to Postgres

**Branch:** `thehashrocket/dockerize-with-postgres`
**Status:** cleared to implement — `/plan-eng-review` + 3 `/ship` adversarial rounds.
All plan-level findings folded. One *code* finding stays open by design: F18, a live bug
on `main`, closes when T6a lands in PR1.
**Decision:** staged delivery — PR1 containerizes on SQLite, PR2 migrates to Postgres.
Logged as decision `b2fbbb6b`.

## Why

Two goals, one sentence: run the app in a container, and get to Postgres.

The driver for Postgres is **reaching the app from a phone and running it on a NAS**.
That is a real reason. A NAS-hosted, multi-device app is not the single-process
local-first app this codebase was built as, and Postgres is the boring choice for
the thing it is becoming. Postgres for its own sake would not have justified the
diff below.

## What this costs — the numbers that shaped the plan

```
grep "await db\."               →   0    ← better-sqlite3 is fully synchronous
grep "\.all()|\.get()|\.run()"  → 292    ← every one becomes `await` under pg
files importing @/db            →  35
db.transaction((tx) => …)       →  13    ← synchronous callbacks
test files on :memory: SQLite   →  17
committed drizzle migrations    →   9    ← dialect-locked to sqlite
```

There is no synchronous Postgres driver for Node. So PR2 is not a driver swap —
it is an async conversion that colors most of the `lib/` tier and every page that
reads it. That is why it is a separate PR with its own review.

## Staging

```
  PR1 ─ containerize on SQLite ────────────► shippable, reversible
   │    Dockerfile, compose, standalone output, TZ fix, health endpoint,
   │    programmatic migrator. Zero query-layer changes; all 402 existing tests
   │    keep passing, and PR1 adds ~13 more.
   │
   ▼
  PR2 ─ SQLite → Postgres ─────────────────► shippable, one-way for data
   │    pg schema, async conversion, regenerated migrations, cutover script
   │    with reconciliation, pg_dump snapshots, PGlite test harness.
   │
   ▼
  PR3 ─ NAS + phone access ────────────────► NOT IN THIS PLAN (see NOT in scope)
        Tailscale, multi-arch images, backup schedule.
```

Each arrow is a merge to `main`. PR1 leaves the app strictly better off even if
PR2 never happens.

---

# PR1 — Containerize on SQLite

Goal: `docker compose up` starts the app at `localhost:3000` serving your existing
ledger, with CLAUDE.md rule 5 (snapshot + rollback) intact.

**PR1 includes a data move, and the plan says so.** The named volume starts empty and
`.dockerignore` excludes `data/`, so without a seed step `docker compose up` would show
a brand-new empty database — the headline goal silently unmet (outside voice #1). Host
SQLite → volume SQLite is a real migration; it is just a byte-verifiable one, which is
why it is still the safer half of the staged path (D7.5A).

```
  first run only:  ./data/money.db  ──VACUUM INTO──►  seed.db  ──copy──►  volume
                                     │                                    mm_data:/app/data/money.db
                                     ├── volume already non-empty? → REFUSE, exit 1
                                     ├── consistent === false? → REFUSE, exit 1
                                     ├── verify: per-table row count AND per-account
                                     │           SUM(amount_cents) match the source
                                     ├── copy existing snapshot files → ./backups/
                                     └── source file is never modified or deleted
```

**The seed must not be a bare `cp` of `money.db`.** The host database runs in WAL mode
(`src/db/index.ts:17`), so committed rows routinely live in `money.db-wal` and not yet in
the main file. Copying the main file alone silently drops them; copying main + `-wal`
out of sync is worse, because SQLite will happily open the pair and replay the wrong
thing. This is the same failure class `src/lib/snapshot.ts:62-86` was written for, and
the seed is the first place PR1 touches the real ledger — it does not get a weaker
mechanism than `db:export`. So: `createSnapshot()` on the host to get a `VACUUM INTO`
copy with no sidecars, honor its `consistent` flag, then copy that single self-contained
file into the volume. A row-count check does not make an inconsistent copy safe; it runs
*after* the consistent copy, as a second signal, not as the safety mechanism.

Row counts alone also can't see a truncated `amount_cents`, so the verify compares
per-account `SUM(amount_cents)` as well. This is the cheap version of the PR2
reconciliation, and it is cheap precisely because host→volume is byte-identical
SQLite→SQLite — there is no dialect conversion to hide a difference.

**`import_batches.snapshot_path` gets its files copied, and its rows left alone.** That
column is persisted (`src/db/schema.ts:93`) and rendered at
`src/app/import/success/[batchId]/page.tsx:54` — where it is printed verbatim as text, not
resolved or linked. Existing values are **absolute host paths**: `snapshot.ts:59` builds
them from `path.dirname(dbPath)`, and `dbPath` is `path.join(process.cwd(), …)`.

The tempting move is to rewrite them to `/app/backups`. Don't. The row is a historical
record of where that snapshot was written, the value was never a container path, and the
only consumer displays it to a human sitting at the host — where the host path is the
useful one and `/app/backups/...` is a path they cannot `cd` to. Rewriting history to a
location that was never true trades a true-but-stale string for a false one.

So the seed **copies the existing snapshot files** into `./backups/` (so the artifacts
survive the move and the bind mount is populated from day one) and leaves every
`snapshot_path` value untouched. Snapshots written from this point forward land in
`/app/backups` and record that path, which is correct for them. A row whose file is
already gone stays as it is.

`pnpm db:seed-volume` owns this, and it is idempotent-by-refusal rather than
idempotent-by-overwrite: overwriting a live containerized ledger with a stale host copy
is a worse outcome than an error message.

## Build topology

```
┌─ base ────────── node:24-bookworm-slim, corepack enable
│                  (Node 24 pinned to match .nvmrc + engines)
│
├─ deps ────────── + python3 make g++          ← better-sqlite3 native build
│                  pnpm install --frozen-lockfile
│                  produces node_modules/ incl. build/Release/better_sqlite3.node
│
├─ builder ─────── COPY --from=deps node_modules
│                  COPY . .
│                  pnpm build           → .next/standalone + .next/static
│
└─ runner ──────── node:24-bookworm-slim (NO toolchain)
                   WORKDIR /app                          ← load-bearing, see below
                   COPY --from=builder .next/standalone  → /app
                   COPY --from=builder .next/static      → /app/.next/static
                   COPY --from=builder public            → /app/public
                   COPY --from=builder drizzle           → /app/drizzle
                   COPY --from=builder docker/           → /app/docker/     ← was missing
                   COPY --from=builder scripts/          → /app/scripts/    ← snapshot-cli
                   COPY --from=deps node_modules/better-sqlite3
                                                         → /app/node_modules/better-sqlite3
                   USER node
                   CMD ["node", "/app/docker/entrypoint.mjs"]
```

Three bootstrap bugs, all fixed above and below. Two came from the outside voice (#2):

- The runner COPY list never included `docker/`, so `CMD` pointed at a file that was
  not in the image.
- `import("./server.js")` from `/app/docker/entrypoint.mjs` resolves to
  `/app/docker/server.js`. The entrypoint uses an **absolute** `/app/server.js`.

The third is `WORKDIR`. Every path in this app is resolved from `process.cwd()`:

```
  src/db/index.ts:6            path.join(process.cwd(), "data", "money.db")
  src/lib/importBatch.ts:12    path.join(process.cwd(), "data", "money.db")
  src/lib/simplefin/sync.ts:18 path.join(process.cwd(), "data", "money.db")
  src/lib/pendingImport.ts:13  path.join(process.cwd(), "data", ".pending-imports")
```

`CMD ["node", "/app/docker/entrypoint.mjs"]` sets cwd to the image default (`/`), not to
the script's directory — so without `WORKDIR /app` the ledger, the snapshot directory
and the pending-import stash all resolve to `/data/...`, outside the mounted volume. The
container would boot, migrate, and serve an empty database while the real one sat
unread at `/app/data`. `src/lib/paths.ts` (T2) makes this configurable via `DATA_DIR`,
but `WORKDIR` is what makes the default correct, and the entrypoint asserts
`process.cwd() === "/app"` at boot rather than trusting it.

`pnpm db:export` has the same class of problem: it cannot `node -e` its way into
`createSnapshot`, because standalone output bundles that code into the Next server
rather than leaving it importable. PR1 therefore ships `scripts/snapshot-cli.mjs` — a
real, callable entry point that produces a `SnapshotResult` as JSON. But it **cannot
import `src/lib/snapshot.ts`**: the runner copies `.next/standalone`, `public`,
`drizzle`, `docker/` and `scripts/`, and no `src/` tree exists in the image (nor would a
`.ts` file run under bare `node`). Two ways out, and PR1 takes the first:

- **Bundle it.** Add a tiny esbuild step in the builder stage that compiles
  `src/lib/snapshot.ts` to `scripts/snapshot-cli.mjs` as a self-contained ESM file, and
  copy that artifact. One build step, no source tree in the runner, and the CLI stays a
  thin wrapper over the module the app itself uses — which is the whole point of D3.2B.
- Re-implement `VACUUM INTO` in the CLI. Rejected: it duplicates the one piece of
  hard-won correctness this plan keeps citing, and the copy would drift.

The CI `docker` job smoke-tests `db:export` end to end, so a missing artifact fails the
build rather than surfacing the first time a rollback is needed.

The explicit `better-sqlite3` copy is deliberate. Next's standalone tracer follows
static `import` graphs; `better-sqlite3` resolves its `.node` binary through
`bindings`-style runtime path lookup, which tracing does not always follow. Copying
the package wholesale is two lines and removes the failure mode entirely.

## Files added or changed

| File | Change |
|---|---|
| `Dockerfile` | new — the four stages above |
| `.dockerignore` | new — `node_modules`, `.next`, `data`, `.context`, `.git`, `*.md` |
| `compose.yaml` | new — one `app` service, named volume, **optional** `env_file`, **loopback-only port bind** (D3.1A) |
| `docker/entrypoint.mjs` | new — TZ guard, migrations, then boots `/app/server.js` |
| `scripts/snapshot-cli.mjs` | new — callable snapshot entry point for `db:export` |
| `scripts/seed-volume.mjs` | new — first-run host→volume DB copy, refuses a non-empty target |
| `next.config.ts` | `output: "standalone"` |
| `package.json` | add `"packageManager": "pnpm@10.32.1"` for corepack determinism |
| `src/app/api/health/route.ts` | new — cheap liveness probe |
| `src/lib/now.ts` | new — single source of "what month is it" (see TZ below) |
| `src/lib/paths.ts` | new — `dbPath()` / `snapshotDir()` / `pendingDir()` (D4.1B) |
| 8 server call sites | route `new Date()` / `Date.now()` through `src/lib/now.ts` |
| 4 path constants | route through `src/lib/paths.ts` |
| `.github/workflows/ci.yml` | add a `docker` job that builds the image |
| `README.md` | Docker quickstart |
| `CLAUDE.md` | note the container path alongside `pnpm dev` |

## Three things that are not boilerplate

### 1. Migrations at startup, without shipping drizzle-kit

`pnpm db:migrate` runs `drizzle-kit`, a **devDependency**. The runner stage has no
devDependencies, so the documented migrate command cannot run in the image.

Fix: `docker/entrypoint.mjs` calls Drizzle's programmatic migrator, which lives in
`drizzle-orm` (a real dependency) and reads the same committed `drizzle/` folder:

```
entrypoint.mjs
  ├── if (!process.env.TZ) → log why, exit(1)              ← D4.2B, see TZ below
  ├── open better-sqlite3 at paths.dbPath()
  │     └── pragma journal_mode=WAL; pragma foreign_keys=ON  ← D4.3B: mirrors
  │         (comment: must stay in sync with src/db/index.ts:17-18)
  ├── migrate(db, { migrationsFolder: "/app/drizzle" })
  │     ├── success → close, continue
  │     └── throw   → log the failing migration, exit(1)   ← never boot on a bad schema
  └── import("./server.js")                                 ← Next standalone server
```

The pragma duplication is deliberate and commented: the entrypoint stays a standalone
script with no import of app internals, at the cost of two lines that must track
`src/db/index.ts`. `foreign_keys` is per-connection, and Drizzle's SQLite table-rebuild
migrations behave differently depending on it — running migrations under different FK
semantics than the app is the failure being avoided.

Exiting non-zero on migration failure is the point: a container that boots with a
half-applied schema writes wrong rows to a real ledger.

`pnpm db:generate` / `db:studio` stay host-side developer commands. Only `migrate`
needs to exist inside the image.

### 2. The container runs UTC — and that silently moves your budget month

`Dockerfile` inherits `TZ=UTC`. Eight server-side sites derive "now" in **local**
time — six of them here:

```
src/app/page.tsx:13                    const now = new Date()
src/app/budget/page.tsx:16             redirect(`/budget/${now.getFullYear()}/${now.getMonth()+1}`)
src/app/categorize/page.tsx:21         const now = new Date()
src/app/transactions/page.tsx:67       const now = new Date()
src/app/subscriptions/page.tsx:91      new Date().toISOString().slice(0,10)
src/app/import/page.tsx:7              new Date().toISOString().slice(0,10)
src/components/ledger/spine-month.tsx:35  const now = new Date()
```

Plus two more server-side sites that earlier passes missed:

```
src/lib/trends/loadMonthlyTrends.ts:47   const now = new Date()        ← outside voice #4
src/app/sync/page.tsx:37                 new Date(Date.now() - days*86_400_000)
                                           .toISOString().slice(0,10)  ← adversarial pass
```

`loadMonthlyTrends.ts:47` derives its own 6-month window. `sync/page.tsx:37` is
`daysAgoIso()`, whose output is the cutoff fed to `findAmbiguousTransfers` and
`findLinkedTransferPairs` (`page.tsx:43-44`) and compared with an **inclusive** `gte`
(`src/lib/simplefin/sync.ts:669,716`). Under UTC the window boundary lands a day early
for most of the evening Pacific, so a transfer pair sitting exactly on the edge drops out
of the review list — and an unreviewed ambiguous pair is one that stays unlinked and keeps
inflating spending. It survived three passes because it does not look like a date
default; it looks like arithmetic.

`spine-month.tsx:1` is `"use client"` — its `new Date()` runs in the **browser**, in your
real timezone, and is already correct. It must NOT be routed through a server helper.

**Separately: `/import` renders at build time.** Every other route opts into per-request
rendering — `page.tsx`, `budget`, `categorize`, `transactions`, `subscriptions` all call
`await connection()`, and `/sync` sets `export const dynamic`. `src/app/import/page.tsx`
has **neither**, so its `new Date().toISOString().slice(0,10)` (line 7) freezes at build
time. In a container that means the image build date, which could be weeks stale. This is
a pre-existing bug that containerization makes materially worse, and it is the exact class
`src/app/budget/page.tsx`'s comment already warns about. PR1 adds `await connection()`.

That asymmetry is the tell. On 30 September at 6pm Pacific, `getMonth()` in a UTC
container returns **October** on the server while the client spine picker still says
**September** — two different months on screen simultaneously. `/budget` redirects to
next month's envelopes; the dashboard summarizes the wrong month; `/import` defaults
the starting-balance date to tomorrow. No error, no crash.

Fix, three parts:

- `TZ=America/Los_Angeles` set in `compose.yaml` (env, not baked into the image, so
  the NAS can override it).
- **`entrypoint.mjs` refuses to boot when `TZ` is unset** (D4.2B), logging
  "TZ is required — the app derives the current budget month from local time."
  A hand-written compose file on the NAS that omits the line fails loudly in five
  seconds instead of computing a wrong month for a few hours each month. Someone who
  genuinely wants UTC writes `TZ=UTC`, which is the right forcing function.
- `src/lib/now.ts` exporting `currentMonth()` / `todayIso()` / `daysAgoIso()`, with all
  **8 server sites** routed through it (6 pages + `loadMonthlyTrends.ts:47` +
  `sync/page.tsx:37`). One place to test, one place to fix. This is the reuse-ladder
  answer: the repetition already exists, containerization just makes it dangerous.
  `spine-month.tsx` stays on its own client-side `new Date()`.

`src/lib/snapshot.ts:formatTimestamp` already uses `getUTC*` throughout and is
correct as-is — snapshot filenames should be UTC.

### 3. Named volume vs bind mount — the one real tradeoff in PR1

```
  bind mount  ./data:/app/data          named volume  mm_data:/app/data
  ─────────────────────────────         ──────────────────────────────
  ✅ money.db visible on the host       ✅ ext4 inside the VM, no FUSE
  ✅ rule 5 "swap the file" works       ✅ SQLite WAL locking is sound
     exactly as documented              ❌ money.db invisible from the host
  ❌ SQLite WAL over VirtioFS/gRPC-     ❌ rule 5 rollback needs
     FUSE is a known corruption            `docker compose cp` gymnastics
     hazard class on macOS
```

**Plan takes the named volume.** Reasoning: the thing being protected is a ledger you
cannot reconstruct, and "convenient but may corrupt" is the wrong side of that trade.
PR2 dissolves this tradeoff entirely — Postgres owning its own data directory is the
normal case.

### 3a. `db:export` must not be a bare `docker compose cp` (D3.2B)

Copying a live WAL-mode SQLite file out of a running container is the exact failure
`src/lib/snapshot.ts:62-86` documents: with a reader holding an open read transaction,
the copy "failed to open at all with SQLITE_CORRUPT, database disk image is malformed."
A naive `cp` wrapper hands back a rollback file that does not open, discovered at the
moment it is needed.

```
  pnpm db:export
    ├── docker compose exec app node /app/scripts/snapshot-cli.mjs  ← VACUUM INTO
    │     └── prints { snapshotPath, consistent, degradedReason } as JSON
    ├── if consistent === false → print degradedReason, exit 1      ← never silent
    └── docker compose cp app:<snapshotPath> ./backups/             ← copy the copy
```

`pnpm db:import` is the reverse and stops the container first. With the container down
nothing holds a read transaction, but "stopped" is not the same as "checkpointed": if
the app was killed rather than shut down cleanly, `money.db-wal` still holds committed
rows. So `db:import` copies the **snapshot file** back (a `VACUUM INTO` product, always
self-contained, no sidecars) and refuses to import a bare `money.db` that has a `-wal`
next to it. Restoring an older main file beside a newer WAL is the one move that can
corrupt a ledger that was otherwise fine.

**One caller does not honor `consistent` today, and PR1 fixes it.** The rule in
CLAUDE.md is that a degraded snapshot is never silently ignored, but only
`src/lib/simplefin/sync.ts:345` actually checks:

```
  src/lib/simplefin/sync.ts:345   if (!snapshot.consistent) { … }      ← checks
  src/lib/importBatch.ts:145      const snapshot = createSnapshot(DB_PATH);
                                  ↓ straight into db.transaction(…)    ← never checks
```

So every CSV import records `snapshot_path` and proceeds believing it has a rollback,
including when `createSnapshot` fell back to a plain copy and produced a file that may
not open. That is a live bug on `main`, not a containerization one — but PR1 is where
the export/import path starts depending on the flag being trustworthy, so PR1 fixes it
(T6a). Any statement that "the existing callers honor the flag" was wrong; it is one of
two.

### 3b. Snapshots move to a separate host-bind mount (D3.3B)

Snapshots must not die with the volume they protect. `docker compose down -v` or a
routine `docker system prune --volumes` would otherwise take the ledger and all ten
rollback copies in one command.

```
  volume  mm_data:/app/data        ← money.db + WAL. Named volume, ext4, no FUSE.
  bind    ./backups:/app/backups   ← snapshots. Visible on the host, survives -v.
```

`src/lib/snapshot.ts:57` currently derives the snapshot directory from the database
path (`const dataDir = path.dirname(dbPath)`), and both callers repeat that derivation
(`importBatch.ts:190`, `sync.ts:400`). Splitting the two locations therefore needs a
`SNAPSHOT_DIR` resolution shared by all three — see the path-constant consolidation in
PR1-e below, which lands first.

Snapshots are `VACUUM INTO` output: written once, never reopened by a live connection,
so the WAL-over-FUSE hazard that rules out a bind mount for `money.db` does not apply
to them.

### 4. `.env.local` must be optional (outside voice #3)

A bare `env_file: .env.local` in Compose hard-fails when the file is absent. But this app
deliberately runs without `SIMPLEFIN_ACCESS_URL`: `src/lib/simplefin/accessUrl.ts` takes
`env` as a parameter and `/sync` renders a configuration banner rather than throwing. CSV
import is a complete, supported workflow on its own. Making the credential mandatory to
boot would break a fresh clone and every CSV-only user for no reason.

```yaml
env_file:
  - path: .env.local
    required: false      # SimpleFIN is optional; /sync degrades with a banner
```

## Health endpoint

`src/app/api/health/route.ts` — `export const dynamic = "force-dynamic"`, runs
`SELECT 1` against the DB, returns `{ ok: true }` / 503. Compose healthcheck hits it.
`/` is not usable as a probe: it runs the full dashboard query set including the
6-month trend aggregation.

## PR1 does NOT change

Any query. The schema. The migrations. The dialect. No existing test changes its
assertions — PR1 only adds tests (V1-V13). Two modules do change, both narrowly:
`src/db/index.ts` and `src/lib/importBatch.ts`/`sync.ts` swap their hard-coded path
constants for `src/lib/paths.ts` (T2), and `src/lib/snapshot.ts` gains a `SNAPSHOT_DIR`
override (T6) plus the `consistent` check its CSV caller was missing (T6a). No query
layer, no async, no driver. `pnpm dev` on the host keeps working exactly as it does today — the container
is an additional way to run the app, not a replacement.

---

# PR2 — SQLite → Postgres

Goal: same app, `postgres:17-alpine` service in compose, ledger data moved across
with proof that nothing changed.

## Phase order (each phase compiles and passes tests before the next starts)

```
 P2.1  Schema port          src/db/schema.ts → pgTable        no behavior change
 P2.2  Driver + async       src/db/index.ts + 292 call sites  mechanical, type-checked
 P2.3  Migrations           regenerate all 9 for pg dialect   drizzle-kit generate
 P2.4  Test harness         :memory: → PGlite                 17 test files
 P2.5  Snapshot redesign    VACUUM INTO → pg_dump -Fc         rule 5 rewritten
 P2.6  Cutover script       sqlite → pg + reconciliation      one-way, verified
 P2.7  Docs                 CLAUDE.md, README, PLAN, compose  rules 1-6 restated
```

## P2.1 — Schema port

| SQLite today | Postgres | Note |
|---|---|---|
| `integer().primaryKey({autoIncrement:true})` | `integer().generatedAlwaysAsIdentity()` | modern form; `serial` is legacy |
| `integer({mode:"boolean"})` | `boolean()` | real type; Drizzle keeps the TS surface identical |
| `integer({mode:"timestamp"})` | **`timestamp({withTimezone:true})`** | See below — "keep integer" is not available |
| `text("date")` ISO `YYYY-MM-DD` | **keep `text`** | every comparison is a string compare (`date < firstDayNext`); switching to `date` changes semantics in ~12 queries for no gain |
| `sql\`(unixepoch())\`` × 6 | `defaultNow()` | **not** `extract(epoch from now())::int` — that is an integer expression, and the column above it is now `timestamptz`. Postgres would reject it. |
| `uniqueIndex().where(…)` × 2 | identical | partial unique indexes port 1:1 |
| `strftime('%Y'/'%m', date)` | `left(date, 4)` / `substring(date, 6, 2)` | `loadMonthlyTrends.ts:95-96` only. Plain string ops on fixed-format ISO text — no per-row `::date` cast, and no throw on a malformed value the way a cast would. |

Keeping `date` as text is deliberate: it holds the diff to "dialect change" instead of
"dialect change plus data model change," so a wrong balance after cutover has one
candidate cause, not two.

### Timestamps cannot stay integers (D7.2A — outside voice #5)

The first draft of this plan said "keep `integer`, CLAUDE.md convention is Unix seconds."
That option does not exist. Verified against the installed Drizzle:

```
grep mode node_modules/drizzle-orm/pg-core/columns/integer.d.ts       → (no matches)
grep mode node_modules/drizzle-orm/sqlite-core/columns/integer.d.ts   → mode: 'timestamp' | 'timestamp_ms'
```

SQLite's `integer({ mode: "timestamp" })` stores an int and hands TypeScript a `Date`.
Postgres's `integer()` is `number`, full stop. Porting it literally silently retypes
`createdAt`/`updatedAt` and breaks every `.set({ updatedAt: new Date() })` — at least
8 sites including `budget/upsertAllocation.ts:59`, `goals/actions.ts:44`,
`simplefin/link.ts:92`, `rules.ts:82`, and four in `categorize/`.

`timestamp({ withTimezone: true })` maps to `Date` in Drizzle, so **every one of those
call sites compiles unchanged**. The storage format changes; the TypeScript surface does
not.

This retires CLAUDE.md's "timestamps as Unix seconds" convention, and that is the honest
outcome: it was a SQLite constraint dressed as a design choice. Postgres has a real
timestamp type. The cutover script converts epoch integers on the way across, which is
one more transform in a script that is already doing transforms and is verified by the
row-level hash (P2.6).

Note `date` columns are unaffected — those are ISO text and stay text.

## P2.2 — The async conversion, and how it fails

This is where a bug becomes a wrong number rather than a crash. Three failure shapes:

```
  MISSED AWAIT                     WHAT HAPPENS
  ────────────────────────────────────────────────────────────────
  rows.map(...)          on Promise  → TypeError            LOUD  ✅
  if (row) { ... }       on Promise  → always truthy        SILENT ❌
  effective - spentCents on Promise  → NaN → "$NaN"         VISIBLE, wrong ⚠️
```

The middle one is the dangerous case: `getEffectiveAllocation` returning a Promise
makes `allocation?.effectiveCents ?? 0` evaluate to `0`, and every envelope silently
reads as unallocated.

Mitigations, all three required:

1. `tsc --noEmit` clean — Drizzle's pg types return `Promise<T[]>`, so nearly every
   missed await is a compile error before it is a runtime one.
2. Enable `@typescript-eslint/no-floating-promises` and `no-misused-promises` in
   `eslint.config.mjs`, and add them to the CI gate.
3. The existing 402 tests run against PGlite after P2.4 and must stay green. They are
   the actual proof; the linters just find the mistakes faster.

The 13 `db.transaction((tx) => …)` sites become `await db.transaction(async (tx) => …)`.
Drizzle's pg transaction API is otherwise shape-compatible.

`src/lib/budget.ts:12` types `Db` as `BaseSQLiteDatabase<"sync", …>`, and that alias is
threaded through every module taking a `Db` parameter. The literal `"sync"` marker means
the conversion cannot be done halfway without TypeScript objecting — which is the
mitigation working in our favor.

### The connection singleton must be rewritten, not ported (D6.2A)

```
src/db/index.ts:22   if (cached && cached.open && globalForDb.__mm_drizzle) {
```

`.open` is a `better-sqlite3` `Database` property. A `pg.Pool` has none, so ported
literally this guard is permanently falsy and the Proxy on line 37 constructs a **new
Pool on every property access** — Postgres defaults to `max_connections = 100` and
would be exhausted within seconds.

Rewrite: cache the `Pool` on `globalThis` as today, gate on `!pool.ended`, and add a
test asserting repeated `db` access returns the same pool instance. That test is the
pg-era version of CLAUDE.md's "10 HMR reloads, DB still connects" smoke test.

Deliberately NOT included: pool sizing and a SIGTERM drain path. Both are right for the
NAS, and both belong with PR3 when the deployment target is decided.

## P2.3 — Migrations

All 9 regenerate from scratch against the pg dialect; the sqlite journal cannot be
converted. `drizzle/` is replaced wholesale, not appended to.

Prior learning applies (`drizzle-multi-stmt-migration`, 5/10, 2026-04-21): hand-edited
migrations need `--> statement-breakpoint` between statements or the migrator throws
`RangeError: … more than one statement`. Migrations `0002`, `0005`, `0006` are
hand-written (seed data, triggers) and will need re-authoring, not just re-generating.
The `BEFORE DELETE` trigger on the Uncategorized category is SQLite trigger syntax and
becomes a Postgres trigger function + trigger.

## P2.4 — Test harness

`src/lib/test/db.ts` builds `new Database(":memory:")` per test. Postgres has no
in-memory mode. Three options were weighed:

| Option | `pnpm test` offline | Speed | Fidelity |
|---|---|---|---|
| **PGlite** (`@electric-sql/pglite` + `drizzle-orm/pglite`) | yes | ~in-memory | real Postgres compiled to WASM |
| Testcontainers | no — needs Docker running | slow start | perfect |
| Shared PG, schema-per-test | no | medium | perfect |

**Plan takes PGlite locally + real `postgres:17` in CI** (D5.1A). Measured baseline to
protect: `pnpm test` is **38 files, 402 tests, 2.04s, offline**. PGlite is the only
option that keeps that. `createTestDb()` picks its driver from an env var CI sets and
keeps its exact signature, so the 17 test files change by import only.

Risk accepted and mitigated: PGlite is Postgres compiled to WASM, single-connection,
so it cannot exercise concurrent writers and could in principle diverge from the real
server. The CI job against `postgres:17` is what makes trusting it safe — a PGlite-only
bug fails in CI rather than on the NAS.

### Measure the `/budget` query fan-out before rewriting it (D6.1B)

`src/lib/budget/loadMonthView.ts:103-104` calls `getEffectiveAllocation` and
`computeMtdSpent` **per leaf category**, and `getEffectiveAllocation` recurses into
prior months (`budget.ts:92`) doing three more queries per level. Shape:

```
  /budget render  ≈  2N + 3ND queries      N = leaf categories, D = rollover depth

  SQLite today          in-process calls, microseconds        → free, nobody noticed
  Postgres              one socket round trip each            → ~220 queries at N=20, D=6
```

The cold path is the common path: `invalidateForwardRollover` clears
`effective_allocation_cents` on every categorize and every allocation edit, so the
fan-out runs on exactly the reload that follows an edit.

**Do not pre-emptively rewrite this.** `getEffectiveAllocation`'s rollover math is the
most subtly-tested logic in the repo (`budget.test.ts` covers both persist modes and
all three invalidation triggers), and restructuring it during a dialect migration means
a wrong envelope number would have two candidate causes.

Instead: add a dev-only query counter to `src/db/index.ts` and record count + wall time
for `/budget`, cold and warm, on real data immediately after cutover. Under ~150ms cold,
do nothing. Over it, a set-based rewrite (one join for allocations, one grouped
aggregate for spend) becomes a scoped follow-up with a measurement attached rather than
a guess.

## P2.5 — Snapshot redesign (CLAUDE.md rule 5)

`VACUUM INTO` has no Postgres analogue. The contract has to be rebuilt, not ported:

```
  TODAY (SQLite)                      PR2 (Postgres)
  ──────────────────────────────────────────────────────────────────────
  createSnapshot(dbPath)              createSnapshot(connInfo)
    VACUUM INTO 'money.db.pre-…'        pg_dump -Fc -f /snapshots/pre-…dump
    consistent: true|false              consistent from pg_dump exit code
  pruneSnapshots(dir, 10)             pruneSnapshots(dir, 10)     ← unchanged
  rollback: stop server, swap file    rollback: pg_restore --clean --if-exists
  logical undo: delete batch rows     logical undo: unchanged
```

Three properties must survive, and each gets a test:

- Snapshot is taken **before** any write, and a failed snapshot aborts the import.
- `pruneSnapshots` still runs **after** the write commits, never inside
  `createSnapshot` (the reason is in the existing JSDoc and still applies).
- The `consistent: false` flag still propagates to the caller rather than being
  swallowed.

`pg_dump`/`pg_restore` binaries must be present in the runner image (`postgresql-client`),
and their major version must match the server. Pin both to 17.

The logical undo (`undoSyncAction`) is dialect-independent and carries over unchanged.

## P2.6 — Cutover, and the part that must not be skipped

Two corrections from the outside voice reshaped this section. Both were right.

### Everything runs in one uncommitted transaction (D7.3B — outside voice #6)

Two tables reference themselves:

```
src/db/schema.ts:46      parentId       → categories.id      (AnySQLiteColumn)
src/db/schema.ts:127-130 transferPairId → transactions.id    (AnySQLiteColumn)
```

A single-pass, table-ordered insert cannot satisfy those — half the rows point at rows
that do not exist yet. And the original plan's promise of "exit 1, CHANGE NOTHING" was
fiction: without one transaction, a reconciliation failure leaves a half-loaded database
behind.

```
  BEGIN;
  SET CONSTRAINTS ALL DEFERRED;          ← self-refs resolve at COMMIT, order stops mattering
    ├── insert 7 tables (epoch ints → timestamptz on the way)
    ├── reset identity sequences to MAX(id)          ← failure mode F8
    └── RECONCILE (below)
          ├── PASS → COMMIT               ← the only path that writes anything
          └── FAIL → ROLLBACK; print diff; exit 1
```

FKs must be `DEFERRABLE INITIALLY IMMEDIATE` for `SET CONSTRAINTS ALL DEFERRED` to do
anything — a non-deferrable constraint ignores it and still fires per statement. **This
is not expressible in Drizzle.** Verified: `node_modules/drizzle-orm/pg-core/foreign-keys.d.ts`
gives `ForeignKeyBuilder` only `onUpdate` and `onDelete`; there is no deferrable option,
so `drizzle-kit generate` will emit plain FKs and the transaction above will fail on the
first self-referencing row.

Two ways to close it, and P2.3 takes the first:

- **A hand-written follow-up migration** that runs `ALTER TABLE … ALTER CONSTRAINT …
  DEFERRABLE INITIALLY IMMEDIATE` for the two self-referential FKs
  (`categories.parent_id`, `transactions.transfer_pair_id`). It is committed alongside
  the generated ones, and a test asserts both constraints report `condeferrable` in
  `pg_constraint` — otherwise a later `drizzle-kit generate` silently reverts it and the
  cutover breaks months from now.
- Two-pass insert with self-refs NULL, then `UPDATE`. Rejected at D7.3A: it leaves a
  window where transfer pairs do not exist, and a crash there yields plausible-looking
  but wrong data.

The whole ledger is held in one transaction; fine at this size, not a pattern to
generalize.

### Reconciliation compares rows, not just totals (D7.4B — outside voice #7)

The original check compared row counts and `SUM(amount_cents)` per account. Those are
**invariant under category reassignment**: scramble every `category_id` and every listed
figure still matches. It would have reported PASS while every budget envelope was wrong.
This was the weakest thing in the plan and it was the part billed as proof.

The first correction replaced the aggregates with a hash over a hand-picked list of
"columns that drive behavior." **That list was itself wrong**, in both directions: it
named `import_batches.row_count`, a column that does not exist (the real one is
`transaction_count`, `src/db/schema.ts:92`), and it omitted `raw_description`,
`raw_memo`, `normalized_merchant` and `bank_transaction_number` from `transactions` —
the columns that drive transfer pairing (`src/lib/transferPair.ts`), cross-source dedup,
`/categorize` grouping, and subscription detection. `normalized_merchant` is what every
trained `category_rule` matches on, so a cutover could scramble it, keep every count and
balance identical, and be certified PASS.

**So the list goes away.** A curated column list is the failure mode here — it was wrong
twice, and a third hand-written list is not more likely to be right. Hash **every
column** in every table, with the set derived from the Drizzle schema at runtime, not
transcribed:

```
  for each table in schema (7):
    columns := Object.keys(getTableColumns(table)).sort()     ← from Drizzle, never typed by hand
    rows    := SELECT <columns> FROM <table> ORDER BY id
    hash    := sha256 over the canonicalized rows

  one hash per table, computed identically on both sides → compare 7 pairs
  any single cell differing anywhere → hashes differ → FAIL
```

Hashing every column makes canonicalization load-bearing, because two of the conversions
this migration performs change a value's representation without changing its meaning.
The canonical form is fixed on both sides before hashing:

```
  timestamps   → epoch seconds as a decimal integer   ← P2.1 stores timestamptz; SQLite
                                                        stores ints. Compare the instant,
                                                        not the rendering.
  booleans     → "0" / "1"                            ← SQLite int, Postgres bool
  NULL         → a sentinel that no value can produce (e.g. "\x00NULL")
  everything else → its exact text, no trimming, no case folding
  join         → column values with "\x1f", rows with "\x1e"   ← so "a|b" ≠ "a" , "b"
```

The NULL sentinel and the unit separators matter more than they look: without them a
NULL `category_id` and an empty-string one collide, and shifting a value from one column
into the next produces the same concatenation. Both are ways a hash "passes" while the
data moved.

Kept alongside as a human-readable sanity layer, because a hash mismatch says *that*
something differs and not *what*: row count per table, and computed balance per account
(`starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)`,
CLAUDE.md rule 1) on both sides. On failure the script prints which table's hash diverged
and the aggregate deltas, which is enough to find it with two queries by hand.

The reconciliation is not a `--verify` flag. It runs every time, inside the transaction,
and the script cannot report success without it.

**The source must be frozen, and "read-only" does not freeze it.** The SQLite file is
never modified or deleted by the script, but opening it read-only says nothing about
*other* writers: the ledger runs in WAL mode and both `src/lib/importBatch.ts` and
`src/lib/simplefin/sync.ts` write to it. If the app is up during cutover — a `/sync`
that fires, a CSV import in another tab — the script reads a moving target and certifies
a subset of the ledger that was never a consistent whole. It would report PASS.

So the cutover does not read `data/money.db` at all. It reads a `VACUUM INTO` snapshot
taken as its first act, and refuses to run if it cannot take one:

```
  migrate-to-pg.mjs
    ├── createSnapshot(dbPath)  → cutover-source.db      ← a frozen instant
    │     └── consistent === false → exit 1, nothing written
    ├── BEGIN; load 7 tables FROM cutover-source.db; reconcile; COMMIT/ROLLBACK
    └── the snapshot is kept — it is the artifact the reconciliation certified
```

That also makes the reconciliation's claim precise: it proves Postgres matches *the
snapshot*, and the snapshot is a real point in time. Comparing against a live file could
never have proven anything.

Renaming `money.db` to `money.db.pre-pg-migration` is a manual step you take once you are
satisfied — and it is the step that actually stops dual writes, so it is not optional
before the app is pointed at Postgres.

## P2.7 — Docs

`readme-plan-drift-my-money-manager` (8/10) says README and PLAN.md are this repo's
reliably-stale pair. PR2 changes documented behavior in both, plus CLAUDE.md rules 3
and 5 and README's "Core data rules" 3 and 5. All four files are in the PR2 diff, not
a follow-up.

---

## Test requirements

**Naming:** tests are `V<n>` (verification), implementation tasks are `T<n>`. They were
both `T<n>` until the adversarial re-review pointed out that `T5` meant two different
things depending on which table you were reading.

Baseline to hold: **38 files / 402 tests / 2.04s / offline**. Every item below is part
of the PR that introduces the code, not a follow-up.

### PR1

| # | Test | File | Asserts |
|---|---|---|---|
| **V1** | **REGRESSION (mandatory)** — retention still prunes when `SNAPSHOT_DIR` ≠ `DATA_DIR` | `src/lib/snapshot.test.ts` | After 12 imports, exactly 10 snapshots remain **in `SNAPSHOT_DIR`**. Guards the silent failure where `pruneSnapshots(path.dirname(DB_PATH))` (`importBatch.ts:190`, `sync.ts:400`) is left deriving from the DB path, prunes an empty directory, reports success, and retention stops forever. |
| V2 | `paths.ts` env override vs default | `src/lib/paths.test.ts` | `DATA_DIR`/`SNAPSHOT_DIR` set and unset; defaults byte-identical to today's `path.join(process.cwd(), "data", …)` so host `pnpm dev` is unchanged |
| V3 | `now.ts` under both timezones | `src/lib/now.test.ts` | Fake timers at 2026-09-30T18:00 PT: `currentMonth()` returns `{2026, 9}` under `TZ=America/Los_Angeles` and `{2026, 10}` under `TZ=UTC`. Dec→Jan rollover. DST boundary. **`daysAgoIso(30)` at that instant returns `2026-08-31` under PT and `2026-09-01` under UTC** — i.e. the correct *local* date in each zone, which is precisely what today's `toISOString()` implementation cannot do. Asserting the two zones agree would be asserting the bug (F24). |
| V4 | `entrypoint.mjs` guards | `docker/entrypoint.test.mjs` | `TZ` unset → exit 1; **`process.cwd()` ≠ `/app` → exit 1** (F19); migrate throws → exit 1 and server never imported; pragmas set before migrate |
| V5 | `/api/health` | `src/app/api/health/route.test.ts` | 200 `{ok:true}`; DB throws → 503 |
| V6 | `db-export` refuses a degraded copy | `scripts/db-export.test.mjs` | `consistent:false` → exit 1, no file emitted. The silent-corruption guard. |
| V12 | Volume seed refuses a non-empty target | `scripts/seed-volume.test.mjs` | Empty volume → seed + row counts **and** per-account balances match source. Non-empty volume → exit 1, target untouched, source never modified. `consistent:false` → exit 1. **Rows committed only to `-wal` at seed time survive** — the WAL-loss regression (F17). Existing snapshot files copied into `./backups/`; **`import_batches.snapshot_path` rows unchanged** — they are absolute host paths, display-only, and rewriting history to a container path that was never true is worse than leaving it. |
| V6b | `importBatch` aborts on a degraded snapshot | `src/lib/importBatch.test.ts` | `createSnapshot` returns `consistent:false` → import throws before any row is inserted and no `import_batches` row is created. Mirrors the check `sync.ts:345` already makes. |
| V13 | `/import` is not build-frozen | `src/app/import/page.test.ts` | `await connection()` present; the date field reflects request time, not build time |

### PR2

| # | Test | File | Asserts |
|---|---|---|---|
| V7 | Harness port | `src/lib/test/db.test.ts` | Existing assertions pass against PGlite; driver switch honors the CI env var |
| V8 | **Snapshot restore round-trip** (D5.3B, replaces `snapshot.test.ts:87-142`) | `src/lib/snapshot.test.ts` | Write rows → `createSnapshot()` → drop data → `pg_restore` → rows are back. This is the property the deleted WAL tests were really protecting, and it is dialect-independent. CI-only (needs real Postgres). |
| V9 | Cutover round-trip (D5.2B) | `scripts/migrate-to-pg.test.mjs` | Seed SQLite from `src/lib/__fixtures__/` → migrate → reconciliation PASS, every account balance identical |
| V10 | Cutover negative (D5.2B) | `scripts/migrate-to-pg.test.mjs` | Delete one row post-insert → reconciliation exits 1 with a readable diff. Proves the safety net is not decoration. |
| V11 | Identity sequences reset | `scripts/migrate-to-pg.test.mjs` | First insert after cutover does not collide on PK (failure mode F8) |
| **V14** | **Aggregate-blind mutation is caught** | `scripts/migrate-to-pg.test.mjs` | Swap two rows' `category_id` post-insert. Row counts, per-account sums and balances all still match — the row-level hash must still FAIL. This is the test that proves D7.4B was necessary; without it the reconciliation is decoration. |
| V15 | Self-referential FKs survive | `scripts/migrate-to-pg.test.mjs` | Every `transfer_pair_id` and `categories.parent_id` present in SQLite is present and identical in Postgres. Guards the silent-null failure that would un-hide 56 transfer rows and inflate spending. |
| V16 | Rollback is real | `scripts/migrate-to-pg.test.mjs` | Force a reconciliation failure → Postgres is empty afterwards, SQLite byte-identical to before |
| V17 | Timestamp conversion | `scripts/migrate-to-pg.test.mjs` | Epoch integers land as the same instant in `timestamptz`; round-trips through Drizzle as an equal `Date` |
| V18 | **Hash covers every column** | `scripts/migrate-to-pg.test.mjs` | For each of the 7 tables, mutate **one cell of every column in turn** and assert the reconciliation FAILs each time. This is the test that would have caught the omitted `normalized_merchant` and the nonexistent `row_count`; a hand-listed column set cannot pass it. |
| V19 | Canonicalization is not lossy | `scripts/migrate-to-pg.test.mjs` | NULL vs empty string in the same column produce different hashes; a value shifted from one column into the next produces a different hash (separator test). |
| V20 | FKs are actually deferrable | `scripts/migrate-to-pg.test.mjs` | `pg_constraint.condeferrable` is true for `categories.parent_id` and `transactions.transfer_pair_id` after migrations run. Fails if a later `drizzle-kit generate` reverts the hand-written ALTER. |
| V21 | Cutover reads a frozen source | `scripts/migrate-to-pg.test.mjs` | Write to the SQLite file *after* the script takes its snapshot; reconciliation still PASSes and the post-snapshot row is absent from Postgres — proving the script certified an instant, not a moving target. |

The 402 existing tests are the real proof of the async conversion; V7 is what makes
them able to run at all.

**Known coverage hole, accepted:** `src/lib/simplefin/sync.test.ts:23,54` mocks
`createSnapshot`, so sync tests will not catch a broken `pg_dump`. V8 is the only thing
covering that path — which is why it is CI-blocking rather than optional.

## What already exists

| Sub-problem | Existing code | Plan's treatment |
|---|---|---|
| Migrations on startup | `conductor.json` `run` script already does `pnpm db:migrate && pnpm dev` | Same sequencing, moved into `entrypoint.mjs` because drizzle-kit is not in the image |
| Pre-write snapshot + retention | `src/lib/snapshot.ts` — `createSnapshot`, `pruneSnapshots`, `consistent` flag, 10-file retention | PR2 keeps the module's shape and its three hard-won invariants; only the mechanism changes |
| Logical undo | `src/lib/simplefin/undoSync.ts` | Dialect-independent, carried over untouched |
| Test DB factory | `src/lib/test/db.ts` — `createTestDb()` | Signature preserved; 17 call sites change by import only |
| Per-request `now` | `src/app/budget/page.tsx` already has the `await connection()` fix and a comment explaining it | `src/lib/now.ts` generalizes it; the existing comment stays accurate |
| CI gate | `.github/workflows/ci.yml` — lint, test, db:migrate, build | Extended, not replaced: `docker` build job in PR1, `postgres` service in PR2 |
| Node/pnpm pinning | `.nvmrc` (24), `engines`, `engine-strict=true` | Image inherits the same pins via `node:24-bookworm-slim` + `packageManager` |

Nothing here is rebuilt in parallel.

## NOT in scope

| Deferred | Why |
|---|---|
| **Auth** | CLAUDE.md lists it under "do not add." Correct for a LAN/Tailscale-reachable app; see PR3. |
| **Phone/NAS network access (PR3)** | The actual destination, but it is a network+security change, not a container change. Doing it in the same PR as a database migration means a security decision reviewed as an afterthought. |
| **Publishing images to a registry** | Distribution check from Step 0. PR1 builds locally; multi-arch (`linux/amd64` for most NAS hardware, `linux/arm64` for Apple silicon and Pi) plus GHCR publish belongs with PR3, when there is somewhere to deploy to. |
| **Automated backups / retention off-box** | 10 rolling snapshots inside one volume is not a backup once the app lives on a NAS. PR3. |
| **`date` as a real `date` column** | Real improvement, wrong PR. Every comparison is currently a string compare; changing it touches ~12 queries for no gain during a migration. (Timestamps are no longer deferrable — see D7.2A; Drizzle pg offers no integer-timestamp mode, so that one is forced.) |
| **Pool sizing + SIGTERM drain** | Right for the NAS, belongs with PR3 when restart behavior is decided. Next's standalone server already handles SIGTERM reasonably. |
| **`/budget` set-based query rewrite** | Deliberately gated on measurement (D6.1B). Restructuring the most subtly-tested logic in the repo during a dialect migration would give a wrong envelope two candidate causes. |
| **Branded `Cents` type** (TODOS P4) | PR2 touches all 292 call sites, so it is tempting. It is also a second reason for every line to change. Separate pass. |
| **Shared batch-writer refactor** (TODOS P4) | Same reasoning. |
| **SimpleFIN relink `external_id` orphaning** (TODOS P2, open) | Pre-existing bug, unrelated to transport. Fixing it mid-migration muddies the reconciliation. |
| **Dev containers / devcontainer.json** | `pnpm dev` on the host stays the primary loop. |

## Failure modes

| # | Codepath | Realistic failure | Test? | Handled? | User sees |
|---|---|---|---|---|---|
| F1 | `entrypoint.mjs` migrate | Migration fails, container boots on half-applied schema | planned | `exit(1)` | Container restart loop — loud ✅ |
| F2 | `src/lib/now.ts` | TZ unset in compose → UTC → wrong month after 5pm PT on the 30th | **V3, V4** | entrypoint refuses to boot without `TZ` (D4.2B) | Container exits 1 — loud ✅ |
| F3 | Named volume | Volume pruned by `docker system prune --volumes` | planned | snapshots on a separate host bind (D3.3B) | Ledger lost, snapshots survive ⚠️ |
| F10 | `compose.yaml` ports | Container published on `0.0.0.0`, no auth, LAN-readable | n/a | `127.0.0.1:3000:3000` (D3.1A) | n/a — closed ✅ |
| F11 | `pnpm db:export` | Bare `cp` of a live WAL DB → unopenable rollback file | planned | `VACUUM INTO` first (D3.2B) | `consistent:false` → exit 1 ✅ |
| F4 | `better-sqlite3` in runner | `.node` binary missing from standalone trace | build-time | fails at boot | Container won't start — loud ✅ |
| F5 | P2.2 missed `await` | `if (promise)` truthy → allocation reads 0 | 402 tests + tsc + lint | compile error, mostly | Silent wrong envelope ❌ |
| F6 | `createSnapshot` pg | `pg_dump` version mismatch with server | V8 | `consistent:false` → **abort the write** (P2.5), both callers | Import refuses to run — loud ✅ |
| F7 | `migrate-to-pg.mjs` | Partial insert then crash → half-migrated PG | reconciliation | exit 1, sqlite untouched | Explicit PASS/FAIL ✅ |
| F8 | Identity sequences | Not reset after cutover → first insert collides on PK | planned | n/a | Insert error — loud ✅ |
| F9 | `/api/health` | Probe passes while DB is read-only/full | planned | `SELECT 1` only | Healthy but broken ⚠️ |
| F12 | Volume seed | Volume starts empty, no seed → app serves a blank ledger | V12 | seed step + refuse non-empty | Empty dashboard — visible ✅ |
| F13 | `/import` build-freeze | Date field frozen to image build date | V13 | `await connection()` | Wrong default date ⚠️ → closed |
| F14 | pg timestamps | `integer()` retypes `Date`→`number`, 8+ write sites break | tsc + 402 tests | `timestamp({withTimezone})` | Compile error — loud ✅ |
| F15 | Cutover self-refs | `transfer_pair_id` silently nulled → 56 transfers un-hidden, spending inflated | V15 | deferred constraints | Row-hash FAIL ✅ |
| F16 | **Reconciliation blindness** | Scrambled `category_id` preserves every count and balance | **V14** | row-level hash (D7.4B) | Row-hash FAIL ✅ |
| F17 | **Volume seed WAL loss** | Bare `cp` of `money.db` drops rows still in `money.db-wal`, or pairs an old main with a newer WAL | **V12** | seed via `createSnapshot` (`VACUUM INTO`), honor `consistent` | Row-count + balance verify FAIL ✅ |
| F18 | **`importBatch.ts` ignores `consistent`** | Degraded snapshot recorded as `snapshot_path`; CSV import proceeds with a rollback file that may not open | **V6b** | check the flag, as `sync.ts:345` already does (task T6a) | **Silent — live on `main` today** ❌ open until T6a lands |
| F19 | Missing `WORKDIR /app` | `process.cwd()` resolves to `/`; ledger, snapshots and pending stash land outside the volume | **V4** | `WORKDIR /app` + boot assertion | Empty dashboard on a full volume ⚠️ |
| F20 | `snapshot-cli` has no `src/` | Runner image never copies the source tree; `db:export` cannot import `snapshot.ts` | **V6** + CI docker job | esbuild the CLI in the builder stage; CI smoke-tests it | `db:export` fails — loud ✅ |
| F21 | Non-deferrable FKs | `SET CONSTRAINTS ALL DEFERRED` is a no-op; cutover fails on the first self-referencing row | **V20** | hand-written `ALTER CONSTRAINT` migration + `pg_constraint` test | Transaction aborts — loud ✅ |
| F22 | Cutover reads a live file | `/sync` or an import writes mid-cutover; PG certified against a state that never existed as a whole | **V21** | migrate from a `VACUUM INTO` snapshot, not `money.db` | Reports PASS on a partial ledger ❌ → closed |
| F23 | `import_batches.snapshot_path` | Snapshot files live only in the old host `data/`; the new `./backups` bind starts empty | **V12** | seed copies the files, leaves the rows (absolute host paths, display-only) | Missing artifact, path text still true ⚠️ |
| F24 | **`sync/page.tsx:37` transfer-review window** | `daysAgoIso()` off `Date.now()`; under UTC the inclusive `gte` cutoff lands a day early, dropping edge-of-window ambiguous pairs from review | **V3** | route through `now.ts` | Silent — pair stays unlinked, spending inflated ❌ |

**Critical gaps in the plan: none remain open.** The one open row, F18, is not a gap in
the plan — it is a bug in shipped code that this review discovered, scheduled as T6a and
mirrored to `TODOS.md` as a P0. It is listed open because it is open on `main` today.
F2 (TZ) closed by the boot guard;
F3 (volume loss) reduced to "ledger lost, snapshots survive" by the separate bind mount;
F5 (missed await) covered by tsc + lint + 402 tests; F16 — the worst of them, a
reconciliation that passes while every envelope is wrong — closed by the row-level hash
and proven by V14.

F3 is downgraded, not eliminated: `docker compose down -v` still destroys the live
ledger, and recovery means restoring the newest snapshot from `./backups`. Off-box
backup is PR3.

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| PR1-a Docker build | `Dockerfile`, `compose.yaml`, `.dockerignore`, `next.config.ts` | — |
| PR1-b TZ + `now.ts` | `src/lib/`, `src/app/*/page.tsx`, `src/components/ledger/` | — |
| PR1-c health + entrypoint | `src/app/api/`, `docker/` | — |
| PR1-d CI docker job | `.github/workflows/` | PR1-a |
| PR2-a schema port | `src/db/` | PR1 merged |
| PR2-b async conversion | `src/lib/`, `src/app/` | PR2-a |
| PR2-c test harness | `src/lib/test/` | PR2-a |
| PR2-d snapshot redesign | `src/lib/snapshot.ts`, `docker/` | PR2-a |
| PR2-e cutover script | `scripts/` | PR2-a, PR2-c |

```
  Lane A: PR1-a → PR1-d          (Docker + CI, shared workflow files)
  Lane B: PR1-b                  (independent — src/lib + pages)
  Lane C: PR1-c                  (independent — new files only)
          └─► merge A+B+C ─► PR1 ships
  Lane D: PR2-a                  (must land alone — everything depends on it)
          └─► Lane E: PR2-b      (touches src/lib + src/app)
              Lane F: PR2-c      (touches src/lib/test only)
              Lane G: PR2-d      (touches src/lib/snapshot.ts only)
              Lane H: PR2-e      (touches scripts/ only)
              └─► merge E+F+G+H ─► PR2 ships
```

**Conflict flags:** Lanes B and E both touch `src/lib/` and `src/app/` — but they are
in different PRs, so no concurrent conflict. Within PR2, lanes E, F, G all touch
`src/lib/`; F and G are confined to single files (`test/db.ts`, `snapshot.ts`) that E
does not modify, so the three can run in parallel worktrees. E is the wide one and
should own `src/lib/` otherwise.

**Sequencing constraint added by review:** PR1-e (`src/lib/paths.ts`, D4.1B) must land
**before** PR1-b and the snapshot split, because three separate places currently derive
the snapshot directory from the database path. It is a lane of its own, first.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

### PR1

- [ ] **T1 (P1, human: ~2min / CC: ~1min)** — compose — bind the published port to loopback
  - Surfaced by: Architecture — D3.1A, unauthenticated ledger published to `0.0.0.0`
  - Files: `compose.yaml`
  - Verify: `curl` from another LAN device is refused; `localhost:3000` works
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — lib — consolidate the 4 path constants into `src/lib/paths.ts`
  - Surfaced by: Code Quality — D4.1B; `src/db/index.ts:6`, `importBatch.ts:12`, `sync.ts:18`, `pendingImport.ts:13`
  - Files: `src/lib/paths.ts`, `src/db/index.ts`, `src/lib/importBatch.ts`, `src/lib/simplefin/sync.ts`, `src/lib/pendingImport.ts`
  - Verify: `pnpm test` green; host defaults byte-identical to today
- [ ] **T3 (P1, human: ~3h / CC: ~25min)** — lib+app — `src/lib/now.ts` (`currentMonth`/`todayIso`/`daysAgoIso`), route **8** server sites, add `connection()` to `/import`
  - Surfaced by: Architecture — UTC month drift; outside voice #4 (`loadMonthlyTrends.ts:47` missed, `/import` build-frozen); adversarial re-review (`sync/page.tsx:37` missed)
  - Files: `src/lib/now.ts`, `src/app/{page,budget/page,categorize/page,transactions/page,subscriptions/page,import/page}.tsx`, **`src/app/sync/page.tsx`**, `src/lib/trends/loadMonthlyTrends.ts`
  - Verify: V3/V13 in the test table; `spine-month.tsx` left alone
- [ ] **T4 (P1, human: ~2h / CC: ~15min)** — docker — entrypoint: TZ guard, pragmas, absolute server import, COPY `docker/`, **`WORKDIR /app` + a boot assertion that `process.cwd() === "/app"`**
  - Surfaced by: D4.2B, D4.3B, outside voice #2 (CMD referenced an uncopied file; relative import resolved wrong)
  - Files: `docker/entrypoint.mjs`, `Dockerfile`
  - Verify: V4; container exits 1 with `TZ` unset
- [ ] **T5 (P1, human: ~4h / CC: ~30min)** — scripts — `seed-volume.mjs`: seed via `createSnapshot` (never a bare `cp`), refuse non-empty, refuse `consistent:false`, verify row counts **and** per-account balance, copy existing snapshot files to `./backups/` (rows left as-is)
  - Surfaced by: Outside voice #1 — PR1 served an empty ledger, headline goal unmet
  - Files: `scripts/seed-volume.mjs`, `package.json`
  - Verify: V12
- [ ] **T6 (P1, human: ~2h / CC: ~15min)** — lib — split `SNAPSHOT_DIR` from `DATA_DIR`, **plus the mandatory retention regression test**
  - Surfaced by: D3.3B; `snapshot.ts:57`, `importBatch.ts:190`, `sync.ts:400` all derive the dir from the DB path
  - Files: `src/lib/snapshot.ts`, `src/lib/importBatch.ts`, `src/lib/simplefin/sync.ts`, `src/lib/snapshot.test.ts`
  - Verify: **V1 (regression)** — 12 imports leave exactly 10 snapshots in `SNAPSHOT_DIR`
- [ ] **T6a (P0, human: ~30min / CC: ~5min)** — lib — `importBatch.ts` must honor `createSnapshot`'s `consistent` flag
  - Surfaced by: adversarial review — **live bug on `main`**, not a containerization one. `src/lib/simplefin/sync.ts:345` checks the flag; `src/lib/importBatch.ts:145` calls `createSnapshot(DB_PATH)` and goes straight into `db.transaction(…)` with no check, so a degraded copy is recorded as `snapshot_path` and the import proceeds believing it has a rollback. Contradicts CLAUDE.md rule 5.
  - Files: `src/lib/importBatch.ts`, `src/lib/importBatch.test.ts`
  - Verify: **V6b** — `consistent:false` aborts the import before any row is written
- [ ] **T7 (P1, human: ~3h / CC: ~20min)** — scripts — `snapshot-cli.mjs` (**esbuild-bundled from `src/lib/snapshot.ts` in the builder stage** — the runner has no `src/`) + `db:export`/`db:import`; `db:import` refuses a `money.db` with a `-wal` beside it
  - Surfaced by: D3.2B (bare `cp` of a live WAL DB); outside voice #2 (no callable helper in the runner)
  - Files: `scripts/snapshot-cli.mjs`, `scripts/db-export.mjs`, `package.json`
  - Verify: V6 — `consistent:false` exits 1; exported file opens in `sqlite3`
- [ ] **T8 (P2, human: ~1h / CC: ~10min)** — app — `/api/health`
  - Surfaced by: Architecture — compose healthcheck; `/` is too heavy to probe
  - Files: `src/app/api/health/route.ts`
  - Verify: V5
- [ ] **T9 (P2, human: ~4h / CC: ~20min)** — docker — Dockerfile, compose, `.dockerignore`, `output: "standalone"`, `packageManager`, optional `env_file`
  - Surfaced by: Step 0 (no container infra); outside voice #3 (`env_file` made SimpleFIN mandatory)
  - Files: `Dockerfile`, `compose.yaml`, `.dockerignore`, `next.config.ts`, `package.json`
  - Verify: `docker compose up` serves the dashboard; no `.env.local` still boots
- [ ] **T10 (P2, human: ~1h / CC: ~10min)** — ci — docker build job
  - Surfaced by: Step 0 distribution check
  - Files: `.github/workflows/ci.yml`
  - Verify: CI green on PR

### PR2

- [ ] **T11 (P1, human: ~1d / CC: ~45min)** — db — schema port to `pgTable`, incl. `timestamp({withTimezone:true})`
  - Surfaced by: Outside voice #5 — Drizzle pg `integer()` has no timestamp mode (verified in `node_modules`)
  - Files: `src/db/schema.ts`
  - Verify: `tsc --noEmit`; the 8+ `updatedAt: new Date()` sites compile unchanged
- [ ] **T12 (P1, human: ~2h / CC: ~15min)** — db — Pool singleton rewrite + identity test
  - Surfaced by: Performance — D6.2A; `src/db/index.ts:22` gates on `.open`, which `Pool` lacks
  - Files: `src/db/index.ts`, `src/db/index.test.ts`
  - Verify: repeated `db` access returns the same pool; no connection exhaustion
- [ ] **T13 (P1, human: ~4d / CC: ~2h)** — lib+app — async conversion, 292 call sites, 13 transactions
  - Surfaced by: Step 0 — zero `await db.` today; `budget.ts:12` types `Db` as `BaseSQLiteDatabase<"sync">`
  - Files: `src/lib/**`, `src/app/**`
  - Verify: `tsc --noEmit`; `no-floating-promises` + `no-misused-promises` in CI; 402 tests green
- [ ] **T14 (P1, human: ~1d / CC: ~45min)** — drizzle — regenerate all 9 migrations, **plus a hand-written `ALTER CONSTRAINT … DEFERRABLE INITIALLY IMMEDIATE` migration** (Drizzle's pg FK builder has no deferrable option) and a test asserting `condeferrable` in `pg_constraint`
  - Surfaced by: D7.3B; prior learning `drizzle-multi-stmt-migration` (statement-breakpoints in hand-written `0002`/`0005`/`0006`, plus the SQLite trigger → pg trigger function)
  - Files: `drizzle/**`, `drizzle.config.ts`
  - Verify: `pnpm db:migrate` on an empty database
- [ ] **T15 (P1, human: ~1d / CC: ~45min)** — test — PGlite harness + real `postgres:17` CI service
  - Surfaced by: D5.1A — protects the measured 38 files / 402 tests / 2.04s offline baseline
  - Files: `src/lib/test/db.ts`, `.github/workflows/ci.yml`, `package.json`
  - Verify: V7; `pnpm test` still offline and ~2s
- [ ] **T16 (P1, human: ~1d / CC: ~45min)** — lib — `pg_dump` snapshots + restore round-trip test
  - Surfaced by: D5.3B — PR2 deletes `snapshot.test.ts:87-142` and `sync.test.ts:23,54` mocks `createSnapshot`
  - Files: `src/lib/snapshot.ts`, `src/lib/snapshot.test.ts`, `Dockerfile` (pin `postgresql-client` 17)
  - Verify: V8 — write, snapshot, drop, restore, rows return
- [ ] **T17 (P1, human: ~3d / CC: ~1.5h)** — scripts — cutover in one deferred transaction + **full-column** row-level hash reconciliation (column set derived from Drizzle at runtime, never hand-listed), reading a `VACUUM INTO` snapshot rather than the live `money.db`
  - Surfaced by: D5.2B, D7.3B, D7.4B; outside voice #6 and #7 (self-refs unhandled; aggregates blind to `category_id`)
  - Files: `scripts/migrate-to-pg.mjs`, `scripts/migrate-to-pg.test.mjs`
  - Verify: V9, V10, **V14**, V15, V16, V17, **V18, V19, V21** (V20 lands with T14)
- [ ] **T18 (P2, human: ~2h / CC: ~20min)** — db — dev-only query counter, measure `/budget` cold and warm
  - Surfaced by: Performance — D6.1B; `loadMonthView.ts:103-104` + recursive `budget.ts:92` ≈ `2N + 3ND` queries
  - Files: `src/db/index.ts`
  - Verify: recorded number; under ~150ms cold → no action
- [ ] **T19 (P2, human: ~3h / CC: ~20min)** — docs — CLAUDE.md, README, PLAN.md, TODOS.md
  - Surfaced by: Prior learning `readme-plan-drift-my-money-manager` (8/10); rules 3 and 5 and the Unix-seconds convention all change
  - Files: `CLAUDE.md`, `README.md`, `PLAN.md`, `TODOS.md`
  - Verify: rule 5 text matches the `pg_dump` mechanism; no stale `VACUUM INTO` references

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 31 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |
| Outside Voice | `/plan-eng-review` | Cross-model plan challenge | 1 | ISSUES_FOUND | 8 findings, 8 folded |
| Adversarial | `/ship` | Pre-landing challenge of the *revised* plan | 3 | CLEAR | 7 + 4 + 4 findings across 3 rounds, 15 folded |

**CODEX:** 8 findings, all verified against source before acceptance. Six confirmed
outright (empty-volume seed gap, uncopied entrypoint + wrong relative import, mandatory
`env_file`, Drizzle pg `integer()` has no timestamp mode, unhandled self-referential FKs,
aggregate-blind reconciliation). One half-confirmed (`/import` genuinely build-frozen and
a 7th time site missed, but 5 of 6 pages already call `connection()`). One strategic
challenge to the staging, surfaced and decided by the user.

**CROSS-MODEL:** Codex found the two highest-severity defects in the plan — the
reconciliation that would pass while every budget envelope was wrong (F16), and the
timestamp mode that does not exist in Drizzle's pg dialect (F14). Both were in sections
this review had already passed. Overlap with this review's own findings was near zero:
the review found infrastructure and safety-net gaps, the outside voice found factual
errors in the migration mechanics. Agreement where they met: both flagged that PR1's
data story was underspecified.

**ADVERSARIAL (`/ship`, Codex gpt-5.4):** 7 findings against the *revised* plan, 3 of
them P0. Six confirmed against source, one plausible-but-unverified (the pg FK API
surface, later confirmed by reading `foreign-keys.d.ts`). All 7 folded.

The uncomfortable result: **two of the three P0s were in sections the previous round had
just fixed.** The reconciliation was rewritten in response to outside voice #7, and the
rewrite named a column that does not exist (`import_batches.row_count`; the real one is
`transaction_count`) while omitting `normalized_merchant` — the column every trained
`category_rule` matches on. So the "proof nothing changed" would still have passed while
categorization was destroyed. That is the same failure shape as the aggregate check it
replaced, one level down.

The lesson is not "review harder." It is that **a hand-curated column list was the wrong
mechanism twice**, so the list is gone: the hash now derives its columns from the Drizzle
schema at runtime, and **V18** mutates one cell of every column in turn to prove the set
is complete. A spec that can be transcribed wrong should not be transcribed.

The re-review then found 4 more, three of them defects the revision itself introduced
(a `db:export` flow still describing the `node -e` path the same edit had just declared
impossible; a `snapshot_path` rewrite premised on a path shape the app does not store;
failure-mode rows citing task ids in a column that holds test ids). Folded. The fourth was
real and new: **`src/app/sync/page.tsx:37`**, an 8th server-side time site that three
prior passes missed because it reads as arithmetic rather than a date default. Its
`daysAgoIso()` output is an inclusive `gte` cutoff for the transfer-review list, so under
UTC an edge-of-window ambiguous pair silently drops out of review and keeps inflating
spending (F24).

Also surfaced: a **live bug on `main`** unrelated to containers. `src/lib/importBatch.ts:145`
never checks `createSnapshot`'s `consistent` flag, though `src/lib/simplefin/sync.ts:345`
does — so every CSV import to date has recorded a `snapshot_path` it never verified, and
the plan asserted the opposite ("the same rule the existing callers follow"). Now **F18 /
T6a**, the only P0-priority task in PR1.

**VERDICT:** ENG CLEARED — ready to implement. Scope reduced at Step 0 from one PR to
two staged PRs. 18 decisions raised, 18 resolved, 0 outstanding. 20 implementation tasks
emitted (19 + T6a, with T3/T5/T7/T14/T17 expanded), 24 failure modes tracked. Every
plan-level finding is folded; the single open row (F18) is a bug in shipped code, not a
hole in the plan, and closes when T6a lands.

Three adversarial rounds were needed, and the shape of them is the useful record: round 1
found 3 P0s, **two of which were in sections round 0 had just fixed**; round 2 found that
3 of my 7 round-1 fixes had introduced fresh inconsistencies; round 3 found that a test I
added to cover a new finding **asserted the buggy behavior it was meant to catch**
(`daysAgoIso` returning the same date in both zones is the bug, not the fix). A plan this
size does not converge in one pass, and the failures were all of one kind: edits that
described the right change in prose while leaving a diagram, a task list, or a test row
saying the old thing.

NO UNRESOLVED DECISIONS
