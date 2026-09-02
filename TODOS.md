# Todos

Short-term checklist. For the full roadmap see [PLAN.md](./PLAN.md). For context and design decisions see `.context/notes.md` — note `.context/` is gitignored (it holds real bank data), so it exists only on a machine where those artifacts were generated.

## Weekend 1 — scaffold + CSV import ✅

### Done
- [x] Download real CSV export from credit union (checking + savings)
- [x] Document column format (checking + savings variants) — `.context/csv-format.md`
- [x] Document sign convention (CSV signs are already correct; Plaid is the bug)
- [x] Capture 3+ example rows per memo pattern
- [x] Identify transfer-pair mechanism (sequential Transaction Numbers, off-by-one)
- [x] Confirm all 45 overdraft pairs present in data (no third account needed)
- [x] Scaffold Next.js 16 + TS + Tailwind + shadcn + Drizzle + Vitest
- [x] HMR smoke test — `pnpm dev` starts, `GET /` returns 200, DB survives 10 HMR reloads
- [x] App-specific `CLAUDE.md` (paths, scripts, rules carved from design decisions)
- [x] First Drizzle migration — all tables at once: `accounts`, `transactions`, `categories`, `category_rules`, `budget_periods`, `import_batches`
- [x] better-sqlite3 DB client singleton in `src/db/index.ts` (globalThis-cached, Proxy-wrapped for HMR-safe reopen)
- [x] CSV parser in `src/lib/parseCsv.ts` — handles both checking and savings memo variants
- [x] Merchant normalizer in `src/lib/normalize.ts` — 12 rules total, pure function, Vitest-covered
- [x] Transfer-pair matcher in `src/lib/transferPair.ts` — memo-independent, keys on (txn±1, date, |amount|, opposite signs, different accounts)
- [x] Import preview UI — CSV upload → `/import/preview/{id}` stat cards + row list with duplicate/pending/error shading + confirm/cancel server actions
- [x] Pre-import DB snapshot in `src/lib/snapshot.ts` — copy `data/money.db` to `data/money.db.pre-import-{ts}` before any write; 10-snapshot retention
- [x] Dedup via `import_row_hash = sha1(date|amount_cents|raw_description|raw_memo|row_index)` enforced at preview time and via unique index
- [x] Pending-import stash in `src/lib/pendingImport.ts` — persists uploaded CSV between upload and confirm
- [x] Import orchestrator in `src/lib/importBatch.ts` — parse → dedup-check → snapshot → transactional insert → post-commit transfer-pair linking
- [x] Browser-verified end-to-end: `/import` upload → preview → confirm → 543 rows committed, snapshot written, redirect to `/import/success/{batchId}`

## Weekend 2 — budget + categorization + integration checkpoint

Detailed plan: `.context/weekend-2-envelope-cards-test-plan.md`.

Spine (sequential):
- [x] Migration: add `budget_periods.effective_allocation_cents`, seed Uncategorized + 5 default leaf categories (Groceries, Gas, Dining, Utilities, Misc), BEFORE DELETE trigger on Uncategorized
- [x] `src/lib/money.ts` — extract `formatCents`, Vitest-cover, swap both import pages
- [x] `src/lib/test/db.ts` — `:memory:` Drizzle migrator helper
- [x] `src/lib/budget.ts` — `getEffectiveAllocation` + lazy-persist, `invalidateForwardRollover`, `computeMtdSpent` (DB-backed, Vitest-covered)
- [x] `src/lib/rules.ts` — `applyRuleAtImport`, `createOrUpdateRule` (Vitest-covered)

Spine retroactive (do before Track A — locked via `/plan-eng-review` 2026-04-16):
- [x] `src/lib/budget.ts` — split `getEffectiveAllocation({ persist })`; default `persist: false`. `/budget` reads non-persisting; `upsertBudgetAllocationAction` persists. Update `src/lib/budget.test.ts` to cover both modes.
- [x] `src/lib/budget.ts` — extend `invalidateForwardRollover` contract: triggered on (a) allocation edits, (b) transaction categorize/re-categorize, (c) `carryover_policy` change. JSDoc + tests for all three paths.

