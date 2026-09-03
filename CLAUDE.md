@AGENTS.md

# my_money_manager — project guide for AI agents

Local-first, single-user personal budgeting app. CSV import from Star One CU (checking + savings). No cloud, no auth, no Plaid. The whole point is that **the user owns every sign on every row**.

Read `.context/notes.md` first if it is present. `.context/` is gitignored (it holds real bank-data samples), so it exists only on a machine where those artifacts were generated — a fresh clone will not have it, and that is expected rather than a missing file.

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript + React 19
- Tailwind v4 + shadcn/ui (base-nova style, Base UI primitives)
- better-sqlite3 + Drizzle ORM (`./data/money.db`, gitignored)
- Vitest for categorization/parser tests
- pnpm, Node 24 (pinned via `.nvmrc`, enforced via `engines` + `engine-strict`)

Recharts (`^3.8.1`) is in, powering `src/components/ledger/trend-chart.tsx` as of v0.7.0. Envelope cards are still plain CSS.

Wrong-Node symptom: any `pnpm` command fails with `ERR_PNPM_UNSUPPORTED_ENGINE` (blocked by `engines` + `engine-strict=true`). Run `nvm use` in the workspace to pick up `.nvmrc`. If you bypass pnpm (e.g., invoke `vitest` directly on Node 22), `better-sqlite3` crashes with a `NODE_MODULE_VERSION` mismatch because its native binding is built against Node 24.

## Layout

```
src/
  app/             Next.js 16 App Router pages + server actions
  app/_components/ Shared RSC components co-located with the app (e.g. BacklogBanner)
  components/      UI components (shadcn in components/ui, ledger/ design-system components)
  db/              Drizzle schema + client singleton
  lib/             Pure functions: parsers, normalizer, categorization, money, utils
  lib/accounts/    loadAccountBalances — live per-account balance queries
  lib/budget/      loadMonthView, upsertAllocation, validateAllocateInput
  lib/categorize/  Bulk-categorize logic and validators
  lib/import/      Import orchestration and validators
  lib/simplefin/   Automated sync: client (zod-validated), mapping, bucket transfer
                   matcher, link/unlink, undo, input validation
drizzle/           Migration output (committed)
data/             money.db + pre-import snapshots (gitignored)
.context/         Design artifacts, CSV samples, deltas (gitignored)
design_handoff_nav_and_design_system/  Live HTML design specimens + README
docker/           entrypoint.src.mjs (committed source) + entrypoint.mjs (esbuild-bundled, gitignored)
```

## Scripts

- `pnpm dev` — start dev server (localhost:3000, this IS the app)
- `pnpm test` / `test:watch` / `test:ui`
- `pnpm db:generate` — generate Drizzle migration from `src/db/schema.ts`
- `pnpm db:migrate` — apply pending migrations
- `pnpm db:studio` — Drizzle Studio GUI
- `pnpm simplefin:claim` — one-time: exchange a SimpleFIN setup token for an access URL (writes `.env.local`)
- `pnpm simplefin:sample` — dump a live `/accounts` payload to `.context/simplefin-sample.json` for analysis

## Docker (SQLite still — no Postgres yet)

`docker compose up` is a second way to run the app, alongside `pnpm dev`, not a replacement — see `docs/plans/dockerize-postgres.md` for the staged Postgres migration this sets up. The ledger lives in a named volume (`mm_data:/app/data`), not a bind mount: SQLite WAL-mode locking over VirtioFS/gRPC-FUSE (macOS bind mounts) is a known corruption hazard class, so `money.db` isn't directly visible on the host under Docker the way it is under `pnpm dev`. Snapshots land on a separate bind mount (`./backups`, `SNAPSHOT_DIR=/app/backups` in `compose.yaml`) so they survive `docker compose down -v`.

