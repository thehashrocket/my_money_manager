# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Project scaffold: Next.js 16.2.4 (App Router, Turbopack) + TypeScript + Tailwind v4 + ESLint
- shadcn/ui initialized (base-nova style, Base UI primitives, neutral base color)
- Runtime deps: `better-sqlite3`, `drizzle-orm`
- Dev tooling: `drizzle-kit`, `vitest`, `@vitest/ui`, `@types/better-sqlite3`
- `drizzle.config.ts` pointing at `./data/money.db`
- `vitest.config.ts` with `@` path alias
- `.nvmrc` pinning Node 24
- Scripts: `test`, `test:watch`, `test:ui`, `db:generate`, `db:migrate`, `db:push`, `db:studio`
- Skeleton dirs: `data/`, `src/db/`, `src/lib/`, `drizzle/`
- `pnpm.onlyBuiltDependencies` allowlist for `better-sqlite3` + `esbuild` native builds
- Design artifacts in `.context/`: design deltas (Updates 1-5), CSV format notes for checking + savings
- In-repo `PLAN.md`, `TODOS.md`, `CHANGELOG.md`
- App-specific `CLAUDE.md` — paths, scripts, and load-bearing data-model rules
- First Drizzle migration (`drizzle/0000_*.sql`) with all six tables: `accounts`, `transactions`, `categories`, `category_rules`, `budget_periods`, `import_batches`
- `src/db/schema.ts` — Drizzle schema for all tables; enum-typed text columns; integer-cents money; ISO-date text columns; Unix-seconds timestamp columns; `import_row_hash` uniqueness on `(account_id, import_batch_id, import_row_hash)`
- `src/db/index.ts` — HMR-safe better-sqlite3 client. `globalThis`-cached handle, reopens on stale cache via `Proxy` get-trap
- `src/lib/normalize.ts` — merchant normalizer, 12 rules (8 checking + 4 savings), pure function
- `src/lib/hash.ts` — `computeImportRowHash(date|amountCents|rawDescription|rawMemo|rowIndex)` → sha1 hex
- `src/lib/parseCsv.ts` — Star One CU CSV parser. Handles both checking and savings memo variants; preserves CSV signs (no `Math.abs`, no description-based flips); extracts pending flag and check-number
- `src/lib/transferPair.ts` — memo-independent transfer-pair matcher (|txn±1|, same date, equal |amount|, opposite signs, different accounts)
- `src/lib/snapshot.ts` — pre-import DB snapshotting. Copies `data/money.db` → `data/money.db.pre-import-{timestamp}` and prunes beyond 10-snapshot retention
- `src/lib/importBatch.ts` — import orchestrator. `transformRow` (normalize+hash+card4), `buildPreview` (dedup-checks against existing `import_row_hash` for the account), `commitImport` (snapshot → `db.transaction` insert of batch + rows → post-commit `linkTransferPairs`)
- `src/lib/pendingImport.ts` — file-based stash for uploaded CSVs awaiting user confirmation. JSON under `data/.pending-imports/{uuid}.json`; UUID regex gate on reads; 24h expiry
- `src/app/import/page.tsx` — server component. Account list, upload form (shown only when accounts exist), create-account form
- `src/app/import/preview/[id]/page.tsx` — preview page. Stat cards (parsed/new/duplicates/pending/errors), error list, first 200 rows, confirm/cancel server-action buttons
- `src/app/import/success/[batchId]/page.tsx` — post-commit summary. Imported count, transfer pairs linked, snapshot path
- `src/app/import/actions.ts` — Server Actions: `createAccountAction`, `uploadCsvAction`, `confirmImportAction`, `cancelImportAction`
- `src/app/page.tsx` — root redirects to `/import`
- `src/app/layout.tsx` — title "my money manager", description "Local-first personal budgeting"
- `conductor.json` — setup/run hooks apply Drizzle migrations and start the dev server via `nvm use 24`

### Verified
- HMR smoke test passes: 10 consecutive HMR reloads, DB singleton stays connected
- Vitest suite: 45 tests across 6 files (hash, normalize, parseCsv, transferPair, snapshot, importBatch)
- `tsc --noEmit` clean
- End-to-end browser verification of the confirm flow: `/import` → upload → `/import/preview/{id}` → "Confirm import" click → Server Action commits 543 rows + writes snapshot → redirects to `/import/success/{batchId}`

### Fixed
- Circular `--font-sans: var(--font-sans)` in `globals.css` introduced by `shadcn init` — replaced with literal Geist font-family names so Tailwind v4's `@theme inline` resolves correctly at parse time

### Project decisions (non-code, worth logging)
- Star One CU overdraft pairs match by sequential Transaction Number (`N` / `N+1`), not by Memo — receiving-side memo is unreliable 80% of the time
- CSV `Amount Debit` already negative, `Amount Credit` positive and mutually exclusive — parser reads the right column; no `Math.abs` or sign flip
- Uploaded CSVs stash to disk as pending imports rather than being re-uploaded at confirm time. Keeps the confirm click idempotent and avoids re-parsing on the preview→confirm round-trip

### Ignored
- `/data/*.db`, `/data/*.db-journal`, `/data/*.db-wal`, `/data/*.db-shm`
- `/data/money.db.pre-import-*` (import batch snapshots)
- `/data/.pending-imports/` (upload stash — never committed)