Tracks (parallelizable once spine is in):
- [x] Track A — `/budget` + `/budget/[year]/[month]`: server-rendered `<table>` (no TanStack), parent-grouping with synthetic 'Ungrouped' section when any leaf has `parent_id = NULL`, summary strip, Uncategorized backlog tile, "Categorize backlog" CTA
  - [x] `/budget/page.tsx` — `await connection()` + `redirect()` to `/budget/{now.year}/{now.month}`
  - [x] `/budget/[year]/[month]/page.tsx` — Zod-parse params at top; `notFound()` on invalid
  - [x] `src/lib/budget/loadMonthView.ts` + test — query layer for the page
  - [x] `src/lib/budget/validateAllocateInput.ts` + unit test (pure, DB-free)
  - [x] `src/app/budget/actions.ts` — minimal `upsertBudgetAllocationAction` (single-field Allocate); integration test via `:memory:`
  - [x] Category-name cell as only `<Link>`; Allocate is sibling button (no nested `<a>`/`<button>`)
- [x] Track B — `/transactions`: row list, inline picker, "Remember for all [merchant]" + "Apply to past [merchant]" checkboxes, `categorizeTransactionAction` — MUST call `invalidateForwardRollover` on category change
- [x] Track C — `/categorize`: bulk-by-merchant view, `bulkCategorizeMerchantAction` — MUST call `invalidateForwardRollover` per affected category
  - [x] `src/lib/categorize/validateBulkCategorizeInput.ts` + unit test (Zod, parent / savings-goal / unknown rejects)
  - [x] `src/lib/categorize/loadMerchantGroups.ts` + test — GROUP BY merchant with existing-rule badge (SQL-filtered)
  - [x] `src/lib/categorize/bulkCategorize.ts` + test — atomic flip, snapshot return, earliest-date-month invalidation, full prior-rule capture
  - [x] `src/lib/categorize/undoBulkCategorize.ts` + test — 3-case rule rollback, stale-row-safe txn reset
  - [x] `src/app/categorize/page.tsx` + `_categorize-ui.tsx` + `_merchant-row.tsx` — Sonner 10s Undo toast, live backlog counter with `aria-live`
  - [x] `src/app/categorize/actions.ts` — `bulkCategorizeMerchantAction`, `undoBulkCategorizeAction` (both revalidate `/categorize` + `/budget` layout)
- [x] Track D — Allocate form: three-field breakdown (explicit / rollover / effective) — upgrade the minimal form shipped in Track A
  - [x] shadcn Dialog client island (`src/app/budget/[year]/[month]/_allocate-form.tsx`) — portal-rendered, one trigger per leaf
  - [x] Rollover read-only; Explicit the only editable field; Effective auto-updates live via `aria-live="polite"`
  - [x] iOS autozoom fix folded in (`text-base sm:text-sm` on the explicit input — see P3 below)

Scope guardrails:
- [x] Zod on all new Server Actions + backfill `createAccountAction` (incl. file-size cap on `uploadCsvAction`, 1e10 balance reject, UUID guard on confirm/cancel, snapshot validator on `undoBulkCategorizeAction`)
- [ ] No Recharts, no savings-goals UI, no split transactions (per V1 exclusions)
- [x] shadcn components locked: Table (`/budget`), Dialog (allocate), Sonner (toasts), Combobox (inline picker on `/categorize` + `/transactions` via shared `CategoryCombobox`). No TanStack per Track A decision; `table` is the shadcn primitive, not DataTable.
- [x] `font-variant-numeric: tabular-nums` on every cents cell; WCAG AAA contrast on red/green tokens (light-mode `--destructive` bumped to L≈0.40; all money cells use `red-800`/`emerald-800` with `dark:*-400`)
- [x] Mobile (<640px) collapses `/budget` table to stacked cards (`MobileCards` in `src/app/budget/[year]/[month]/page.tsx`); parens `($42)` for negatives centralized in `formatCents` (`src/lib/money.ts`) and covered by `src/lib/money.test.ts`

Checkpoint:
- [ ] **Integration checkpoint:** use the app for 1 week on real data before moving on

## Weekend 5 — Goals + Recharts trend chart ✅

