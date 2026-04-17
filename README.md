# my_money_manager

Local-first, single-user personal budgeting app. Import CSVs from Star One Credit Union (checking + savings), categorize, and track envelope-style budgets — without handing your transactions to Plaid or a cloud service.

**Status:** Weekend 1 complete. Import pipeline works end-to-end (parse → dedup → snapshot → transactional insert → transfer-pair linking). See [PLAN.md](./PLAN.md) and [CHANGELOG.md](./CHANGELOG.md).

## Stack

- **Next.js 16** (App Router + Turbopack) · **React 19** · **TypeScript**
- **Tailwind v4** · **shadcn/ui** (base-nova style, Base UI primitives)
- **better-sqlite3** + **Drizzle ORM** — local SQLite file at `./data/money.db`
- **Vitest** for parser/categorization unit tests
- **pnpm** · **Node 24** (pinned via `.nvmrc`)

No cloud. No auth. No Plaid. No deployment target — this runs on your machine.

## Getting started

```bash
nvm use                 # picks up Node 24 from .nvmrc
pnpm install
pnpm db:migrate         # applies Drizzle migrations to ./data/money.db
pnpm dev                # http://localhost:3000 → redirects to /import
```

Create an account (name, type, starting balance + date) from `/import`, then upload a Star One CSV export. The preview shows row counts, duplicates, pending rows, and errors; clicking **Confirm import** snapshots the DB, inserts the batch inside a transaction, and links transfer pairs across accounts.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Start the dev server (this IS the app) |
| `pnpm test` / `test:watch` / `test:ui` | Vitest |
| `pnpm db:generate` | Generate a new Drizzle migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm lint` | ESLint |

## Layout

```
src/
  app/        Next.js 16 App Router pages (/import, /import/preview/[id], /import/success/[batchId])
  components/ shadcn/ui + app components
  db/         Drizzle schema + HMR-safe client singleton
  lib/        parseCsv, normalize, hash, transferPair, snapshot, importBatch, pendingImport
drizzle/      Committed migration output
data/         money.db, pre-import snapshots, pending-import stash (gitignored)
.context/     Design artifacts, CSV samples, design deltas (gitignored)
```

## Core data rules

These are load-bearing — the whole app is built around them:

1. **All money is stored as signed integer `amount_cents`.** Never floats. Withdrawals negative, deposits positive.
2. **The CSV's signs are already correct.** `Amount Debit` is pre-negative, `Amount Credit` is positive. No `Math.abs`, no sign flips by description. (This is the bug Plaid users keep hitting.)
3. **Dedup is `(account_id, import_batch_id, import_row_hash)`**, never Star One's `Transaction Number` — they reuse `6098` for pending deposits across rows. `import_row_hash = sha1(date | amount_cents | raw_description | raw_memo | row_index)`.
4. **Transfer-pair detection is memo-independent.** Two rows pair iff `|txn_a - txn_b| == 1` AND same date AND `|amount_a| == |amount_b|` AND opposite signs AND different accounts. Star One labels the receiving-side memo correctly only ~20% of the time, so memo is confirmation-only.
5. **Every batch import writes a DB snapshot first** to `data/money.db.pre-import-{timestamp}`. Last 10 are kept. Rollback = stop dev server, swap file.

## What's NOT in V1

Credit cards. Auth. Cloud sync. Multi-currency. Bill pay. Investment tracking. Tax features. Split transactions. YNAB-style overspend-shuffle. CI. Deployment.

## Further reading

- [CLAUDE.md](./CLAUDE.md) — guide for AI agents working in this repo (rules, conventions, Next.js 16 gotchas)
- [PLAN.md](./PLAN.md) — 5-weekend roadmap
- [TODOS.md](./TODOS.md) — short-term checklist
- [CHANGELOG.md](./CHANGELOG.md) — release notes
