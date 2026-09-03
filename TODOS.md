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

- [x] **P2** — Re-pointing a SimpleFIN link orphans `external_id`s, crashing the next sync with a unique-constraint violation. Fixed: `setAccountLink` now clears `external_id` on the old account's rows whenever the link changes (unlink, or re-point to a different feed account), so the resync no longer hits the `(account_id, external_id)` unique index collision. Surfaces a warning through the existing `ok(message, warnings)` pattern on `/sync`. Ship-review Red Team caught that the original TODO wording ("content dedup alone will cover the re-import") is false — see the new P1 below. (`src/lib/simplefin/link.ts`)
- [ ] **P1** — The relink fix above stops the crash but not the double-count it was meant to prevent. `sync.ts`'s content-dedup fallback (`existingByContent`) is scoped to `eq(transactions.accountId, account.id)` — by design, to catch a CSV row the feed re-sends onto the SAME account, not a row that moved to a DIFFERENT one. So if account B claims a feed account A used to hold, B's sync cannot see A's now-`external_id`-cleared rows at all, and re-imports them fresh: every affected amount is silently double-counted, with no error. `setAccountLink`'s warning now says this explicitly ("delete or reconcile them here first, or you'll double-count them") instead of promising a safety net that doesn't exist — but nothing enforces the user actually acting on it. Real fix needs either (a) a review-list UI on `/sync` for orphaned rows, matching the existing "transfers needing review" pattern, with a delete/dismiss action, or (b) reassigning `account_id` on relink — but (b) only round-trips correctly when an account was linked to exactly one feed across its life; clearing `external_id` erases the provenance needed to do it safely on a second relink. Decided during `/ship` 2026-09-02 to ship the crash fix now with the honest warning rather than block on this — full fix is its own dedicated pass. (`src/lib/simplefin/link.ts`, `src/lib/simplefin/sync.ts`) Still open, but a PR review pass the same day found and fixed a bug in the warning *itself*: it was gated on the clearing `UPDATE`'s own `changes` count, which is 0 (and so silently produces no warning at all) on a second relink once every row was already cleared by an earlier one — exactly the unlink/relink loop a troubleshooting user would run. The warning now queries the account's current at-risk rows directly instead of trusting that count. `src/lib/simplefin/sync.test.ts`'s "cross-account relink double-count (known P1 gap)" test pins down today's actual double-count behavior so the real fix above can be verified against it, not just believed.
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
- [x] **P3** — `import_batches.filename` is NOT NULL and now holds a synthetic non-filename for sync batches (`simplefin 2026-09-02 17:00Z`), which `SyncBatchSummary.filename` passes through to the UI. Fixed: renamed to nullable `label` (migration `0010_flat_baron_zemo.sql`, table rebuild since SQLite can't drop NOT NULL in place — also NULLs out existing synthetic sync-batch strings during the copy). CSV imports still write the real filename; sync batches leave it null. `deriveBatchLabel(source, importedAt)` (`src/lib/batchLabel.ts`) fills the display at the two render sites when `label` is null. (`src/lib/simplefin/undoSync.ts`)
- Skipped **transfer-pair confidence column**: as specced ("flag pairs auto-linked without memo corroboration"), it would be a no-op today — `matchTransfers.ts`'s `uncorroboratedCrossSource` case is already diverted to the ambiguous/manual-review queue rather than auto-linked, so every pair that reaches "Linked transfers" already carries the same confidence. Revisit only if the matcher starts auto-linking something less certain. (`src/lib/simplefin/matchTransfers.ts`)
- [ ] **P3** — `setAccountLink`'s external_id-clearing races an in-flight sync. `syncSimpleFin` snapshots linked accounts before its `await fetchAccounts(...)` network call and inserts rows afterward without re-checking the account's current `simplefinAccountId`; if a relink happens on that same account during the await window (e.g. a second tab), the sync can write rows tagged with the feed the account just left, immediately after (or racing) the clear. Same risk class the codebase already accepts elsewhere for this single-user local app — see the "stale tab" comments in `linkTransferPairManually` and `unlinkTransferPair` (`src/lib/simplefin/sync.ts`) — but flagged separately since it's a new interaction, not the same code path. Found by Codex during `/ship` 2026-09-02; not blocking, since it requires the same user to run two conflicting actions within one network round trip. (`src/lib/simplefin/sync.ts`, `src/lib/simplefin/link.ts`)
- [ ] **P4** — Money is `number` everywhere, with CLAUDE.md rule 1 carried by naming convention alone. A branded `Cents` type would make it a compile-time property; `parseAmountToCents` is the natural single point of introduction. Large diff, no behaviour change — only worth doing as a dedicated pass.
- [ ] **P4** — Simplification, advisory only (~120 lines removable): a shared batch-writer between `importBatch.ts` and `simplefin/sync.ts` (the snapshot → insert batch → insert rows → update count block is duplicated line-for-line); a shared `(date, |amount|)` bucketing helper between `transferPair.ts` and `simplefin/matchTransfers.ts` — CLAUDE.md rule 4 justifies a second decision *rule*, not a second bucketer; and a `selectUnlinked(sinceIso, db)` helper for the query `linkTransfersByBucket` and `findAmbiguousTransfers` share verbatim.

## Follow-ups from the PR #24 review (this branch)

A multi-agent review of the relink-fix/label-rename PR found real gaps beyond the P1 above — fixed same-branch:
- [x] The relink warning's undercounting bug (see the P1 entry above) — the actual fix, not just the wording.
- [x] No test proved the crash-fix actually survives a real resync, only that `external_id` gets cleared. Added `src/lib/simplefin/sync.test.ts`'s "relink then resync" test (relink away and back, resync, assert no throw and no duplicate row) and a "relink back to the original feed" case in `link.test.ts`.
- [x] `scripts/migrate.mjs`'s `foreign_key_check` alarm path — the whole reason the script exists — had no test. Added one in `src/db/migration0010.test.ts` that seeds a real dangling FK reference and asserts a non-zero exit.
- [x] `scripts/migrate.mjs` ran the most destructive write in the app (a schema rebuild) with no pre-write snapshot. Added a `VACUUM INTO` snapshot before `migrate()`, matching rule 5's approach (`data/money.db.pre-migrate-{ts}`).
- [x] `scripts/migrate.mjs`'s success log could print before its own FK check, and a `finally` block could mask the real migration error. Restructured to an explicit try/catch with the FK check always run and the log ordered after it. Also removed the inert `foreign_keys = ON` reset (the connection closes immediately after; `foreign_key_check` doesn't need it — verified against better-sqlite3).
- [x] `scripts/migrate.mjs` hardcoded `data/money.db` independently of `drizzle.config.ts`. Both now import from `scripts/db-paths.mjs`.
- [x] `drizzle/0010_flat_baron_zemo.sql` was hand-edited (drizzle-kit's raw output referenced the not-yet-existing `label` column) with no marker — a future `db:generate` could silently reintroduce the bug. Added a comment.
- [x] `deriveBatchLabel` had no fallback for an unrecognized `source` (no DB-level CHECK constraint) and `resolveBatchLabel`'s `label ?? ...` didn't catch an empty-string label (reachable via an empty `file.name`). Both now fail loud / fall through correctly; `validateUploadCsvInput` also rejects an empty filename at the boundary.
- [x] `linkAccountAction` discarding `setAccountLink`'s warning was the exact bug this PR fixed, but the wiring itself had no test. Added `src/app/sync/actions.test.ts`.
- [x] `deriveBatchLabel` rendered UTC in a local single-user app; switched to the runner's local time.

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

## Follow-ups from v0.9.0 ship review (PR1 — containerize on SQLite)

A pre-landing review (7 specialists + a Red Team pass, since the diff was 1600+ lines)
found 10 issues. Fixed same-branch, listed so the reasoning is findable:
- [x] Every container restart wrote a rollback snapshot into the same retention pool CSV
  import/sync prune to the last 10 — a crash loop or routine reboot could silently evict
  a real pre-import snapshot. `docker/entrypoint.src.mjs` now uses its own prefix
  (`PRE_MIGRATE_PREFIX`, matching `scripts/migrate.mjs`'s host-side convention) and prunes
  its own pool, so the two never compete for the same 10 slots. (`src/lib/snapshot.ts`)
- [x] `pnpm db:import` had no sanity check on the file being restored — a 0-byte or
  truncated snapshot is still a file SQLite opens as a valid, empty database, so a corrupt
  `docker compose cp` or a mistakenly-passed file would "restore" as a silently empty
  ledger with no error anywhere. `assertRestorableSnapshot` now checks for a real
  `accounts` table before the container is ever stopped, and a mid-restore failure
  (between the `cp` and the WAL-cleanup step) now prints explicit recovery guidance
  instead of an uncaught crash. (`scripts/db-import.mjs`)
- [x] `scripts/db-export.mjs`'s JSON parse of `snapshot-cli.mjs`'s output could throw
  uncaught on malformed/empty stdout. Now caught and reported as a normal failure.
- [x] `/api/health` returned the raw driver error message to any caller on a 503 — could
  leak filesystem paths or SQLite internals. Now returns a generic message; the real error
  is still logged server-side.
- [x] CI's `docker` job exercised `db:export` but never `db:seed-volume` or `db:import`'s
  real docker orchestration (only their pure guard functions had unit tests). The job now
  seeds a fixture account before first boot, and round-trips an export → import, asserting
  the container comes back healthy with the seeded data intact.
- [x] `docker/entrypoint.src.mjs`'s `runMigrations` had no test for the specific case
  CLAUDE.md rule 7 calls out — `foreign_key_check` finding violations while `migrate()`
  itself reports success (the exact state a partially-applied rebuild leaves). Added.

Skipped (low-confidence, low-stakes DRY nits — reviewed and explicitly declined, not
missed):
- [ ] **P4** — `"/app"` (the container WORKDIR) is a bare string repeated across
  `docker/entrypoint.src.mjs`, `Dockerfile`, `scripts/build-docker-artifacts.mjs`,
  `scripts/db-export.mjs`. Docker-convention-locked either way (the Dockerfile's
  `WORKDIR` line is the real source of truth); an indirection layer for one path used in
  4 files is its own complexity.
- [ ] **P4** — `scripts/seed-volume.mjs`'s balance/count verification logic exists twice:
  once as real JS (`accountBalances`/`tableCounts`), once as a hand-copied SQL string
  template run inside the container. A future change to one could drift from the other
  undetected. A cross-reference comment would be proportionate; shared codegen across the
  host/container boundary is more machinery than the risk warrants for a script already
  manually verified end-to-end.
- [ ] **P4** — The `node` user's uid (`1000`) is hardcoded identically in both
  `db-import.mjs` and `seed-volume.mjs`. `node:24-bookworm-slim`'s `node` user has been
  uid 1000 for years; not worth a runtime `id -u node` subprocess call to save one
  duplicated literal.
- [ ] **P3** — `scripts/build-docker-artifacts.mjs`'s esbuild bundle step has no
  assertion guarding which packages stay external. A future change to
  `docker/entrypoint.src.mjs` or `scripts/snapshot-cli.src.mjs` that imports another
  native/binary npm package (anything not `better-sqlite3`) would bundle "successfully"
  but only fail at container runtime (missing native binding), since the runner stage
  copies no `node_modules` for these scripts beyond what Next's tracer already put in
  `.next/standalone`. CI's docker healthcheck would catch a full boot failure, but not a
  code path only exercised later. Worth an esbuild-metafile check that fails the build
  loudly if a second native dependency creeps in — deferred as speculative (no such
  import exists today) rather than blocking this PR.
Fixed after the adversarial passes (Claude + Codex, both dispatched during `/ship`):
- [x] **`./backups`'s bind-mount permissions on real Linux hosts** — flagged as "untested"
  after the adversarial passes, confirmed for real the moment CI (Ubuntu, not macOS
  Docker Desktop) ran the `docker` job — three attempts to get right, each confirmed
  against a real CI failure:
  1. No permissions step at all → `EACCES: permission denied` on the container's first
     snapshot write, container never became healthy. Docker on native Linux auto-creates
     a missing bind-mount host directory as root-owned; the Dockerfile's `chown` only
     affects the image filesystem, which the bind mount then shadows.
  2. `chown 1000:1000 ./backups` → fixed the container's write, broke
     `pnpm db:export`'s host-side `docker compose cp` copy-out, which runs as a
     *different* user (`unlinkat ...: permission denied` on the next CI run). Two
     principals need write access to the same directory for different reasons, so no
     single `chown` target works.
  3. `chmod 777 ./backups`, placed *after* `pnpm db:seed-volume` → `db:seed-volume`'s own
     verification step starts a container from the full `app` service definition,
     materializing (and root-owning) the bind mount before the `chmod` step ever ran
     (`chmod: changing permissions of 'backups': Operation not permitted`).
  Fixed: `sudo mkdir -p backups && sudo chmod 777 backups`, moved to run **before**
  `db:seed-volume` (or anything else that starts a container). Documented the same
  ordering requirement in the README Docker quickstart. macOS Docker Desktop never
  surfaced any of this; its bind-mount layer is more permissive.
- [x] `docker/entrypoint.src.mjs`'s `checkTz` only verified `TZ` was non-empty, not that
  it named a real IANA zone. A typo (`America/Los_Angelss`) doesn't throw anywhere on its
  own — Node silently renders as UTC, reintroducing the exact bug this branch exists to
  fix, with no signal anything was wrong. Verified empirically before fixing. Now
  validated via `Intl.DateTimeFormat`.
- [x] **`db-import.mjs`/`seed-volume.mjs` hardcoded a volume-name default
  (`my_money_manager_mm_data`) for their bare `docker run -v` calls, which bypass `docker
  compose` (which resolves the name itself).** Verified empirically: `COMPOSE_PROJECT_NAME`
  overrides `compose.yaml`'s pinned `name:` field, and a bare `docker run -v <name>:...`
  silently auto-creates a missing named volume with no error — so under an overridden
  project name, `db:import`'s WAL-cleanup/chown step (and every write `seed-volume.mjs`
  makes) would silently target a different, empty, orphaned volume than the one
  `docker compose cp` actually restored into. New `scripts/docker-volume.mjs` resolves
  the real name from `docker compose config` instead of guessing. Found by a Claude
  adversarial subagent during `/ship`, which ran real Docker commands to verify the claim
  rather than asserting it; independently reproduced with `COMPOSE_PROJECT_NAME=override_test`
  end-to-end (seed → up → export → import, confirmed no phantom volume created).
- [x] `scripts/seed-volume.mjs`'s "copy existing snapshot files to ./backups" step only
  enumerated the pre-import pool (`listSnapshots`'s default prefix), silently leaving a
  user's `scripts/migrate.mjs`-produced `pre-migrate-*` rollback history behind in the old
  host `data/` directory when migrating an existing ledger into Docker. Now copies both
  pools. Found by Codex's structured review (`codex review`).

**One Codex structured-review finding investigated and disproven, not fixed** (verified
empirically before deciding, not assumed):
- Claimed a brand-new named Docker volume mounted over `/app/data` stays root-owned even
  though the Dockerfile `chown`s that path before the volume ever attaches, so a fresh
  `docker compose up` (without running `db:seed-volume` first) would fail. Disproven:
  created a genuinely fresh volume and checked ownership directly inside a container —
  Docker correctly copies the image layer's content *and ownership* into a new volume on
  first mount. Matches every one of this session's successful from-scratch
  `docker compose up` tests, none of which ran `db:seed-volume` first.

**Correction (2026-09-02): the other "disproven" Codex finding was wrong to dismiss.** The
original entry here claimed `fs.copyFileSync` preserves source mtime, "verified... on both
macOS and Linux." Re-run during the `/pr-review-toolkit:review-pr` pass on PR #25:
`copyFileSync` does **not** preserve mtime — measured directly on this machine (Node
v24.16.0) and inside `node:24-bookworm-slim`, a source stamped `2001-09-09` produced a
destination stamped with the copy time. The original test that produced "disproven" was
not reproducible; whatever it actually measured, it wasn't this. Codex's original claim was
correct and is now fixed — see below.

## Follow-ups from the `/pr-review-toolkit:review-pr` pass on PR #25 (2026-09-02)

Four parallel specialist reviews (code-reviewer, pr-test-analyzer, silent-failure-hunter,
comment-analyzer) against the full PR #25 diff, after it had already been through the
review chain above. Two findings were verified empirically (the mtime claim above, and the
`snapshot-cli` prefix collision) before fixing rather than taken on faith. All fixed
same-branch:
- [x] **`seed-volume.mjs` reversed snapshot retention order on copy.** `listSnapshots`
  returns newest-first; the "copy existing snapshots to `./backups`" loop copied in that
  order, and since `copyFileSync` doesn't preserve mtime, each copy landed with a *fresher*
  mtime than the last — the next mtime-sorted prune would keep the oldest rollback points
  and delete the newest. Fixed: `utimesSync` restores the source's real mtime after each
  copy. (`scripts/seed-volume.mjs`)
- [x] **`pnpm db:export` wrote into the same retention pool `commitImport`/`syncSimpleFin`
  auto-prune.** `snapshot-cli.src.mjs` called `createSnapshot` with no prefix, defaulting to
  the pre-import prefix — a deliberate manual backup was indistinguishable from (and could
  be silently evicted by) the automatic retention-of-10 prune. Fixed: exports now use their
  own `EXPORT_PREFIX`, which nothing auto-prunes. (`src/lib/snapshot.ts`,
  `scripts/snapshot-cli.src.mjs`, CI's `docker` job glob updated to match)
- [x] **`docker/entrypoint.src.mjs` pruned pre-migrate snapshots *before* running the
  migration they exist to protect** — the same before-the-write-it-protects bug rule 5
  already fixed for `commitImport`/`syncSimpleFin`, just not caught here. A routine restart
  with nothing to migrate still burned a slot and could evict the one snapshot taken before
  a real schema change. Fixed: prune moved to after the migration/FK-check succeeds.
- [x] `scripts/db-export.mjs` discarded the actual failure reason from inside the
  container — `execFileSync`'s thrown `.message` on a `docker compose exec` failure doesn't
  include the child's stdout, where `snapshot-cli.mjs`'s deliberate JSON-error-on-stdout
  contract puts the real diagnostic. Now reads `err.stdout` first.
- [x] `src/lib/snapshot.ts`'s `copyFileSync` fallback (used when `VACUUM INTO` fails) had no
  try/catch of its own — if the fallback hit the same permission error that made `VACUUM
  INTO` fail (the exact `EACCES`-on-bind-mount scenario documented elsewhere in this file),
  it threw uncaught. `docker/entrypoint.src.mjs`'s pre-migrate snapshot call had no
  surrounding try/catch either, so this could crash-loop the container with a raw stack
  trace instead of a `fail()`-style message. Both fixed: the copy fallback now returns a
  combined `degradedReason` instead of throwing, and the entrypoint call is wrapped.
- [x] `scripts/db-import.mjs` reported "Restored" unconditionally after `docker compose up
  -d`, which returns as soon as the container is *told* to start, not once it's healthy — a
  schema-incompatible restore could crash-loop behind a green success message. Now polls
  `docker inspect`'s health status (mirroring the wait loop CI already runs around this same
  script) before declaring success.
- [x] `scripts/seed-volume.mjs`'s parse of the in-container verification script's JSON
  output had no try/catch, unlike the identical pattern in `db-export.mjs`. By the point
  this runs the volume has already been written and chowned, so a parse hiccup (e.g. a
  stray `docker compose run` warning line) would read as "seeding failed" when only the
  double-check choked. Now caught, with a message clarifying the write likely succeeded.
- [x] `scripts/db-export.mjs`'s `docker compose cp` copy-out could race itself: with the
  default `SNAPSHOT_DIR=/app/backups`, the container path and host destination are the same
  bind-mounted inode, so the copy unlinks/truncates its own source while the daemon may
  still be reading it. Worked today by timing luck. Now short-circuits with `existsSync`
  when source and destination are already the same file.
- [x] `commitImport`/`syncSimpleFin` cached `DB_PATH`/`SNAPSHOT_DIR` in module-level consts
  computed once at import time — unlike every other `paths.ts` consumer, which reads
  `process.env` at call time (`src/lib/paths.test.ts`). Harmless in production (env is fixed
  before Next.js boots) but architecturally inconsistent and untested. Now calls
  `dbPath()`/`snapshotDir()` per invocation, matching every other consumer; added a
  regression test in both `importBatch.test.ts` and `sync.test.ts` asserting the snapshot
  actually goes to the current `SNAPSHOT_DIR`, not `DATA_DIR`. (`src/lib/importBatch.ts`,
  `src/lib/simplefin/sync.ts`)
- [x] Minor comment/doc drift: `src/lib/snapshot.ts`'s `mkdirSync` comment claimed a bad
  `SNAPSHOT_DIR` "degrades the same way" as a missing source file — neither actually
  degrades, both throw uncaught; comment corrected. `compose.yaml` hardcoded "all ten
  rollback copies" in prose next to `SNAPSHOT_DIR` (twice) instead of pointing at
  `SNAPSHOT_RETENTION`; reworded. `README.md`'s `db:import` row implied the file must come
  from `./backups/`, when any path works; reworded.

Deferred, not fixed (test-coverage gaps, lower stakes, no existing pattern in this codebase
to build on):
- [ ] **P3** — `resolveVolumeName`'s `docker compose config` JSON-parse and "volume key
  missing" branches (`scripts/docker-volume.mjs`) are untested; only the `MM_VOLUME_NAME`
  override path is. Cheap to add by mocking `node:child_process`, but no script in this repo
  currently mocks `execFileSync` for its own docker-orchestration paths — CI's real `docker`
  job round-trip is this project's chosen substitute for that class of test (see the
  v0.9.0 entry above), and this would be the first exception.
- [ ] **P3** — No negative-path test proves the *container* actually refuses to boot on a
  missing/invalid `TZ` — only the pure `checkTz` function is unit-tested. A one-line CI step
  (`docker compose run --rm -e TZ= app`, expect nonzero) would close the loop cheaply.
- [ ] **P4** — `seed-volume.mjs`'s `volumeHasDb` (the docker-shell-out check backing
  `assertVolumeEmpty`) has no test exercising its "already has money.db" or "docker daemon
  down" branches — CI's `db:seed-volume` step only ever runs against a genuinely empty
  volume. Low criticality: it's a thin wrapper, and the same mocking-precedent question
  above applies.