- [x] `src/lib/goals/loadGoals.ts` — query layer: progress = SUM(budget_period contributions) − ABS(negative txns), monthly breakdown
- [x] `src/lib/goals/validateGoalInput.ts` — Zod schemas for create/update-target
- [x] `src/app/goals/actions.ts` — `createGoalAction`, `updateGoalTargetAction`
- [x] `src/app/goals/page.tsx` — goal cards, progress bars, create form, edit-target form, monthly breakdown `<details>`
- [x] `src/lib/categoryErrors.ts` — `NotASavingsGoalError` added
- [x] `src/components/ledger/spine.tsx` — Goals nav link enabled (`/goals`)
- [x] `src/lib/trends/loadMonthlyTrends.ts` — last 6 months of spend by top-level category group (transfers/savings/income excluded)
- [x] `src/components/ledger/trend-chart.tsx` — `"use client"` Recharts stacked bar chart, CSS var colors, custom tooltip
- [x] `src/app/page.tsx` — SpendingTrends section added between MonthlySummary and backlog tile
- [x] `recharts@3.8.1` added to dependencies

## Weekend 3-5

See [PLAN.md](./PLAN.md). Detail when starting each weekend.

## Weekend 4 — Subscriptions tracker ✅

- [x] `subscription_dismissals` table + migration (`drizzle/0004_chubby_the_spike.sql`)
- [x] `src/lib/subscriptions/detectSubscriptions.ts` — pure detection: 3+ txns, monthly [25-35d] or quarterly [85-95d] intervals, amount within MAX($0.50, 2% of median). 13 Vitest tests.
- [x] `src/lib/subscriptions/loadSubscriptions.ts` — queries transactions, runs detection, splits active vs dismissed
- [x] `src/app/subscriptions/page.tsx` — server-rendered list: detected subscriptions with cadence, median charge, next expected date; dismissed section
- [x] `src/app/subscriptions/actions.ts` — `dismissSubscriptionAction` / `restoreSubscriptionAction` (Zod-validated)
- [x] Spine nav: Subscriptions link enabled, Goals remains "Coming Weekend 5"

## Follow-ups from v0.8.0 ship review

- [ ] **P2** — Re-pointing a SimpleFIN link orphans `external_id`s. `setAccountLink` blocks two local accounts holding the same feed id at once, but not unlink-then-relink to a different account: the rows already imported keep their `external_id` under the old account, and the partial unique index is scoped to `(account_id, external_id)`, so the next sync re-imports the whole overlap window into the new account and every amount double-counts. Either refuse while that account still holds feed rows, or clear their `external_id` and warn that content dedup alone will cover the re-import. (`src/lib/simplefin/link.ts`)
- [x] **P2** — `syncNowAction` discards `outcome.warnings`. Fixed: `SyncActionState` carries `warnings` and a `warning` status, rendered by `ActionStatus`. A sync carrying warnings is never shown as a plain success, so a dark account can no longer report "Already up to date." (`src/app/sync/actions.ts`)
- [x] **P3** — Test gaps: `warnings[]` forwarding, the pending-row refusal, the cross-source candidacy guard, the whitespace dedup case, the out-of-window dedup case, unlink round-trips and WAL snapshot consistency are all covered (375 → 402 tests). Still uncovered: `findAmbiguousTransfers`'s window + stateless-resolution contract, and a non-zero `driftCents` case. (`src/lib/simplefin/`)

## Follow-ups from the v0.8.0 code review (this branch)

Fixed on this branch — listed so the reasoning is findable, not as open work:
- [x] Cross-source content dedup compared a trimmed feed memo against an untrimmed CSV one, duplicating any row imported from CSV while pending. `contentSignature` now normalises whitespace on both sides.
- [x] `createSnapshot` used `PRAGMA wal_checkpoint`, which reports `busy` in a return value rather than throwing; with a reader pinned it could produce a snapshot that would not open (`SQLITE_CORRUPT`). Now `VACUUM INTO`, with a `consistent` flag when it has to fall back.
- [x] Snapshot pruning ran before the write it protects, so failed syncs ate rollback history. Now `pruneSnapshots`, called after commit.
- [x] The dedup lookup was date-bounded while the unique index is not, so a row dated before the window either duplicated or aborted the batch with a raw `SqliteError`.
- [x] The feed response was cast, not validated. Now zod-parsed in `client.ts` with `looseObject` for forward compatibility.
- [x] Three of four server actions threw with no error boundary on the route; all four now return state, plus `src/app/sync/error.tsx`.
- [x] `undoSyncAction` discarded its `UndoResult`, making a no-op undo look identical to a successful one.
- [x] No code path anywhere cleared `transfer_pair_id`. Added `unlinkTransferPair` + a "Linked transfers" list with "Not a transfer".
- [x] Pending feed rows were written rather than refused; `authHeader` was a bare string; `AccountSyncSummary` was built invalid and patched in place.