- `pnpm db:seed-volume` — **run once, before the first `docker compose up`.** Copies `./data/money.db` into the (currently empty) volume via `createSnapshot`'s `VACUUM INTO`, never a bare `cp` — the host DB runs in WAL mode, and a plain copy can silently drop rows still in `money.db-wal`. Refuses (rather than overwrites) if the volume already has a `money.db`.
- `pnpm db:export` — snapshots the running container's ledger (via `docker compose exec` + the bundled `scripts/snapshot-cli.mjs`) and copies the result to `./backups/`. Refuses to copy out a degraded (`consistent: false`) snapshot. Uses its own `EXPORT_PREFIX` (`src/lib/snapshot.ts`), not the pre-import prefix rule 5's automatic snapshots use — sharing a prefix would put a deliberate manual backup in the same retention-of-10 pool `commitImport`/`syncSimpleFin` auto-prune, so it could be silently evicted by ordinary use. Nothing prunes the export pool automatically.
- `pnpm db:import <file>` — stops the container, restores a snapshot file (must have no `-wal` sidecar — see rule 5), restarts.
- `docker/entrypoint.mjs` and `scripts/snapshot-cli.mjs` are gitignored **build artifacts**: the runner image has no `src/` tree and no devDependencies, so they can't stay thin wrappers around `src/lib/snapshot.ts`/`src/lib/paths.ts`. `scripts/build-docker-artifacts.mjs` (esbuild, `better-sqlite3` external) bundles `docker/entrypoint.src.mjs` and `scripts/snapshot-cli.src.mjs` into them during the Docker builder stage — edit the `.src.mjs` files, not the generated ones.
- The container refuses to boot without `TZ` set (`compose.yaml` sets `America/Los_Angeles`) — the app derives the current budget month from local time (`src/lib/now.ts`), and Docker's default `TZ=UTC` would silently compute the wrong month for part of every day.
- The published port is loopback-only (`127.0.0.1:3000:3000`): this app has no auth, so binding `0.0.0.0` would make the ledger LAN-readable.
- **On real Linux hosts (confirmed via CI, not just theorized), `./backups` needs its permissions fixed BEFORE the first `docker compose run`/`up` of any kind — including `pnpm db:seed-volume`, which starts one itself.** It's a bind mount, and Docker on native Linux auto-creates a missing bind-mount host directory as root-owned; the Dockerfile's `chown` only affects the image filesystem, which the bind mount then shadows. Without this, the container's unprivileged `node` user gets `EACCES` on its first snapshot write and never becomes healthy. Fix: `sudo mkdir -p ./backups && sudo chmod 777 ./backups` on the host, first — before `db:seed-volume`, not after. `chmod`, not `chown` to a single uid: two different principals need write access to this same host directory — the container's `node` user (uid 1000) writing snapshots, and `pnpm db:export` running on the **host** (a different user entirely) copying them out via `docker compose cp`.
  This took three attempts to get right, each confirmed against a real CI failure (Ubuntu; macOS Docker Desktop's more permissive bind-mount layer never surfaced any of it): (1) no permissions step at all → `EACCES` on the container's snapshot write; (2) `chown 1000:1000` → fixed the container's write, broke the host's own `docker compose cp` copy-out (`unlinkat ...: permission denied`, since the CI runner user isn't uid 1000); (3) `chmod 777`, but placed *after* `db:seed-volume` → `db:seed-volume`'s own verification step starts a container from the full `app` service definition, materializing (and root-owning) the bind mount before the `chmod` step ever got a turn (`chmod: changing permissions of 'backups': Operation not permitted`). CI's `docker` job runs the corrected `sudo mkdir`/`sudo chmod` step first, before anything else touches Docker.

## Core rules baked into the data model

These are load-bearing. Violating them corrupts the database.

1. **All money is stored as signed integer `amount_cents`.** Never floats. Never a separate sign column. Withdrawals are negative. Deposits are positive. Balance = `starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)`.
   The `>` is strict, which decides what a valid anchor is: `starting_balance_cents` must be the balance at the **close** of `starting_balance_date`, never its opening balance, or every row dated that day drops out of the total. A CSV import derives the anchor from Star One's running `Balance` column (persisted per row on `transactions.balance_cents`) rather than trusting the number typed at account creation — both real accounts were created with 0, which makes every displayed balance a net-change-since-signup figure and makes `/sync`'s drift check report a phantom missing row forever. `deriveStartingBalance` only writes an anchor when the file's running balance forms a consistent chain (that is how the true intra-day row order is established — Star One's export order is not a documented guarantee), and the anchor only ever moves **forward** in time: any (date, true closing balance) pair is valid, but a later one needs less history to be complete for the sum to come out right.
   The SUM excludes pending rows (`is_pending = false`). Star One's own running balance — the source of the anchor — doesn't reflect a pending row's amount until it posts, and the SimpleFIN `balance` field `/sync`'s drift check compares against is posted-only. `loadAccountBalances` and sync's `finaliseBalances` both filter on it; a pending row left in the sum overshoots the real balance and makes the drift check report a phantom missing row on every run.

2. **The CSV's signs are already correct.** `Amount Debit` is pre-negative, `Amount Credit` is positive, mutually exclusive. Parser rule: `debit ? debit*100 : credit*100`. No `Math.abs`, no negation by `Description`. The Plaid bug happens because Plaid transforms the data; this app doesn't.

3. **Dedup key is `(account_id, import_batch_id, import_row_hash)`**, never the bank's `Transaction Number`. Star One reuses `6098` as a pending-deposit placeholder across rows. `import_row_hash = sha1(date | amount_cents | raw_description | raw_memo | row_index_in_source_file)`.
   **`import_row_hash` alone is not enough on the CSV path either.** Star One exports an arbitrary date range, so re-exporting a wider window puts every already-imported row at a new offset and changes every hash — the hash pass then matches nothing and the whole overlap is inserted a second time while the preview reports "0 duplicates" (reproduced empirically, not theorized). `buildPreview` therefore runs a second pass on `contentSignature` (`src/lib/contentSignature.ts`, shared with sync), counted as a multiset so rule 3 does not regress. Rows already matched by hash claim their own ledger row's budget first, or an earlier identical row spends the budget of a row a later hash match already accounts for and a real second occurrence is dropped.
   A content match against an existing **pending** row is not just dropped: `commitImport` updates that row in place (`is_pending`, `balance_cents`, `bank_transaction_number`, `import_row_hash`) so a row CSV-imported while pending gets its posted counterpart merged in rather than silently absorbed by the dedup pass, which used to leave it stuck on Star One's `6098` placeholder forever — un-pairable by the transfer matcher, invisible to subscription detection. Only a pending candidate is ever an update target, so a genuinely repeated posted duplicate (two identical same-day coffees) is untouched.
   **SimpleFIN rows dedup on `external_id` instead** — the feed's own per-account transaction id, enforced by a partial unique index on `(account_id, external_id)`. There is no row index in a JSON feed, so `import_row_hash` is derived from the external id. Because the feed re-sends days already imported from CSV, sync ALSO dedups on a content signature (`date|amount_cents|raw_memo`) counted as a multiset, so two genuinely identical same-day coffees still both survive. **The memo is whitespace-normalised (trim + collapse) on both sides of that comparison and nowhere else.** `parseCsv` preserves Star One's leading padding verbatim because `import_row_hash` depends on the exact bytes, while the feed sends the same row trimmed — so a raw string compare failed for precisely the rows this exists for (a row CSV-imported while pending, which later posts and comes back on the feed) and inserted them twice.
   **Re-pointing an account's feed link** (`setAccountLink`) clears `external_id` off that account's already-imported rows whenever the link changes, so the next sync doesn't collide with the partial unique index and abort. That fixes the crash but not every consequence: the content-dedup fallback above is scoped to the account being synced (`eq(transactions.accountId, account.id)`), so it can't see these now-untagged rows if a *different* account claims the same feed next — that resync re-imports the overlap window fresh and double-counts every affected amount, silently. `setAccountLink`'s returned warning says so explicitly; nothing in the code enforces the user acting on it. Tracked in `TODOS.md` as its own follow-up, not closed by the crash fix.

4. **Transfer pair matcher is MEMO-INDEPENDENT.** Two rows are a transfer pair iff: `|txn_a - txn_b| == 1` AND same date AND `|amount_a| == |amount_b|` AND opposite signs AND different accounts. Star One labels the receiving-side memo correctly only 20% of the time; the other 80% it mislabels with the triggering merchant. Memo is confirmation-only, never disqualifying. See `memory/project_star_one_cu_overdraft_labeling.md`.
   **This rule is CSV-only.** The SimpleFIN feed carries no transaction number and no `extra{}`, so `src/lib/simplefin/matchTransfers.ts` replaces it with a counting argument: bucket by `(date, |amount|)`, then within each bucket require opposite signs across different accounts, and when a bucket holds N positives and N negatives, every bijection excludes the same rows from spending — so link it without asking. Only unbalanced buckets need a human. Two refinements matter and are both load-bearing: ATM cash withdrawals are excluded from candidacy (they collide on the round amounts sweeps use), and counts are compared **per account-pair direction**, never globally (a charge in the same account as an inbound sweep is the purchase that triggered it, not a candidate for it). Cross-source pairs are held to a higher bar: when a leg carries a `bank_transaction_number` the CSV ±1 matcher already examined it and declined to pair it, so an uncorroborated pair with **either** leg adjudicated is sent to review rather than auto-linked — the counting argument must not override a stronger signal. That includes a CSV↔CSV pair where both legs were examined and declined, not just a mixed feed↔CSV one: both-declined is the *strongest* evidence against a real transfer, not the weakest, so the guard checks "at least one leg adjudicated," never an XOR between the two legs. Measured on real data: 56 pairs auto-link, ~1 undecidable day per 90. A third guard (refusing to guess when a bucket spans 3+ accounts) exists in the code but is inert here — only two accounts ever carry rows — so treat it as forward-looking, not load-bearing.

5. **Every batch import writes a DB snapshot first**, to `data/money.db.pre-import-{timestamp}`, before any write. Rollback = stop dev server, swap file. Sync does this too, and additionally supports a logical undo (delete the batch's rows) that works without stopping the server — the file snapshot stays as the escape hatch. That undo is only offered while the sync batch is still the newest `import_batches` row of any source: CSV content-dedup has no source filter, so a later CSV import can content-match against a row the sync batch inserted and skip it, quietly relying on that row already being there. `undoSyncBatch` re-checks the same condition inside its own transaction (a second tab, a stale form resubmit) rather than trusting the page's initial check.
   Snapshots are written with `VACUUM INTO`, not a file copy. The DB runs in WAL mode, and `PRAGMA wal_checkpoint` does **not** throw when another connection holds a read — it reports `busy` in a return value. Measured: with a reader pinned, a checkpoint-then-copy produced a file that failed to open at all (`SQLITE_CORRUPT`). `createSnapshot` reports `consistent: false` when it has to fall back to a plain copy; do not silently ignore that flag. Both `commitImport` (CSV) and `/sync` check it; when it's false, a warning is persisted on `import_batches.snapshot_warning` (not a redirect query param — it has to survive a later visit to the batch's success page, not just the one right after commit) and rendered on `/import/success/[batchId]`. The import itself still proceeds — a degraded snapshot changes the safety net, not whether the write happens.
   Retention (last 10) is `pruneSnapshots`, called by the caller **after** its write commits — never inside `createSnapshot`. Pruning before the write meant a failed import had already evicted a real snapshot to make room for a useless one.

6. **Uncategorized transactions have `category_id = NULL`** and surface in the dashboard backlog tile. The "Uncategorized" seed category is for manual overrides; NULL is the default for unmatched rows.
   Both write paths auto-categorize on the way in: `commitImport` and `syncSimpleFin` resolve each row's `normalized_merchant` through `buildRuleMatcher` (`src/lib/rules.ts`, which reads and ranks the rules table once per batch rather than once per row). `applyRuleAtImport` was written, tested and documented as doing this in v0.3.0 and had **zero production callers** until 2026-09-02 — every import landed 100% uncategorized regardless of trained rules, which is how a 498-row backlog accumulated. There is no undo for import-time categorization the way `bulkCategorize` has one; tracked in `TODOS.md`, with the revisit trigger being the first `contains` or `regex` rule trained.

7. **Migrations that rebuild a table run through `scripts/migrate.mjs`, never `drizzle-kit migrate` directly.** SQLite only relaxes a `NOT NULL` column via a table rebuild (drop + recreate), and drizzle's migrator wraps every pending migration in a single `BEGIN`/`COMMIT`. `PRAGMA foreign_keys=OFF` inside the migration SQL is a documented no-op there (SQLite only honors it outside a transaction), and `defer_foreign_keys=ON` doesn't help either — SQLite's deferred-FK bookkeeping is a violation *counter*, not a final-state check, so `DROP TABLE` on an FK-referenced table (`import_batches`, in the migration that introduced this) fails the moment real rows reference it, even though the rebuilt table ends up satisfying every reference by commit. An empty dev database never hits this path. `scripts/migrate.mjs` disables `foreign_keys` on the connection *before* calling `migrate()`, so it's already off when the migrator's own `BEGIN` opens, then runs `PRAGMA foreign_key_check` afterward as a belt-and-suspenders integrity check — that pragma works regardless of the `foreign_keys` setting, so there's nothing to restore on a connection that's about to close. A rebuild is written with a `VACUUM INTO` snapshot first (same approach as rule 5, `data/money.db.pre-migrate-{ts}`), skipped only when there's no existing database yet. `pnpm db:migrate` runs this script; don't bypass it. `DB_PATH`/`MIGRATIONS_FOLDER` live once in `scripts/db-paths.mjs`, imported by both this script and `drizzle.config.ts`.

## Conventions

- Dates stored as ISO `YYYY-MM-DD` text. Timestamps as Unix seconds (`integer` with `mode: 'timestamp'`).
- Booleans as `integer` with `mode: 'boolean'`.
- Enum-like text columns use `text('col', { enum: [...] })` so Drizzle type-narrows.
- Foreign keys: always declare `references(() => ...)` on the column. Use `onDelete: 'restrict'` by default; explicit `'cascade'` where it makes sense (e.g. `category_rules` → `categories`).
- Merchant normalization is a pure function in `src/lib/normalize.ts`. Tested in isolation. 12 rules total (8 checking + 4 savings). See `.context/csv-format.md`.
- Subscription detection excludes rows where `raw_description = 'DEPOSIT'` or `raw_memo` starts with `POS ` + digits (those are refunds, never recurring).

## Automated sync (SimpleFIN)

`/sync` pulls posted transactions from Star One via SimpleFIN and writes them straight in — no preview step — behind a pre-write snapshot and a per-batch undo. Credentials live in `SIMPLEFIN_ACCESS_URL` in `.env.local` (gitignored); only the host is ever safe to display. That rule is enforced, not remembered: `authHeader` is a `Secret` whose `toString`/`toJSON`/inspect hooks all return `[redacted]`, so reading it takes an explicit `.expose()`.

The feed response is parsed with a zod schema in `client.ts`, never cast. It is the only untrusted input in the app, and an unchecked cast let a shape change through as `undefined` fields that the downstream `?? []` fallbacks read as "no accounts" — reporting a clean "up to date" while importing nothing. Schemas are `looseObject`, so a field MX adds later is not a hard failure.

Every `/sync` server action returns its outcome as state rather than throwing (`src/app/sync/error.tsx` is the backstop). Several failures are reachable from ordinary use — a stale tab resolving a bucket another tab already resolved, a double-submitted undo — and a throw would take out the undo button and the balance check along with the page.

Constraints that are properties of the feed, not choices:

- **Never more than ~45 days of history.** SimpleFIN hard-caps at 90 days — corroborated by the feed's own error string, "Requested date range exceeds limit of 90 days and was capped." The 45 is *our* conservative halving, not a documented provider limit; don't restate it elsewhere as a quoted SimpleFIN rule. CSV import stays the only path to anything older — it is not legacy.
- **No pending transactions**, and this is now *enforced* rather than assumed. Star One via MX exposes posted rows only, and sync never requests them — but that is an observation about one institution at one time. Any row arriving with `pending: true` is skipped, counted into `skippedPending` and warned about, because writing one is the worst outcome available: dedup keys on `external_id`, SimpleFIN may change that id when the row posts, and there is no update path — so the pre-auth amount would freeze *and* the posted row would land beside it. Pending activity stays visible as the gap between `balance` and `available-balance`.
- **Accounts must be linked explicitly** (`accounts.simplefin_account_id`). The feed also returns a mortgage, which the `checking|savings` enum does not model; unlinked means never imported.
- **`description === memo` on every row**, so `raw_description` has no source field and is derived from the sign. This keeps the subscription-detection exclusion on `raw_description = 'DEPOSIT'` working.
- Amounts are decimal strings — parse via `parseAmountToCents` (string math), never `parseFloat(x) * 100`.
- `normalizeMerchant` needs no SimpleFIN-specific rules: the feed's `description` is byte-identical in shape to the CSV `Memo` column, so trained `category_rules` keep matching. MX's cleaned `payee` is persisted to `transactions.payee` for display only — categorization keys on `normalized_merchant`, never on `payee`, or every trained rule would break. NULL on CSV rows.

## What's NOT in V1 — do not add

Credit cards. Auth. Cloud sync. Multi-currency. Bill pay. Investment tracking. Tax features. Split transactions (one category per transaction; override wins). Retroactive goal target edits. YNAB-style overspend-shuffle. Cloud/NAS hosting (Docker exists for local self-hosting only — see `docs/plans/dockerize-postgres.md`, PR3). Tests for UI components (categorization logic only).

CI (lint + test + build on PR) is in via `.github/workflows/ci.yml` — gates merges into `main`.

## Next.js 16 gotchas

This version has breaking changes from training-data-era Next.js. Read the relevant guide in `node_modules/next/dist/docs/01-app/` before touching anything in `src/app/`. In particular: Server Actions, `params`/`searchParams` as Promises, caching defaults, and `next.config.ts` options all shifted.

For the better-sqlite3 + HMR case: wrap the DB client in a `globalThis`-cached singleton (standard pattern for native deps). End-of-Weekend-1 smoke test is "10 HMR reloads, DB still connects."

## When in doubt

1. Read `.context/notes.md` → design artifacts index.
2. Read `.context/csv-format.md` → real-data-derived parser rules.
3. Read `.context/design-updates.md` → deltas to the canonical doc (Updates 1–5).
4. The canonical design doc is at `~/.gstack/projects/thehashrocket-my_money_manager/jasonshultz-thehashrocket-budgeting-app-design-20260416-173405.md` (outside the repo — don't duplicate into `docs/`).

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet.

**This worktree is pinned to a worktree-scoped code source** via the
`.gbrain-source` file in the repo root (kubectl-style context). Any
`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, or `query`
call from anywhere under this worktree routes to that source by default —
no `--source` flag needed. Conductor sibling worktrees of the same repo
each have their own pin and their own indexed pages, so semantic results
match the actual code on disk in this worktree.

Two indexed corpora available via the `gbrain` CLI:
- This worktree's code (auto-pinned via `.gbrain-source`).
- `~/.gstack/` curated memory (registered as `gstack-brain-<user>` source via
  the existing federation pipeline).

Prefer gbrain when:
- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes; for ongoing
auto-sync across all worktrees, run `gbrain autopilot --install` once per
machine — gbrain's daemon handles incremental refresh on a schedule.

<!-- gstack-gbrain-search-guidance:end -->
