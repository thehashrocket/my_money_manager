# my_money_manager

Local-first, single-user personal budgeting app for Star One Credit Union (checking + savings). Transactions arrive on their own over SimpleFIN, or from a CSV export when you need older history. Categorize them, track envelope-style budgets, and keep every row on your own machine instead of handing it to Plaid or a cloud service.

**Status:** v0.12.3. Dashboard, envelope budgets, bulk categorization, transactions list, subscriptions, goals and the 6-month trend chart all ship. `/sync` pulls posted transactions straight from the bank, and its balance check now tells real drift from a stale bank figure instead of flagging both the same way; `/import` still handles anything the feed's 45-day window no longer reaches, and can now fix a wrong starting-balance anchor inline — the anchor move itself is now atomic with the import, bounds-checked against calendar-invalid dates, and reversible from the import success page, whose "transfer pairs linked" count is now accurate even when a pending row posts via re-import rather than a fresh insert. Auto-categorization at import time (CSV or sync) can now be undone per-batch, reverting just the categorization without discarding the rest of the import. The app also runs in Docker now (still on SQLite — see the [Docker](#docker) section below). See [PLAN.md](./PLAN.md) and [CHANGELOG.md](./CHANGELOG.md).

## Stack

- **Next.js 16** (App Router + Turbopack) · **React 19** · **TypeScript**
- **Tailwind v4** · **shadcn/ui** (base-nova style, Base UI primitives)
- **better-sqlite3** + **Drizzle ORM** — local SQLite file at `./data/money.db`
- **Recharts** for the dashboard trend chart (client-side only)
- **Vitest** for parser/categorization/sync unit tests · GitHub Actions runs lint + test + build on every PR
- **pnpm** · **Node 24** (pinned via `.nvmrc`)

No auth. No Plaid. No cloud — this runs on your machine (or your own Docker host), and your ledger never leaves it. The one outbound call the app makes is a read-only pull from SimpleFIN, and what comes back is written to the local SQLite file.

## Getting started

```bash
nvm use                 # picks up Node 24 from .nvmrc
pnpm install
pnpm db:migrate         # applies Drizzle migrations to ./data/money.db
pnpm dev                # http://localhost:3000 → dashboard
```

### Docker

An alternative to `pnpm dev`, still on SQLite — no Postgres yet (see `docs/plans/dockerize-postgres.md`). The ledger lives in a named Docker volume rather than `./data`, so it isn't directly visible on the host; use the scripts below rather than reaching into the volume.

```bash
sudo mkdir -p backups && sudo chmod 777 backups  # Linux only, and only before the FIRST run — see note below
pnpm db:seed-volume            # first run only, BEFORE `docker compose up` — copies ./data/money.db
                                # into the volume so the container doesn't start with an empty ledger
docker compose up -d           # http://127.0.0.1:3000 — bound to loopback only, this app has no auth
```

On real Linux hosts, Docker auto-creates a missing `./backups` bind-mount directory as root-owned, which the container's unprivileged user can't write to. The `mkdir`/`chmod` step must come **before** `db:seed-volume` — `db:seed-volume` starts a container of its own to verify the seed, which would otherwise race Docker into auto-creating `./backups` as root first. `chmod` rather than `chown`ing to a specific user: both the container (writing snapshots) and `pnpm db:export` running on the host (copying them out) need write access to the same directory, and they run as different users. Not needed on macOS Docker Desktop, whose bind-mount layer doesn't have this issue.

`.env.local` is optional: SimpleFIN sync degrades to a configuration banner without it, and CSV import works either way. `TZ` is required (`compose.yaml` sets `America/Los_Angeles`; the container refuses to boot without one, since the app derives the current budget month from local time).

| Command | What it does |
|---|---|
| `pnpm db:export` | Snapshot the running container's ledger out to `./backups/` |
| `pnpm db:import <file>` | Stop the container, restore a snapshot file, restart |
| `pnpm db:seed-volume` | One-time host → volume copy (run before the first `docker compose up`) |

Create an account (name, type, starting balance + date) from `/import`. From there you have two ways to get transactions in.

### Automated sync (the normal path)

```bash
SIMPLEFIN_SETUP_TOKEN=<token from simplefin.org> pnpm simplefin:claim
```