Still open:
- [ ] **P3** — `import_batches.filename` is NOT NULL and now holds a synthetic non-filename for sync batches (`simplefin 2026-09-02 17:00Z`), which `SyncBatchSummary.filename` passes through to the UI. Consider renaming the field to `label` and deriving the display string from `source` + `importedAt`. (`src/lib/simplefin/undoSync.ts`)
- [ ] **P3** — Transfer-pair confidence is no longer stored anywhere. If the "Linked transfers" list should flag pairs auto-linked without memo corroboration (the likeliest place a wrong link hides), that needs a `transfer_confidence` column, not a revived field with no consumer. (`src/lib/simplefin/matchTransfers.ts`)
- [ ] **P4** — Money is `number` everywhere, with CLAUDE.md rule 1 carried by naming convention alone. A branded `Cents` type would make it a compile-time property; `parseAmountToCents` is the natural single point of introduction. Large diff, no behaviour change — only worth doing as a dedicated pass.
- [ ] **P4** — Simplification, advisory only (~120 lines removable): a shared batch-writer between `importBatch.ts` and `simplefin/sync.ts` (the snapshot → insert batch → insert rows → update count block is duplicated line-for-line); a shared `(date, |amount|)` bucketing helper between `transferPair.ts` and `simplefin/matchTransfers.ts` — CLAUDE.md rule 4 justifies a second decision *rule*, not a second bucketer; and a `selectUnlinked(sinceIso, db)` helper for the query `linkTransfersByBucket` and `findAmbiguousTransfers` share verbatim.

## Follow-ups from v0.2.0 ship review

- [x] **P2** — `commitImport` throws a generic Error when every row is a duplicate. Show a friendlier preview-page message ("nothing new to import") instead of bubbling to the error boundary. (`src/lib/importBatch.ts:130`)
- [x] **P2** — `linkTransferPairs` pulls every same-day unpaired row across every account on each import. Pair-matching bucketed by `(date, |amount|)` in `findTransferPairs`, collapsing the O(n²) same-day scan to O(n). (`src/lib/transferPair.ts`)
- [x] **P3** — Server Action validation hardening: `uploadCsvAction` now caps at 10 MB via `validateUploadCsvInput`; `createAccountAction` rejects `1e10` via a $100M upper bound in `validateCreateAccountInput`. Both now use `Object.fromEntries(formData)` → Zod `safeParse` pattern matching `validateAllocateInput`. Also closes out `confirmImportAction`/`cancelImportAction` (UUID regex guard).

## Follow-ups from v0.4.0 ship review

- [x] **P0** — `parseCsv.test.ts` fails at test-load time with ENOENT on `.context/attachments/sample-csv.csv`. Resolved by bundling synthetic fixtures into `src/lib/__fixtures__/` (`sample-checking.csv`, `sample-savings.csv`). Real-data assertions replaced with fixture-backed assertions covering every parser branch. Also added `engines: node >=24` + `engine-strict=true` so wrong-Node shells fail loudly instead of silently ABI-breaking `better-sqlite3`.

## Follow-ups from v0.3.0 ship review

- [x] **P2** — `createOrUpdateRule` TOCTOU: select-then-insert has no unique index on `(match_type, match_value)`, so concurrent writers could both take the insert branch. Add a unique index + `ON CONFLICT DO UPDATE` (requires schema migration). Single-user local app so unlikely in practice. (`src/lib/rules.ts`)
- [x] **P3** — `undoBulkCategorize` rule-delete: when the snapshot's `priorRule` was "no rule existed," the undo deletes the current exact-match rule for the merchant unconditionally. If an overlapping bulk-categorize ran between the original and the undo, this could delete a rule it didn't create. Filter by inserted rule id when available. (`src/lib/categorize/undoBulkCategorize.ts`)
- [x] **P3** — ReDoS on user-authored `regex`-type rules: `applyRuleAtImport` runs user regex without a timeout guard. Single-user, low severity — but consider a hard length cap on the pattern. (`src/lib/rules.ts`)
- [x] **P3** — Input field styling: `/budget` allocate input is `text-sm` which undershoots 16px and triggers iOS autozoom. Bump to `text-base` on mobile breakpoints. (`src/app/budget/[year]/[month]/_allocate-form.tsx` — `text-base sm:text-sm`)

