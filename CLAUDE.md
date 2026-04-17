@AGENTS.md

# my_money_manager — project guide for AI agents

Local-first, single-user personal budgeting app. CSV import from Star One CU (checking + savings). No cloud, no auth, no Plaid. The whole point is that **the user owns every sign on every row**.

Read `.context/notes.md` first. It is the source-of-truth index for design artifacts.

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript + React 19
- Tailwind v4 + shadcn/ui (base-nova style, Base UI primitives)
- better-sqlite3 + Drizzle ORM (`./data/money.db`, gitignored)
- Vitest for categorization/parser tests
- pnpm, Node 24 (pinned via `.nvmrc`, enforced via `engines` + `engine-strict`)

No Recharts yet — it lands in Weekend 5 with the trend chart. Envelope cards are plain CSS.

Wrong-Node symptom: any `pnpm` command fails with `ERR_PNPM_UNSUPPORTED_ENGINE` (blocked by `engines` + `engine-strict=true`). Run `nvm use` in the workspace to pick up `.nvmrc`. If you bypass pnpm (e.g., invoke `vitest` directly on Node 22), `better-sqlite3` crashes with a `NODE_MODULE_VERSION` mismatch because its native binding is built against Node 24.

## Layout

```
src/
  app/        Next.js 16 App Router pages
  components/ UI components (shadcn in components/ui)
  db/         Drizzle schema + client singleton
  lib/        parsers, merchant normalizer, categorization, utils
drizzle/      migration output (committed)
data/        money.db + pre-import snapshots (gitignored)
.context/    design artifacts, CSV samples, deltas (gitignored)
```

## Scripts

- `pnpm dev` — start dev server (localhost:3000, this IS the app)
- `pnpm test` / `test:watch` / `test:ui`
- `pnpm db:generate` — generate Drizzle migration from `src/db/schema.ts`
- `pnpm db:migrate` — apply pending migrations
- `pnpm db:studio` — Drizzle Studio GUI

## Core rules baked into the data model

These are load-bearing. Violating them corrupts the database.

1. **All money is stored as signed integer `amount_cents`.** Never floats. Never a separate sign column. Withdrawals are negative. Deposits are positive. Balance = `starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)`.

2. **The CSV's signs are already correct.** `Amount Debit` is pre-negative, `Amount Credit` is positive, mutually exclusive. Parser rule: `debit ? debit*100 : credit*100`. No `Math.abs`, no negation by `Description`. The Plaid bug happens because Plaid transforms the data; this app doesn't.

3. **Dedup key is `(account_id, import_batch_id, import_row_hash)`**, never the bank's `Transaction Number`. Star One reuses `6098` as a pending-deposit placeholder across rows. `import_row_hash = sha1(date | amount_cents | raw_description | raw_memo | row_index_in_source_file)`.

4. **Transfer pair matcher is MEMO-INDEPENDENT.** Two rows are a transfer pair iff: `|txn_a - txn_b| == 1` AND same date AND `|amount_a| == |amount_b|` AND opposite signs AND different accounts. Star One labels the receiving-side memo correctly only 20% of the time; the other 80% it mislabels with the triggering merchant. Memo is confirmation-only, never disqualifying. See `memory/project_star_one_cu_overdraft_labeling.md`.

5. **Every batch import writes a DB snapshot first.** Copy `data/money.db` to `data/money.db.pre-import-{timestamp}` before any write. Rollback = stop dev server, swap file. Keep last 10 snapshots.

6. **Uncategorized transactions have `category_id = NULL`** and surface in the dashboard backlog tile. The "Uncategorized" seed category is for manual overrides; NULL is the default for unmatched rows.

## Conventions

- Dates stored as ISO `YYYY-MM-DD` text. Timestamps as Unix seconds (`integer` with `mode: 'timestamp'`).
- Booleans as `integer` with `mode: 'boolean'`.
- Enum-like text columns use `text('col', { enum: [...] })` so Drizzle type-narrows.
- Foreign keys: always declare `references(() => ...)` on the column. Use `onDelete: 'restrict'` by default; explicit `'cascade'` where it makes sense (e.g. `category_rules` → `categories`).
- Merchant normalization is a pure function in `src/lib/normalize.ts`. Tested in isolation. 12 rules total (8 checking + 4 savings). See `.context/csv-format.md`.
- Subscription detection excludes rows where `raw_description = 'DEPOSIT'` or `raw_memo` starts with `POS ` + digits (those are refunds, never recurring).

## What's NOT in V1 — do not add

Credit cards. Auth. Cloud sync. Multi-currency. Bill pay. Investment tracking. Tax features. Split transactions (one category per transaction; override wins). Retroactive goal target edits. YNAB-style overspend-shuffle. CI. Deployment. Tests for UI components (categorization logic only).

## Next.js 16 gotchas

This version has breaking changes from training-data-era Next.js. Read the relevant guide in `node_modules/next/dist/docs/01-app/` before touching anything in `src/app/`. In particular: Server Actions, `params`/`searchParams` as Promises, caching defaults, and `next.config.ts` options all shifted.

For the better-sqlite3 + HMR case: wrap the DB client in a `globalThis`-cached singleton (standard pattern for native deps). End-of-Weekend-1 smoke test is "10 HMR reloads, DB still connects."

## When in doubt

1. Read `.context/notes.md` → design artifacts index.
2. Read `.context/csv-format.md` → real-data-derived parser rules.
3. Read `.context/design-updates.md` → deltas to the canonical doc (Updates 1–5).
4. The canonical design doc is at `~/.gstack/projects/thehashrocket-my_money_manager/jasonshultz-thehashrocket-budgeting-app-design-20260416-173405.md` (outside the repo — don't duplicate into `docs/`).