That runs once. It exchanges the setup token for a long-lived access URL and writes `SIMPLEFIN_ACCESS_URL` to `.env.local` with owner-only permissions — the URL carries your credentials, so it is gitignored and only its host is ever displayed.

Then open `/sync`, pick which remote account each local account maps to, and hit **Sync now**. Posted transactions are written straight to the ledger — no preview step — behind a database snapshot taken first. The page also shows:

- **Balance check** — the bank's balance next to the one this ledger computes. A difference is only flagged as a real drift once the bank's own figure is dated after your newest ledger row; a same-day, older, or dateless bank figure shows as unconfirmed instead, alongside its as-of date, since it may just not have caught up yet. Available balance is listed separately; that gap is where pending card holds live.
- **Transfers needing review** — the rare same-day, same-amount transfer the matcher can't resolve by counting. Pick the two halves yourself.
- **Linked transfers** — what got paired automatically, each with a **Not a transfer** button. Pairing hides both rows from every spending view, so this is the way back out when a same-day, same-amount coincidence gets linked by mistake.
- **Undo this sync** — deletes the last batch's rows and the batch itself, no dev-server restart needed. Only offered while that sync is still the newest import of any kind — a CSV import landed afterward can end up relying on one of its rows, so undo refuses once that's happened rather than deleting silently. The pre-write snapshot stays as the escape hatch.
- **Undo just the auto-categorization** — when a sync batch had rows auto-categorized by a trained rule, this page links to `/import/success/[batchId]` to revert just those categorizations, leaving the transactions (and any you've since hand-recategorized) alone. Use this instead of the full sync undo when only a rule's category choice was wrong.

SimpleFIN caps history at 90 days — the feed says so itself when you ask for more. Sync halves that to 45 as its own conservative limit, so anything older has to come from a CSV import; that is a property of the feed, not a missing feature. The feed also returns only posted rows, and sync refuses to write a pending one if it ever appears: there is no way to update a row once it posts, so it would freeze a pre-authorisation amount and duplicate the real charge.

### CSV import (older history)

Upload a Star One CSV export at `/import`. The preview shows row counts, duplicates, pending rows, and errors; clicking **Confirm import** snapshots the DB, inserts the batch inside a transaction, and links transfer pairs across accounts. If the snapshot degrades to a plain file copy, the import still completes, but the success page shows a warning instead of silently trusting it as a working rollback point. This is the only way to load anything the feed no longer carries.

Each account on `/import` also has an inline "start [balance] on [date]" form — the way to fix a starting-balance anchor that was set wrong (or left at the created-with-$0 default), since a CSV import can only ever move the anchor forward, never correct a too-late one. The date is capped at today.

Rows a trained rule auto-categorizes on the way in (from either CSV import or sync) can be undone independently of the import itself: when the success page has revertible rows, an "Undo auto-categorization" button reverts just those categorizations — a transaction you've since hand-recategorized is left alone even if it landed back on the same category a rule chose.

Optional: `pnpm simplefin:sample` dumps a live account payload to `.context/simplefin-sample.json` when you want to inspect what the feed actually returns.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Start the dev server (this IS the app) |
| `pnpm test` / `test:watch` / `test:ui` | Vitest |
| `pnpm db:generate` | Generate a new Drizzle migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm simplefin:claim` | One-time: exchange a SimpleFIN setup token for an access URL (writes `.env.local`) |
| `pnpm simplefin:sample` | Dump a live `/accounts` payload to `.context/simplefin-sample.json` |
| `pnpm lint` | ESLint |
| `pnpm db:export` / `db:import` / `db:seed-volume` | Docker rollback + first-run seed — see [Docker](#docker) above |

## Layout

```
src/
  app/           App Router pages: / (dashboard), /budget/[year]/[month], /transactions,
                 /categorize, /subscriptions, /goals, /sync, /import (+ preview + success)
  components/    shadcn/ui (components/ui) + design-system pieces (components/ledger)
  db/            Drizzle schema + HMR-safe client singleton
  lib/           parseCsv, normalize, hash, transferPair, snapshot, money, rules
  lib/accounts/  Live per-account balance queries
  lib/budget/    Month view, allocations, validators
  lib/categorize/ Bulk-categorize logic, import-time-categorization undo, and validators
  lib/goals/     Savings goal progress
  lib/import/    CSV import orchestration and validators
  lib/simplefin/ Automated sync: access URL, client, mapping, bucket transfer matcher,
                 link/unlink, undo
  lib/subscriptions/ Recurring-charge detection
  lib/trends/    6-month spend by category
scripts/         simplefin-claim.mjs, simplefin-fetch-sample.mjs, migrate.mjs,
                 db-export.mjs, db-import.mjs, seed-volume.mjs (Docker rollback + seed),
                 build-docker-artifacts.mjs, snapshot-cli.src.mjs
docker/          entrypoint.src.mjs (committed) + entrypoint.mjs (esbuild-bundled, gitignored)
drizzle/         Committed migration output
data/            money.db, pre-import snapshots, pending-import stash (gitignored)
.context/        Design artifacts, CSV samples, design deltas (gitignored)
```

## Core data rules

These are load-bearing — the whole app is built around them:

1. **All money is stored as signed integer `amount_cents`.** Never floats. Withdrawals negative, deposits positive.
2. **The CSV's signs are already correct.** `Amount Debit` is pre-negative, `Amount Credit` is positive. No `Math.abs`, no sign flips by description. (This is the bug Plaid users keep hitting.)
3. **Dedup is `(account_id, import_batch_id, import_row_hash)`**, never Star One's `Transaction Number` — they reuse `6098` for pending deposits across rows. `import_row_hash = sha1(date | amount_cents | raw_description | raw_memo | row_index)`. Feed rows have no row index, so they dedup on the bank's own `external_id` instead, enforced by a partial unique index on `(account_id, external_id)`. The feed also re-sends days you already imported from CSV, so sync compares content signatures too — counted as a multiset, so two genuinely identical same-day coffees both survive. Memo whitespace is normalised on both sides of that comparison, because the CSV parser preserves Star One's padding byte-for-byte while the feed sends the same row trimmed.
4. **Transfer-pair detection is memo-independent.** Two rows pair iff `|txn_a - txn_b| == 1` AND same date AND `|amount_a| == |amount_b|` AND opposite signs AND different accounts. Star One labels the receiving-side memo correctly only ~20% of the time, so memo is confirmation-only. The feed carries no transaction number, so sync pairs by counting instead: bucket on `(date, |amount|)`, keep only opposite-signed rows in different accounts, and auto-link any bucket where the two sides balance, since every possible pairing excludes the same rows from spending. Unbalanced buckets are the ones `/sync` asks you about — as is any pair with a CSV leg carrying a transaction number the stronger ±1 matcher already judged and declined, whether the other leg is from the feed or CSV too.
5. **Every batch import writes a DB snapshot first** to `data/money.db.pre-import-{timestamp}`, using `VACUUM INTO` so WAL-resident writes are included — a plain file copy could produce a snapshot that would not open. Last 10 are kept, pruned only once the write commits. Rollback = stop dev server, swap file. Sync snapshots too, and adds a logical undo that deletes just that batch without stopping the server. Both paths check whether the snapshot actually came back consistent; if it degraded to a plain copy, a warning is persisted on the batch and shown on its success page instead of assuming the rollback works.
6. **Money comes in as decimal strings from the feed** — parse with `parseAmountToCents` (string math), never `parseFloat(x) * 100`.

## What's NOT in V1

Credit cards. Auth. Cloud sync of your data. Multi-currency. Bill pay. Investment tracking. Tax features. Split transactions. YNAB-style overspend-shuffle. Cloud/NAS hosting (Docker exists for local self-hosting only — see [docs/plans/dockerize-postgres.md](./docs/plans/dockerize-postgres.md), PR3).

## Further reading

- [CLAUDE.md](./CLAUDE.md) — guide for AI agents working in this repo (rules, conventions, Next.js 16 gotchas)
- [DESIGN.md](./DESIGN.md) — Ledger Paper design system: fonts, tokens, money display rules, spine nav
- [PLAN.md](./PLAN.md) — roadmap and current status
- [TODOS.md](./TODOS.md) — short-term checklist and post-ship follow-ups
- [CHANGELOG.md](./CHANGELOG.md) — release notes
