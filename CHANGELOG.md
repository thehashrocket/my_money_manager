# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-17

_Weekend 2 complete — envelope budgeting is live. `/budget` shows per-category allocations with rollover math carried forward, `/categorize` flips every uncategorized row for a merchant onto a category in one click (with 10s Undo), and the rule engine silently auto-categorizes matching rows at import. All money still flows through signed integer `amount_cents`; the envelope math is lazy-persisted on first Allocate write and invalidated forward whenever a prior month changes._

### Notes
- Shipped via `/ship`. Coverage scope per CLAUDE.md: pure functional + DB-query tier (184 tests across 17 files). UI + Server Actions verified by live browser smoke test. No UI component tests.
- Three pre-landing review fixes applied inline: SQL-side rule filter on `loadMerchantGroups` (pushed `.filter()` into an `inArray` clause), dropped useless `journal_mode=WAL` pragma on the `:memory:` test helper, and `/categorize` actions now `revalidatePath('/budget', 'layout')` so month pages refresh after a bulk flip.

### Added
- **Envelope math** (`src/lib/budget.ts`):
  - `getEffectiveAllocation({ persist })` — reads `effective_allocation_cents` cache; recomputes from carryover if missing. `persist: false` for read paths, `persist: true` for writes.
  - `invalidateForwardRollover` — clears cached `effective_allocation_cents` on every `budget_periods` row at or after a given (category, year, month). Fires on allocation edits, transaction categorize/re-categorize, and `carryover_policy` changes.
  - `computeMtdSpent` — DB-backed signed-sum of `amount_cents` for a category within a month, refunds net against spend.
- **Rule engine** (`src/lib/rules.ts`): `applyRuleAtImport` (auto-categorize during commit if an exact match exists) + `createOrUpdateRule` (idempotent upsert).
- **Track A — `/budget`** (envelope cards):
  - `/budget/page.tsx` — `await connection()` + redirect to current month.
  - `/budget/[year]/[month]/page.tsx` — Zod-parse params, `notFound()` on invalid.
  - `src/lib/budget/loadMonthView.ts` — query layer for per-category rows (allocation, MTD spent, backlog count, parent grouping, synthetic 'Ungrouped' section).
  - `src/lib/budget/validateAllocateInput.ts` + `src/app/budget/actions.ts` — `upsertBudgetAllocationAction` (single-field Allocate, Zod-gated, `Number.isFinite` dollars guard, tx-wrapped with forward-invalidation).
  - Uncategorized backlog tile + "Categorize backlog" CTA linking to `/categorize`.
- **Track C — `/categorize`** (bulk-by-merchant):
  - `/categorize/page.tsx` — server component, `await connection()`, groups uncategorized non-transfer rows by `normalized_merchant`.
  - `src/lib/categorize/loadMerchantGroups.ts` — count + signed-sum per merchant, existing-rule badge lookup (SQL-filtered via `inArray`).
  - `src/lib/categorize/bulkCategorize.ts` — atomic transaction: flip every NULL-category row for the merchant, optionally upsert the exact rule, compute earliest-date-month invalidation, return snapshot for Undo.
  - `src/lib/categorize/undoBulkCategorize.ts` — reverse via the snapshot; stale-row-safe (only resets rows still pointing at the snapshot category); 3-case rule rollback (insert-then-delete, same-target bump, different-target full restore).
  - `src/lib/categorize/validateBulkCategorizeInput.ts` — Zod validation with parent / savings-goal / unknown-category rejects.
  - `src/app/categorize/actions.ts` — `bulkCategorizeMerchantAction`, `undoBulkCategorizeAction`. Both invalidate `/categorize` + the `/budget` layout.
  - `_categorize-ui.tsx` + `_merchant-row.tsx` — client islands: live backlog counter (`aria-live`), Sonner 10s Undo toast.
- **Shared primitives**:
  - `src/lib/categoryErrors.ts` — `ParentCategoryError`, `SavingsGoalCategoryError`, `UnknownCategoryError`.
  - `src/lib/categories.ts` — `listLeafCategories`, `classifyCategory`.
  - `src/app/_components/BacklogBanner.tsx` — shared banner, `variant: 'budget' | 'categorize'`.
- **Test helper** (`src/lib/test/db.ts`) — in-memory SQLite + full migration apply, used by every new test file.
- **Layout**: `<Toaster />` mounted in `src/app/layout.tsx` (Sonner).

### Verified
- Vitest suite: **184 tests across 17 files** — all green on Node 24.
- `tsc --noEmit` clean.
- `next build` emits `/categorize` and `/budget/[year]/[month]` as dynamic routes.
- Live browser smoke: bulk-flip a 30-row merchant group onto Groceries, Undo within 10s restores rows + rule, re-flip + let toast expire keeps rule.

### Fixed (pre-landing review)
- `loadMerchantGroups` was pulling every exact-match rule then filtering in JS. Moved the merchant filter into the SQL `WHERE` via `inArray`. Wins at scale; trivial at 30–60 groups but free to fix.
- `createTestDb` called `journal_mode=WAL` on `:memory:`, which is a silent no-op. Removed.
- `bulkCategorizeMerchantAction` + `undoBulkCategorizeAction` now `revalidatePath('/budget', 'layout')` so the current month page refreshes after a bulk flip. Previously only `/categorize` was invalidated.

### Project decisions (non-code, worth logging)
- Envelope cache (`effective_allocation_cents`) is **lazy-persisted**: `/budget` page reads without writing; the first `upsertBudgetAllocationAction` persists the chain up to the edited month. Keeps GETs side-effect-free.
- Forward-invalidation is **month-granular**, not day-granular — carryover math is monthly so invalidating at day precision would be noise.
- Bulk-categorize **excludes transfer-paired rows** from both the read (`loadMerchantGroups`) and the write (`bulkCategorize`) — the transfer machinery stays the single owner of those rows.
- Rule rollback on Undo covers all 3 cases so the history of what-was-there-before is fully restored; anything else is a foot-gun.

### Known follow-ups (tracked in TODOS.md)
- **P2** — `createOrUpdateRule` TOCTOU: select-then-insert without a unique index on `(match_type, match_value)`. Single-user local app so racing is unlikely, but a unique index + `ON CONFLICT DO UPDATE` is the correct fix (schema change, deferred).
- **P3** — `undoBulkCategorize` deletes *any* exact-match rule for the merchant; in the overlapping-undo edge case this could remove a rule inserted by a later action. Filter by inserted rule id when available.
- **P3** — ReDoS on user-authored `regex`-type rules. Single-user, low severity.

## [0.2.0] - 2026-04-16

_Weekend 1 complete — CSV import pipeline is live end-to-end. You can now upload a Star One CU CSV (checking or savings), preview what's new vs. duplicate vs. pending, and commit to a local SQLite database that's snapshotted before every write. Transfer pairs between accounts are detected automatically (memo-independent, so overdraft mislabels don't throw it off)._

### Notes
- Shipped via `/ship`. Coverage scope per CLAUDE.md: pure functional tier only; UI + Server Actions verified by live browser smoke test (543-row commit).
- Docs fix: `CLAUDE.md` rule 3 updated to include `raw_memo` in the `import_row_hash` formula to match the code.

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