## Follow-ups from the dockerize + Postgres plan review (2026-09-02)

- [x] **P0 — `importBatch.ts` never checks `createSnapshot`'s `consistent` flag.**
  CLAUDE.md rule 5 says a degraded snapshot is never silently ignored, and
  `src/lib/simplefin/sync.ts:345` does check it. `src/lib/importBatch.ts:145` calls
  `createSnapshot(DB_PATH)` and goes straight into `db.transaction(...)` with no check,
  so a plain-copy fallback (which `snapshot.ts:62-86` documents as sometimes producing a
  file that will not open at all) is recorded as `import_batches.snapshot_path` and the
  CSV import proceeds believing it has a rollback. This is live on `main` today and
  independent of the Docker work. Fixed ahead of PR1: `CommitResult`'s `committed`
  variant now carries `warnings: string[]` (warn-and-proceed, matching `sync.ts`'s
  policy — commit still succeeds). Initial version surfaced the warning via a
  `?warning=` query param on the redirect; adversarial review (Claude + Codex,
  independently) flagged that as forgeable and non-durable — it vanished on any
  later visit to `/import/success/[batchId]` and put raw SQLite error text in the
  URL/browser history. Fixed by persisting it instead: `import_batches` gained a
  nullable `snapshot_warning` column (migration `0009_narrow_sentinels.sql`),
  written once at commit time; the success page reads it straight from the batch
  row. Covered by tests in `importBatch.test.ts`. Originally tracked in the plan
  as F18/T6a to land with PR1; fixed sooner instead, on its own branch.
  Found by the `/ship` adversarial pass, 2026-09-02.

Deferred out of `docs/plans/dockerize-postgres.md` during `/plan-eng-review`. Both were
considered and explicitly scoped out, not forgotten.

- [ ] **PR3 — reach the app from a phone / run it on a NAS.** The reason Postgres is in
  the plan at all. PR1 and PR2 make it possible; neither makes it happen. Three parts:
  (a) **private network access** — the app has no auth by design (CLAUDE.md, "NOT in V1"),
  which is correct on a loopback-bound container and wrong on a routable one. Tailscale or
  WireGuard is the boring answer: your devices only, no port-forward, and no auth needed.
  Reach for real auth only if you reject that. (b) **multi-arch images** — NAS hardware is
  usually `linux/amd64` (Synology, UGREEN) or `linux/arm64` (Pi); the dev Mac is arm64, so
  publishing needs `buildx` and a registry (GHCR). (c) **off-box backups** — failure mode
  F3 is downgraded, not closed: snapshots survive on a host bind mount, but
  `docker compose down -v` still destroys the live ledger, and ten rolling snapshots
  inside one machine is not a backup once the app lives on a NAS. Depends on PR1
  (container) and PR2 (`pg_dump` as the backup unit).

- [ ] **P3 — `/budget` set-based query rewrite, gated on the T18 measurement.**
  `src/lib/budget/loadMonthView.ts:103-104` calls `getEffectiveAllocation` and
  `computeMtdSpent` per leaf category, and `getEffectiveAllocation` recurses into prior
  months (`src/lib/budget.ts:92`) doing three more queries per level — roughly `2N + 3ND`
  queries per render. In-process and free under better-sqlite3; one socket round trip each
  under Postgres. The cold path is the common one, since `invalidateForwardRollover`
  clears `effective_allocation_cents` on every categorize and every allocation edit.
  **Close this item with the number:** T18 adds a dev-only query counter and records
  `/budget` cold and warm on real data right after cutover. Under ~150ms cold, close it
  as not-needed. Over it, replace the loop with one join for allocations and one grouped
  aggregate for spend. Deliberately NOT done during the migration — `getEffectiveAllocation`'s
  rollover math is the most subtly-tested logic in the repo (`budget.test.ts` covers both
  persist modes and all three invalidation triggers), and a structural rewrite riding along
  with a dialect change would give a wrong envelope two candidate causes.
