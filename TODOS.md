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
- [x] `src/lib/rules.ts` — `applyRuleAtImport`, `createOrUpdateRule` (Vitest-covered). **This box was wrong from 2026-04-17 until 2026-09-02:** the functions existed and were covered, but `applyRuleAtImport` had zero production callers, so nothing was auto-categorized at import. Wired into both write paths by T1 of `docs/plans/load-the-ledger.md`.

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

## Follow-ups from the `/plan-eng-review` triage pass (2026-09-02)

A review of "what should we work on next" that started by reading the real ledger
(`/Users/jasonshultz/Projects/my_money_manager/data/money.db`) rather than this file.
That inverted the priority order: 1178 transactions frozen at 2026-04-20, **0 rows in
`budget_periods`** (envelope budgeting had never been used), and 5 of 10 migrations
unapplied (so the SimpleFIN sync shipped across four releases had never touched real
data). Every open item below this line was downstream of a working ledger.

The two P1 defects that pass found are **not** listed here — they are the plan, in
[docs/plans/load-the-ledger.md](./docs/plans/load-the-ledger.md), as T1 (wire
`applyRuleAtImport`, which has zero production callers) and T2 (CSV dedup keys on
`row_index`, so a wider re-export double-counts silently — reproduced empirically).
T6 in that plan corrects the stale `[x]` on line 38 of this file and `CHANGELOG.md:292`,
both of which document auto-categorize-at-commit as shipped behavior that does not exist.

- [ ] **P2** — `/categorize` and the backlog banner are all-time, with no way to scope to a
  month. `loadMerchantGroups` (`src/lib/categorize/loadMerchantGroups.ts:33`) and
  `loadUncategorizedBacklog` (`src/lib/budget/loadMonthView.ts:161`) both query the whole
  ledger. That makes "categorize the current month, leave the history for later" —
  the only sane way to start using a ledger that has gone stale — impossible to express:
  the banner reports the full backlog on `/budget` and `/` no matter how current you are,
  and the bulk-by-merchant surface offers no filter. **Amended 2026-09-04 (eng review round 2, X4):**
  the "independent of the zero-based equation" framing that kept this deferred is no longer
  true. Once `/budget` reports `received` per income category, an uncategorized paycheck makes
  September's income silently short while the only signal is an all-time banner counting rows
  from every month. X4 pulls forward the narrow slice that fixes that — `loadUncategorizedBacklog`
  gains an optional `(year, month)` scope used ONLY by the budget page banner. What remains here
  is `loadMerchantGroups` and the dashboard tile, so "clear September's backlog so my budget is
  right" becomes a thing you can actually do end to end. Blocked by: X4's scope option landing in
  PR1a. The month-scoped path that does exist
  (`/transactions`, `src/app/transactions/page.tsx:59`) is row-by-row, which is the wrong
  tool for the head of the distribution. Found by Codex during the outside-voice pass while
  checking an effort estimate that had assumed a month-scoped bulk screen; it does not
  exist. Deferred out of `load-the-ledger.md` deliberately: it is a new feature, and that
  plan is a stabilization pass. The month picker on `/transactions` is the obvious thing to
  lift into a shared filter component when this is picked up. Depends on nothing.

- [x] **P3** — `scripts/db-paths.mjs` hardcoded cwd-relative `./data/money.db` and did not
  read `DATA_DIR`, while the app itself does (`src/lib/paths.ts:9`, `dataDir()`). The two
  disagreed about where the ledger lives, and the failure mode was silent success: running
  `pnpm db:migrate` from a Conductor worktree migrated that worktree's own empty database
  and printed "Migrations applied successfully" while the real ledger in the main checkout
  stayed untouched. Found by Codex, 2026-09-02. Fixed: `db-paths.mjs` now exports a
  `dbPath()` function that reads `process.env.DATA_DIR` at call time, matching
  `paths.ts`'s `dataDir()` logic — duplicated rather than imported, since both of this
  file's consumers (`drizzle.config.ts` via drizzle-kit, `scripts/migrate.mjs` via plain
  `node`) run with no TS loader, unlike the esbuild-bundled Docker entrypoint that can
  import `paths.ts` directly. `drizzle.config.ts` and `migrate.mjs` both updated to call
  `dbPath()` instead of reading the old `DB_PATH` constant. Verified live: `DATA_DIR=/tmp/...
  node scripts/migrate.mjs` now writes to the overridden path. New test:
  `scripts/db-paths.test.mjs`.

- [ ] **P3** — Import-time categorization will have no undo. `bulkCategorize` captures a
  full prior-state snapshot and `undoBulkCategorize` does a 3-case rule rollback
  (`src/lib/categorize/`); once `load-the-ledger.md`'s T1 wires `applyRuleAtImport` into
  `commitImport` and `syncSimpleFin`, the import path will set categories with no
  equivalent. A `contains` or `regex` rule that matches too broadly would label an entire
  4-month backfill with no one-click reversal — only the rule 5 file snapshot, which means
  discarding the whole import. Blast radius is **zero today**: all 73 rules in the real
  ledger are exact-match, and there are no `contains` or `regex` rules at all. That is why
  T1 was not blocked on this. **Revisit trigger: the first time a `contains` or `regex`
  rule gets trained.** The batch id is already on every row, so recording which rows a
  batch auto-categorized is the cheap version; matching `bulkCategorize`'s snapshot shape
  is the complete one. Depends on T1.

## Follow-ups from the `/ship` pre-landing review (2026-09-03)

Seven specialists + Red Team reviewed `thehashrocket/next-todo-priority` before it
landed. Six CRITICAL findings were fixed on the branch itself (silent-corruption paths
reachable during the migrate-then-backfill sequence: a migration-journal timestamp bug
that permanently skips seeding the Subscriptions category, a pending row's posted
counterpart being dropped forever, the starting-balance tile misattributing an anchor
move to the wrong batch, sync undo deleting a transaction with no other copy, a computed
balance overshooting the bank's posted figure, and a backwards cross-source transfer-link
guard). A handful of mechanical items (unused import, stale docstrings, a missing DB
transaction, a test that didn't test what its name claimed) were auto-fixed in the same
pass. What's below is what's left — informational, not blocking, none of it corrupts data.

- [x] **P1** — Migration 0006 seeds 23 broad `contains` rules for subscription merchants
  (NETFLIX, SPOTIFY, HULU, etc). CLAUDE.md rule 6's documented revisit trigger for
  import-time-categorization-has-no-undo is "the first `contains` or `regex` rule
  trained" — that fires the moment `pnpm db:migrate` runs on the real ledger, not at some
  future point. **Read this before step 9 of `docs/plans/load-the-ledger.md`**: the
  4.5-month backfill will auto-categorize every subscription merchant with no one-click
  undo (only the file snapshot, which discards the whole import). The P3 entry above
  ("Import-time categorization will have no undo") is no longer a someday item once
  `db:migrate` runs — its revisit trigger already fired. Found by Red Team during the
  same `/ship` pass.
  Fixed: `commitImport` and `syncSimpleFin` now write an
  `import_batch_categorizations` row (transaction id, category id, rule id) whenever
  `buildRuleMatcher` resolves a row — `buildRuleMatcher`'s return type grew from
  `number | null` to `{ categoryId, ruleId } | null` to carry the rule id;
  `applyRuleAtImport` still returns a bare category id, so its 14 existing assertions
  didn't need to change. `undoImportCategorization` (`src/lib/categorize/`) reverts a
  batch's rows grouped by category in one bulk UPDATE per group, stale-row-safe (a row
  the user re-categorized since import, including back to NULL, is left alone), and
  consumes its own audit rows so a second call reports `nothing-to-undo`. Wired to a new
  "Undo auto-categorization" button on `/import/success/[batchId]`, shown only while the
  batch still has revertible rows. This is the cheap-version fix the P3 entry above
  named as sufficient (batch-scoped record, not `bulkCategorize`'s full rule-rollback
  snapshot — there's no rule creation/mutation on the import path to roll back, only
  category application). Chosen via `/plan-eng-review` triage 2026-09-03 as the highest-
  priority open item ahead of running the load-the-ledger backfill itself.
  A `/ship` Red Team pass the same day caught two real gaps in the initial version, both
  fixed same-branch: (1) the undo button only ever appeared on `/import/success/[batchId]`,
  which nothing links to from `/sync` — a sync batch's own auto-categorization audit trail
  (`syncSimpleFin` writes it too) was reachable only by guessing the batch id in the URL.
  `/sync` now shows the same revertible-row count with a link to the success page instead
  of duplicating the undo control. (2) The displayed "N rows auto-categorized" count was a
  bare `COUNT(*)` over `import_batch_categorizations`, which doesn't fall away when a row
  is hand-recategorized before undo is ever clicked — so the number could overstate what
  undo would actually revert. Extracted `countRevertibleCategorizations` (shared by both
  pages) to mirror `undoImportCategorization`'s own stale-row check exactly, so the two
  can't drift apart.

- [x] **P2** — `deriveStartingBalance` silently picked the file's own row order when BOTH
  directions validated the running-balance chain, rather than treating that as ambiguous.
  Both orders validate exactly when a date's transactions net to zero, which is not rare
  (e.g. a paycheck and a same-day bill). Verified: the same two rows, file order vs.
  reversed, produced anchors that disagreed — a real dollar swing decided only by which
  way Star One happened to write the file, not by any actual evidence. Fixed: when both
  directions validate, `chronologicalAscending` now computes the anchor both ways and
  refuses (`{ ok: false, reason: "...disagreeing anchors..." }`) unless they agree, rather
  than defaulting to `forward`. Regression test in `deriveStartingBalance.test.ts` pins
  the exact paycheck/bill scenario. (`src/lib/accounts/deriveStartingBalance.ts`)

- [x] **P2** — `anchorStartingBalance` (`src/lib/importBatch.ts`) ran outside
  `commitImport`'s write transaction, mutated the `accounts` row with no record of the
  prior value, and had no undo path (CSV imports don't have `undoSyncBatch`'s logical
  undo). A misfiled import against the wrong account could silently overwrite a good
  anchor, recoverable only via a full snapshot restore. It was also unvalidated against
  the same magnitude/date bounds `createAccountInputSchema` enforces on a hand-typed
  starting balance — a single-row file trivially "validates" (`isValidChain` never
  executes its loop body at length 1) and would anchor on whatever that one row's Balance
  cell says, with no corroboration at all. Fixed: `anchorStartingBalance` now takes the
  transaction handle and runs inside `commitImport`'s existing `db.transaction`, so the
  row inserts and the anchor move commit or fail together. `import_batches` gained
  `prior_starting_balance_cents`/`prior_starting_balance_date` (migration
  `0014_modern_virginia_dare.sql`), written in the same transaction as the move — the
  record that lets a bad automatic move be corrected via `updateAccountAnchorAction`
  without guessing what the old value was; the import success page now shows the prior
  value next to the new one. Bounds now come from a new shared
  `src/lib/import/accountAnchorFields.ts` (dollar min/max + date-format schemas), imported
  by both `validateCreateAccountInput.ts` and `validateUpdateAnchorInput.ts` too — closing
  the adjacent P3 below about those two copy-pasting the same bounds. A derived anchor
  outside the range is declined (not written) and surfaced via `CommitResult.warnings`.
  (`src/lib/importBatch.ts`, `src/lib/import/accountAnchorFields.ts`, `src/db/schema.ts`)

- [ ] **P2** — `commitImport`'s `status: "empty"` early return (both brand-new-toInsert
  AND toUpdate empty) still means a file whose every row was already imported can never
  fix that account's `$0.00` anchor via re-import, and `balance_cents` stays NULL forever
  on rows imported before this column existed. Re-importing the original export to
  backfill those columns does nothing. Partially superseded by
  `debug-sync-balance-check`'s inline anchor-edit form on `/import`
  (`updateAccountAnchorAction`), which fixes the `$0.00`-anchor half of this directly —
  but the `balance_cents` backfill-on-already-imported-rows gap is untouched. Known and
  deliberate for this ship (no surprising side effect on a "nothing to import" path);
  revisit if backfilling `balance_cents` on already-imported rows becomes something the
  UI needs to show.

- [ ] **P3** — `applyRuleAtImport` (`src/lib/rules.ts`) has zero production callers —
  both write paths call `buildRuleMatcher` directly. It survives only so
  `rules.test.ts`'s ~14 assertions keep compiling. Flagged independently by both the
  maintainability and simplification specialists (multi-specialist confirmed): this is
  the same shape as the bug this whole branch exists to fix (a tested function nobody
  calls) — a second entry point with self-referential coverage invites the same drift
  back. Either point the 14 assertions at `buildRuleMatcher` and delete the wrapper, or
  say plainly in its docstring that nothing calls it in production.

- [ ] **P3** — The content-budget multiset-build (bucket existing rows by
  `contentSignature`, count as a map) is duplicated verbatim, comment included, between
  `src/lib/importBatch.ts` and `src/lib/simplefin/sync.ts`. The counting discipline that
  makes it correct (CLAUDE.md rule 3 — never collapse into a `Set`) is exactly the part
  most likely to be gotten wrong by a third caller, and it's the part left copy-pasted.
  Extract a `buildContentBudget` helper into `src/lib/contentSignature.ts`.

- [ ] **P3** — Two design/info-architecture items on the import success page
  (`src/app/import/success/[batchId]/page.tsx`): the "auto-categorized" / "left to
  categorize" tiles are live queries, not a record of what the import did — a user who
  later hand-categorizes the rest via `/categorize` returns to a page claiming the rule
  engine did all of it. And "already imported" (content match) vs "duplicate" (hash
  match) on the preview page (`src/app/import/preview/[id]/page.tsx`) are two words for
  the same fact, split on an implementation detail the user has no reason to care about.
  Neither is incorrect, both are worth a follow-up pass. The page also still renders in
  raw Tailwind zinc rather than DESIGN.md's paper/ink tokens, matching the rest of that
  page (pre-existing, not introduced by this branch, but grown by it).

- [ ] **P4** — `transactions_import_batch_idx` doesn't exist; the success page's two new
  per-batch queries (`autoCategorized` count, the anchor join) are full table scans, as
  is the pre-existing `pairsLinked` count on the same page. Sub-millisecond at the
  current ~1200-row scale — only worth an index if the ledger grows by orders of
  magnitude. The `autoCategorized`/`pairsLinked` queries could also collapse into one
  `COUNT(category_id)`/`COUNT(transfer_pair_id)` statement instead of two scans.

## Follow-ups from the `/ship` pre-landing review (2026-09-03, debug-sync-balance-check)

Deferred from this branch's pre-landing review (testing + maintainability specialists).
Both are pre-existing patterns the new `validateUpdateAnchorInput.ts` deliberately
mirrors from `validateCreateAccountInput.ts` rather than new bugs this branch
introduces; the one live UI entry point (`<input type="date">`) already blocks the
malformed case in every normal browser.

- [x] **P3** — `validateUpdateAnchorInput.ts` and `validateCreateAccountInput.ts` both
  validated `startingBalanceDate` with `/^\d{4}-\d{2}-\d{2}$/`, which accepted a
  syntactically-shaped but calendar-invalid date like `2026-13-40`. Because
  `loadAccountBalances` compares dates with `gt(transactions.date, account.startingBalanceDate)`
  as a plain SQLite TEXT (lexicographic) comparison, an anchor date like `2026-13-40`
  sorts after every real `2026-0X-XX`/`2026-1X-XX` date, so the `WHERE` clause would
  match zero rows and silently drop the account's entire imported history out of
  `balanceCents`. Fixed: the shared `startingBalanceDateSchema` (`accountAnchorFields.ts`,
  used by both validators plus the CSV-derived anchor path in `importBatch.ts`) now uses
  `z.iso.date()` instead of the regex — confirmed it rejects both `2026-13-40` and
  `2026-02-30` (Feb 30th) while still accepting real dates. Regression tests added to
  `accountAnchorFields.test.ts`.

- [x] **P3** — `validateUpdateAnchorInput.ts`'s `startingBalance` bounds
  (`.min(-1_000_000).max(100_000_000)`) and date regex were copy-pasted verbatim from
  `validateCreateAccountInput.ts` rather than shared, even though the new file's own
  docstring warned that letting the two paths disagree about what's a legal anchor "is
  how one of them becomes the bug." Fixed while closing the `anchorStartingBalance`
  bounds-check P2 above, which needed the same bounds a third time: extracted
  `src/lib/import/accountAnchorFields.ts` and pointed all three writers at it.

- [ ] **P3** — `updateAccountAnchorAction` (`src/app/import/actions.ts`) has no
  stale-write guard: two tabs open on `/import`, both saving an edit to the same
  account's anchor, race on a plain `WHERE id = accountId` UPDATE — the second save
  silently overwrites the first with whatever values that tab loaded, no conflict
  surfaced. Flagged by the Codex adversarial pass as P1; downgraded here because no
  other action in this codebase guards against stale concurrent writes (not even the
  pre-existing `createAccountAction`), so fixing only this one action would be a new,
  inconsistently-applied pattern for a race that needs two simultaneous tabs in a
  single-user local app. Fix, if ever needed: compare a hidden `updatedAt` field
  against the row's current value in the `WHERE` clause and surface a "someone else
  changed this" error on mismatch.

## Follow-ups from the `/ship` pre-landing review (2026-09-03, import-time-categorization undo)

Adversarial review (Claude subagent + Codex `codex exec`, both dispatched during `/ship`)
against the import-time-categorization-undo branch. Two real findings fixed same-branch,
one Codex claim investigated and found to misattribute cause, one theoretical gap
documented rather than fixed:

- [x] Both models independently flagged the same class of bug: the pre-existing
  `autoCategorized` stat tile (`/import/success/[batchId]`) and `categorizedCount`
  (`/sync`, `src/lib/simplefin/undoSync.ts`) count every transaction with a non-null
  `category_id` — including ones the user has since hand-recategorized — while the new
  `revertibleCount` (rule-still-current subset) sits right next to them showing a
  smaller, disagreeing number with no explanation. Cross-model agreement on the same
  bug class is strong signal. Fixed: reworded both pages' new paragraph to state
  `revertibleCount` as an explicit subset ("N of the M auto-categorized/categorised
  rows are still exactly as a trained rule left them") instead of restating the claim
  independently. Did not change `autoCategorized`/`categorizedCount`'s own definitions
  — those are pre-existing, larger blast radius, and out of scope for this branch.

- [ ] **P4** — `undoImportCategorization.ts`'s per-category `inArray(transactionIds)`
  (used for both the stale-row SELECT and the revert UPDATE) would throw "too many SQL
  variables" past SQLite's parameter limit — empirically verified at exactly 32,766
  params on this project's better-sqlite3 (12.9.0). Flagged HIGH by Codex, but
  unreachable at this app's real scale: the actual ledger has 1,178 transactions total
  across its entire history, ~28x short of the limit even if every row ever imported
  landed in one category from one batch. Same unaddressed pattern already exists in
  `undoBulkCategorize` (`inArray(schema.transactions.id, snapshot.txnIds)`), so fixing
  only the new code here would be inconsistent; not fixed. Revisit trigger: if this app
  ever needs to handle an import batch in the tens of thousands of rows, chunk both
  `inArray` calls (e.g. 500 ids per chunk) in both places.

- Investigated and found to misattribute cause, not fixed: Codex flagged `matches()`'s
  `new RegExp(rule.matchValue).test(merchant)` (`src/lib/rules.ts`) as newly "wired into
  both ingestion hot paths" by this branch — verified false by reading `origin/main`
  directly: that wiring shipped in v0.10.0 (the `load-the-ledger` stabilization pass,
  T1), and `matches()` itself is untouched by this branch's diff (which only changed
  `buildRuleMatcher`'s return *type*, not its regex logic). The underlying ReDoS
  exposure is real but pre-existing and already triaged — see the v0.3.0 ship review
  entry above ("ReDoS on user-authored regex-type rules... Single-user, low severity").

## Follow-ups from the 2026-09-03 `/plan-eng-review` triage (starting-balance correctness + tooltip overlap)

Triaged via `/plan-eng-review`: user reported the dashboard trend-chart tooltip
overlapping its own legend (screenshot), then chose to prioritize the two
already-tracked P2 starting-balance correctness bugs above over new
`/categorize` month-scoping work, on the grounds that CLAUDE.md rule 1's money
invariant outranks UX feature work. All three fixed same-session:

- [x] Dashboard "Spending — Last 6 Months" trend chart: hovering a bar showed a
  tooltip that rendered on top of the chart's own Legend when a month had many
  categories (13 in the reported case) — the tooltip's height grew with the row
  count while its vertical position tracked the cursor, with nothing keeping
  the two out of each other's way. Not previously tracked in this file. Fixed:
  `CustomTooltip` (`src/components/ledger/trend-chart.tsx`) now caps itself at
  5 rows plus a "+N more" summary line, and `<Tooltip>` is given `position={{
  y: 8 }}` so it stays pinned near the top of the plot area regardless of
  which bar is hovered (x still tracks the cursor). A second screenshot from
  the same user report caught a related bug in the same component: Recharts'
  default hover-highlight rectangle behind the active bar rendered with its
  stock light-theme fill — a stark white box against this app's dark
  background. Fixed in the same pass: `<Tooltip cursor={{ fill: "var(--border)",
  opacity: 0.5 }}>` reuses the chart's own subtle grid-line color instead of
  Recharts' default. Verified live via `pnpm dev` + browser automation with a
  14-category seeded month: tooltip no longer touches the legend at any hover
  position, and the cursor highlight now reads as a subtle dark tint.

## Follow-ups from the `/ship` pre-landing review (2026-09-03, starting-balance anchor branch)

Claude structured review, Claude adversarial subagent, and Codex adversarial + structured
review (`codex review --base main`) all ran against the branch above. One finding was
independently confirmed by all three passes; two more came from Codex alone:

- [x] **Cross-model confirmed** — anchor-decline warnings were computed but never reached
  the user. `anchorStartingBalance`'s `"rejected"` reason was pushed onto the in-memory
  `warnings` array *after* `import_batches.snapshotWarning` had already been written in
  the same `INSERT`, with no follow-up `UPDATE`. `confirmImportAction` also never reads
  `CommitResult.warnings` — it redirects straight to `/import/success/[batchId]`, which
  only renders the persisted `snapshotWarning` column. Net effect: the exact "silent
  wrong balance" failure mode this session's fix was built to eliminate was still fully
  reachable, just with zero warning instead of a misleading one — and every test in the
  first version of this fix asserted `result.warnings`, never the persisted column,
  which is exactly why it wasn't caught earlier. Fixed: `anchorStartingBalance` now runs
  *before* the batch `INSERT` (it only needs `preview.rows`, already computed outside
  the transaction) so a decline reason folds into the same `snapshotWarning` value the
  insert writes, instead of arriving after that row is already committed. Regression
  tests added asserting `batch.snapshotWarning` directly, not just `result.warnings`,
  for all three warn-and-decline cases. (`src/lib/importBatch.ts`)
- [x] **Codex-only** — the CSV-derived anchor path had no future-date guard, unlike
  `validateUpdateAnchorInput`'s hand-typed-anchor path. A real Star One export can't
  produce a future transaction date, but nothing upstream of `anchorStartingBalance`
  guaranteed that, and a future anchor permanently freezes `loadAccountBalances` (sums
  only rows strictly after the anchor) and silences `/sync`'s drift check for that
  account. Fixed in the same pass as the above, reusing `todayIso()`. Also fixed in the
  same pass: the bounds-rejected warning showed raw cents (`20000000000 cents`) instead
  of a formatted dollar amount — flagged separately by the Claude adversarial pass as a
  minor readability issue now that the message is actually user-visible.
  (`src/lib/importBatch.ts`)
- [x] **P1, pre-existing, NOT fixed on this branch (out of scope)** — Codex flagged that
  `commitImport`'s pending-row-becomes-posted path (`toUpdate`, pre-existing feature, not
  touched by this branch — confirmed via `git diff origin/main` showing zero changes to
  that code) never re-runs transfer pairing for the row it just updated in place.
  `linkTransferPairs(batchId, db)` seeds its search exclusively from rows carrying that
  batch's id among `toInsert`-inserted rows; a re-export whose only new information is a
  pending row posting (`toUpdate`, no `toInsert` rows) never calls it with anything to
  pair, so a real transfer that only became pairable once the pending leg posted can
  stay permanently unpaired and keep showing up as spend in `/budget` and the trend
  chart. Confirmed real by reading the code, not fixed here — unrelated to this branch's
  stated scope (starting-balance correctness + a chart tooltip bug), and fixing it
  properly means auditing `linkTransferPairs`'s row-selection query rather than a
  one-line patch. (`src/lib/importBatch.ts` — `linkTransferPairs`, the `toUpdate` loop)

## Follow-ups from the `/plan-eng-review` triage pass (2026-09-03, TODOS-cross-reference)

Picked up the correctness gaps flagged as ready-to-start with no dependencies:

- [x] **P3** — `scripts/db-paths.mjs`'s missing `DATA_DIR` support (flagged above,
  2026-09-02). Fixed: see the entry under "Follow-ups from the `/plan-eng-review` triage
  pass (2026-09-02)" above, updated in place.
- [x] **P3** — the anchor-date regex's calendar-invalid-date gap (flagged above,
  2026-09-03, debug-sync-balance-check). Fixed: see that entry, updated in place.
- [x] **P1** — the `linkTransferPairs` `toUpdate` gap above, fixed properly rather than
  with a one-line patch as anticipated. `linkTransferPairs` no longer takes a `batchId`
  and queries by `importBatchId` (which a `toUpdate` row never carries — it keeps its
  original batch's id by design, so the success page can attribute it correctly).
  It now takes an explicit `seedRowIds: number[]`, and `commitImport` passes BOTH the
  ids of rows it just inserted AND the ids of rows it just flipped from pending to
  posted (`toUpdate.map(r => r.updateExistingRowId!)`). Verified the fix actually closes
  the gap, not just moves it: reverted the fix locally, confirmed the new regression
  test fails against the old code (`pairsLinked` came back `0` instead of `1`), then
  restored it. New tests in `importBatch.test.ts` (`commitImport — transfer pairing
  re-checks toUpdate rows`): a baseline two-fresh-inserts-across-accounts case, and the
  actual toUpdate regression — a pending deposit posts via a narrow re-export with zero
  new rows, and its real transfer leg (already sitting on the other account, previously
  un-pairable because the pending placeholder transaction number never matches anything)
  is now found and linked. `linkTransferPairs` had zero test coverage in this repo before
  this pass. (`src/lib/importBatch.ts`)
  A `/ship` testing-specialist pass the same day found two more real coverage gaps in the
  same fix, both closed same-branch: no test exercised `commitImport`'s
  `seedRowIds = [...insertedIds, ...toUpdate.map(...)]` merge with BOTH arrays non-empty in
  one call (added a case with a fresh insert and a pending-to-posted update in the same
  file, two separate transfer pairs, asserting both link — a fix that seeded from only one
  array would have found just one pair, not two), and the exported `linkTransferPairs([])`
  early-return had no direct unit test (added one asserting it returns `0`).

- [x] **P2** — Codex adversarial review (same `/ship` pass) found that
  `/import/success/[batchId]` (`src/app/import/success/[batchId]/page.tsx`) recomputed its
  "transfer pairs linked" tile with `COUNT(*) WHERE import_batch_id = batchId` — accurate
  before this branch, because the old buggy `linkTransferPairs` could only ever link rows
  carrying the current batch's id anyway. This branch's own fix breaks that invariant on
  purpose (a `toUpdate` row keeps its ORIGINAL batch id), so the page would now silently
  undercount: a toUpdate-only import that successfully links a pair reports
  `pairsLinked: 1` from `commitImport`, but the success page — which discards that return
  value and redirects, then independently recomputes on its own GET — would show `0`, on
  the exact page meant to confirm the fix worked. Fixed same-branch (not deferred, unlike
  the Red Team findings below): `import_batches` gained a nullable `pairs_linked_count`
  column (migration `0015_early_stardust.sql`, plain `ALTER TABLE ADD COLUMN`, no rebuild),
  written unconditionally by `commitImport` right after computing `pairsLinked` — matching
  the existing `anchoredStartingBalanceCents`/`snapshotWarning` persist-don't-recompute
  pattern in the same table. The success page now reads `batch.pairsLinkedCount` and only
  falls back to the old `COUNT(*)` query when it's `null` (a batch written before this
  column existed, or a sync batch — `syncSimpleFin`'s matcher has no `toUpdate` concept, so
  the batch-scoped count stays exact for it forever and needed no change).
  `importBatch.test.ts`'s toUpdate-gap and combined-merge tests both gained an assertion
  that `pairsLinkedCount` matches the true link count even when zero of the linked
  transactions carry the current batch's id — making the exact bug Codex found
  irreproducible. (`src/db/schema.ts`, `src/lib/importBatch.ts`,
  `src/app/import/success/[batchId]/page.tsx`)

## Follow-ups from the `/ship` pre-landing review (2026-09-04, Red Team pass)

Red Team ran because the diff was 270 lines (over the 200-line threshold). Both findings
below are pre-existing — verified against `origin/main` directly, neither is a regression
from this branch — and were deliberately deferred rather than fixed, to keep this branch's
diff matched to its stated scope (the three fixes above). Confirmed via `/ship` triage
2026-09-04.

- [x] **P3** — `linkTransferPairs` (`src/lib/importBatch.ts`) never filters candidate rows
  on `is_pending`, so a still-`PENDING` row carrying Star One's shared placeholder
  transaction number (`6098`, reused across unrelated pending deposits — CLAUDE.md rule 3)
  is a legitimate ±1 bank-transaction-number match candidate like any real row. If an
  unrelated, already-posted, correctly-unpaired transaction on a different account that
  same date happens to have the same absolute amount, opposite sign, and a real
  `bank_transaction_number` one off from `6098` (plausible under Star One's per-day
  sequential numbering), `findTransferPairs` links them as a false pair — even though
  `6098` was never this row's real sequence position. Once linked, `transferPairId` is
  non-null, so the `isNull(transferPairId)` guard this same function uses for candidacy
  silently excludes the row from ever being re-evaluated once its real posted counterpart
  arrives later — the wrong pairing persists with nothing flagging it as lower-confidence
  than a real match, and both unrelated transactions drop out of every
  `transferPairId`-filtered spend total (`budget.ts`, `loadMonthView.ts`,
  `loadMonthlyTrends.ts`). Never observed in this app's real data — the failure requires an
  unlucky coincidence between an unrelated transaction's real bank transaction number and
  the placeholder value. This exact code shape (no `is_pending` filter on either
  `newRows` or `sameDayUnpaired`) predates this branch; confirmed via
  `git show origin/main:src/lib/importBatch.ts`. Found by Red Team during `/ship`
  2026-09-04. Fixed via `/plan-eng-review` triage 2026-09-04: added
  `eq(schema.transactions.isPending, false)` to the `sameDayUnpaired` candidate query,
  excluding pending rows from candidacy outright — sufficient on its own to close this bug,
  since a pending row can now never become a pair member regardless of how it entered the
  scan. New regression test in `importBatch.test.ts` (`linkTransferPairs` — "never pairs a
  still-pending row carrying the 6098 placeholder...") pins down the exact scenario: a
  pending `6098` deposit and an unrelated posted withdrawal one bank-transaction-number
  away, same date, same `|amount|`, opposite signs, different accounts — asserts neither
  gets a `transferPairId`.
  The initial version of this fix also added the same filter to the `newRows` seed query,
  reasoned as "redundant defense in depth" and shipped with a code comment naming it as an
  intentional, deliberately-undertested coverage gap (chosen over writing a test for it via
  `/plan-eng-review` triage, since the only observable difference was a contrived
  unrelated-pair-links-one-commit-early scenario). Codex adversarial review during the same
  `/ship` run correctly identified that scenario as a real regression, not a contrived one:
  a still-pending seed making `newRows` empty short-circuits the function via the very next
  line (`if (newRows.length === 0) return 0`) **before the date scan ever runs** — silently
  losing the only mechanism that re-checks a date once its own legs' original imports failed
  to pair them (e.g. two rows manually unlinked via "Not a transfer", or any other historical
  gap). That repair trigger is not a one-commit delay, as the original comment assumed — for
  a date nothing else ever touches again, it is permanent. Fixed: removed the `newRows`
  filter, keeping only `sameDayUnpaired`'s. A pending seed can still trigger the same-day
  scan (preserving the repair trigger); it just can never itself be selected as a pair
  member (still closing the original bug). New regression test in `importBatch.test.ts`
  (`linkTransferPairs` — "a pending row's import still triggers repair-linking of two
  unrelated already-posted, previously-unpaired rows sharing its date") reproduces the
  historical-gap scenario via `unlinkTransferPair` and pins the fix: reverting to the
  seed-filtered version makes this test fail (`pairsLinked` 0 instead of 1), confirmed by
  deliberately reintroducing the regression and re-running before restoring the fix.
  (`src/lib/importBatch.ts` — `linkTransferPairs`)

- [x] **P3** — `parseCsv.ts`'s `mmddyyyyToIso` only range-checks the day as 1-31, not
  calendar-aware per month, so a corrupted or hand-edited Star One export row dated e.g.
  `04/31/2026` (April has 30 days) produces the calendar-invalid ISO string `2026-04-31`
  and that row is still inserted into `transactions.date` — unvalidated. This is the same
  class of bug the starting-balance anchor fix above (`z.iso.date()`) closed, but only for
  the one date value used as an account anchor; every other transaction row's date, from
  the same untrusted CSV source, has no equivalent guard. `new Date('2026-04-31')` silently
  rolls over to May 1 rather than throwing, so any code that re-parses the stored string
  via `new Date(...)` would compute a different date than what's stored/displayed, and the
  row would sort inconsistently relative to real dates in a full-date comparison. Not
  touched by this branch (`parseCsv.ts` has zero changes in this diff — confirmed via
  `git diff origin/main --name-only`). Never observed in real Star One exports. Found by
  Red Team during `/ship` 2026-09-04. Fixed via `/plan-eng-review` triage 2026-09-04:
  `mmddyyyyToIso` now validates its candidate ISO string against the shared
  `startingBalanceDateSchema` (`z.iso.date()`, `src/lib/import/accountAnchorFields.ts`) and
  returns `null` on a calendar-invalid result, which the existing caller already turns into
  a `ParseError` ("invalid date: ..."). Regression tests added to `parseCsv.test.ts`: a
  rejected `04/31` (April has 30 days), and a `02/29` that's rejected on a non-leap year but
  accepted on a leap year (confirms the fix doesn't over-reject). (`src/lib/parseCsv.ts`)

## Follow-ups from the `/ship` pre-landing review (2026-09-04, second Red Team pass)

The diff above grew past 200 lines once the `linkTransferPairs` fix was corrected in
response to Codex adversarial review, which re-triggered Red Team dispatch. It found a
real gap the five specialists, the Claude adversarial subagent, and both Codex passes had
all missed — fixed same-branch, via `/plan-eng-review` triage 2026-09-04:

- [x] **P2** — `unlinkTransferPair` ("Not a transfer" — `src/lib/simplefin/sync.ts`) only
  ever cleared `transferPairId` to `null` on both legs, with nothing else recorded. Every
  automatic matcher (`linkTransferPairs` in `importBatch.ts`, `linkTransfersByBucket`,
  `findAmbiguousTransfers` in `sync.ts`) uses `transferPairId IS NULL` as its sole
  eligibility signal for "unpaired, candidate for auto-linking" — so a row the user
  explicitly rejected as a false-positive transfer match was indistinguishable from a row
  that had simply never been evaluated. The very repair-scan mechanism the previous fix in
  this same `/ship` run deliberately preserved (an unrelated row landing on a shared date
  re-triggers a same-day scan) could therefore silently RE-LINK a pair the user had just
  told the app was not a transfer, with zero notification — reversing an explicit user
  correction and quietly excluding both transactions from spending totals again. Confirmed
  pre-existing and unrelated to any earlier fix in this branch: `main`'s `linkTransferPairs`
  had no `is_pending` filter at all (identical risk surface), and `unlinkTransferPair` is
  untouched by every other commit on this branch (`git diff origin/main -- src/lib/simplefin/sync.ts`
  showed nothing before this fix). Found by Red Team during `/ship` 2026-09-04.
  First fix attempt (superseded within the same `/ship` run — see the correction below):
  `transactions` gained a nullable `transfer_rejected_at` timestamp, TRANSACTION-scoped —
  set on both legs, and every automatic matcher excluded any row carrying it. Re-running
  Codex structured review against the grown diff caught a real [P1] in that design before
  it shipped: transaction-scoped rejection means rejecting ONE false-positive match
  permanently blacklists that row from EVER pairing with anything again — including its
  actual correct counterpart, if one exists. Worse, `linkTransferPairManually` (the only
  escape hatch) is reachable exclusively from `findAmbiguousTransfers`'s review queue, and
  the transaction-scoped filter excluded a rejected row from that queue too — so an
  ordinary correction became unrecoverable without a direct DB edit.
  Corrected: replaced the timestamp with a nullable, self-referencing
  `transfer_rejected_partner_id` (migration `0016_tired_thing.sql`, same plain
  `ALTER TABLE ADD COLUMN` shape, no rebuild) — PAIR-scoped, not transaction-scoped.
  `unlinkTransferPair` stamps both legs pointed at EACH OTHER specifically.
  `linkTransferPairManually` clears it on both legs on explicit re-link, same as before.
  The automatic matchers no longer filter CANDIDACY on it (a rejected row stays eligible to
  match something else) — instead, the matching functions themselves take an `isRejected`
  predicate and skip only that exact combination while still searching for a different
  valid partner: `findTransferPairs` (`src/lib/transferPair.ts`, CSV path) checks it
  BEFORE committing a candidate (not after), since a post-filter would still let its greedy
  `used`-tracking consume a row on the rejected match before ever trying the real partner
  sitting right after it in the same bucket. `matchTransfers` (`src/lib/simplefin/matchTransfers.ts`,
  SimpleFIN path) got the same treatment via a new bounded-backtracking
  `assignAvoidingRejections` helper, since its bijection-based bucket matching has an
  equivalent problem at bucket scale (a rejected edge in a balanced 2-vs-2+ bucket could
  silently drop an otherwise-valid bijection for the OTHER rows too) — falls back to
  `ambiguous` only when literally every possible bijection hits a rejection.
  `findAmbiguousTransfers` deliberately does NOT filter the SELECT on the marker (a
  previously-rejected row is allowed to resurface there against a different candidate —
  a human reviewing that queue is not a silent re-link) but DOES pass `isRejected` into
  `matchTransfers`, so the buckets it shows match what `linkTransfersByBucket` actually
  computed at sync time, and a 1-vs-1 bucket whose only pairing was rejected still surfaces
  as ambiguous (not silently dropped) — restoring the one working path back to
  `linkTransferPairManually`. Found by Red Team, then corrected per Codex structured
  review re-run against the grown diff, both during `/ship` 2026-09-04.
  New/updated regression tests: `importBatch.test.ts` ("never re-pairs two rows the user
  explicitly rejected..." — updated for the new field name; "a row rejected against one
  false-positive match can still auto-pair with its real counterpart" — the exact Codex
  scenario, new), `transferPair.test.ts` (`isRejected` skips a combination without
  consuming the row; finds a different valid candidate in the same bucket; default omitted
  parameter rejects nothing), `matchTransfers.test.ts` (1-vs-1 rejected-only bucket becomes
  ambiguous; 2-vs-2 finds the non-rejected bijection instead of dropping everything; 2-vs-2
  where every bijection is rejected becomes fully ambiguous; default parameter unaffected),
  and `sync.test.ts` (`unlinkTransferPair` stamps the marker pair-wise; manual re-link
  clears it; `linkTransfersByBucket` respects it; `findAmbiguousTransfers` still surfaces a
  rejected row when it's the only candidate, and the manual-relink escape hatch still
  works). (`src/db/schema.ts`, `src/lib/simplefin/sync.ts`, `src/lib/simplefin/matchTransfers.ts`,
  `src/lib/importBatch.ts`, `src/lib/transferPair.ts`, `drizzle/0016_tired_thing.sql`)

- [x] **P2** — Re-running Codex structured review against the corrected (pair-scoped) fix
  above found one more real gap: `linkTransferPairManually`'s clear of
  `transferRejectedPartnerId` on explicit re-link was unconditional, so linking A to a
  THIRD row C would also erase A's memory of having rejected B specifically — not just
  clear the A↔B rejection this link doesn't even concern. If B later has its own marker
  independently cleared the same way (linked to some other row D), and either C's or D's
  link is later undone, A and B could end up back at fully-unpaired with neither side
  remembering the original rejection, silently reopening the exact false-relink risk the
  whole feature exists to close. (Also flagged: a `[P1]` claiming the `0016_tired_thing.sql`
  migration was missing from the diff — investigated and found to be a review-tool
  artifact, not a real gap: `codex review`'s `git diff <base>` only sees tracked changes,
  and the migration file was genuinely present on disk with real content, just not yet
  `git add`ed at review time; resolves once `/ship`'s own commit step stages it.) Fixed:
  the clear is now conditional — `transferRejectedPartnerId` is nulled only when it
  currently equals the specific row being linked, otherwise left untouched. New regression
  test in `sync.test.ts` ("manual link to a different row does NOT clear a rejection
  recorded against a third row"), mutation-verified: reverting to the unconditional clear
  makes it fail (`null` instead of the third row's id), confirmed by deliberately
  reintroducing the bug and re-running before restoring the fix. Found by Codex structured
  review during `/ship` 2026-09-04. (`src/lib/simplefin/sync.ts`)

- [x] **P3** — A fresh testing-specialist pass over the full grown diff found that
  `assignAvoidingRejections`'s actual backtracking path (undoing a locally-successful
  assignment because a later positive turns out to have no valid partner) was never
  exercised — every existing test used bucket sizes ≤2, which resolve via a single
  try-next-candidate step and never reach the `assignment.pop(); remaining.splice(k, 0, b)`
  undo lines. Added a 3-vs-3 `matchTransfers` test where the first positive's preferred
  partner succeeds locally but forces the second positive into a dead end, so a valid
  assignment only exists by backtracking off that first choice. Mutation-verified: removing
  the `remaining.splice(k, 0, b)` restore line makes the test fail, confirmed by
  deliberately reintroducing the bug and re-running before restoring the fix.
  (`src/lib/simplefin/matchTransfers.test.ts`)

## Follow-ups from the `/pr-review-toolkit:review-pr` pass on PR #34 (2026-09-04)

Four specialist agents (code-reviewer, pr-test-analyzer, silent-failure-hunter,
comment-analyzer) reviewed the full PR #34 diff. All findings fixed same-branch:

- [x] **P1** — `drizzle/0016_tired_thing.sql` added `transfer_rejected_partner_id` via
  plain `ALTER TABLE ADD COLUMN ... REFERENCES transactions(id)` with NO `ON DELETE`
  clause, so SQLite defaulted it to `NO ACTION` — even though `schema.ts` declares
  `{ onDelete: "set null" }` and the Drizzle snapshot agreed with `schema.ts`, only the
  actual migration SQL was wrong (apparent drizzle-kit generation gap for FK-bearing
  `ADD COLUMN`, since a FK declared inline on `CREATE TABLE` — e.g. `transfer_pair_id` in
  `0000_thin_mandroid.sql` — does get the clause correctly). Reproduced directly against a
  real migrated in-memory DB: `PRAGMA foreign_key_list` showed `on_delete: 'NO ACTION'` for
  the new column, and deleting a batch containing a row referenced by a surviving row's
  `transfer_rejected_partner_id` threw `FOREIGN KEY constraint failed` instead of nulling
  the survivor's marker. Hits `undoSyncBatch` (`src/lib/simplefin/undoSync.ts`), whose own
  comment claims reliance on `SET NULL` (same pattern as the pre-existing `transfer_pair_id`
  column) — trigger sequence: sync auto-links a feed row to an older CSV row → user clicks
  "Not a transfer" → user clicks "Undo this sync" → throw, taking the undo button and
  balance check down with it (violates the CLAUDE.md `/sync` rule that every sync action
  returns state rather than throwing). Not caught by any existing test: nothing combined
  `unlinkTransferPair` with a cross-batch `undoSyncBatch`. Fixed by adding
  `ON UPDATE no action ON DELETE set null` to the migration SQL directly (safe to edit in
  place rather than issue a corrective migration — confirmed this migration had not yet been
  applied to any local `data/money.db`). SQLite does support an inline `ON DELETE` clause on
  `ALTER TABLE ADD COLUMN` (verified directly), so no table rebuild via `scripts/migrate.mjs`
  was needed here, unlike CLAUDE.md rule 7's `NOT NULL`-relaxation case. New regression test
  in `undoSync.test.ts` ("undoing a sync batch nulls a surviving row's rejection marker
  instead of throwing a FK violation"), confirmed failing against the original migration SQL
  before the fix and passing after, via a temporary `git stash` of just that file.
  (`drizzle/0016_tired_thing.sql`, `src/lib/simplefin/undoSync.test.ts`)

- [x] **P3** — `isRejectedPair` (`sync.ts`) and the equivalent inline lambda
  (`importBatch.ts`) both check `a.marker === b.id || b.marker === a.id`, but every existing
  test seeded the rejection via `unlinkTransferPair`, which always writes both legs
  symmetrically — so no test could tell the OR apart from either half alone; a future
  refactor could silently drop one clause with all 642 tests still green. Added two tests
  per call site, each seeding the marker directly on only ONE leg (bypassing
  `unlinkTransferPair`) to isolate each half of the OR. Mutation-verified all four: reverting
  each predicate to only one clause makes exactly the test for the OTHER clause fail, the
  matching one stays green — confirmed by deliberately weakening each clause and re-running
  before restoring. (`src/lib/importBatch.test.ts`, `src/lib/simplefin/sync.test.ts`)

- [x] **P3** — A rejected pair becomes a permanent, unresolvable-looking item in the
  "Transfers needing review" queue: `findAmbiguousTransfers` deliberately doesn't filter its
  SELECT on the marker (by design — a human reviewing that queue is not a silent re-link),
  but the review UI (`app/sync/page.tsx`) offered only one action ("Link as transfer") and
  one static explanation ("the counts don't balance") for every bucket — wrong copy for a
  rejection-derived bucket, where the counts balance fine and the actual reason is the
  user's own earlier correction. Added a `reason: "contested" | "unbalanced" | "rejected" |
  "cross-source"` field to `AmbiguousBucket` (`matchTransfers.ts`), set at each of the four
  push sites (the fourth, "cross-source", was an existing but previously-unlabeled case: the
  cross-source adjudication guard). The review page now renders per-bucket copy keyed on
  `reason`, and the button reads "Link as transfer anyway" specifically for the rejected
  case. Deliberately did NOT add a dismiss/acknowledge action — that would contradict the
  already-established design (this same PR's own regression test, "findAmbiguousTransfers
  still surfaces a rejected row when it's the only candidate pairing available") that a
  rejected row must stay visible in case a different real candidate ever appears; accurate
  copy addresses the confusion without reopening that design decision. New assertions added
  to the existing tests covering each of the four reasons in `matchTransfers.test.ts`.
  (`src/lib/simplefin/matchTransfers.ts`, `src/app/sync/page.tsx`, `src/lib/simplefin/matchTransfers.test.ts`)

- [x] **P4** — Two stale comments left over from earlier iterations of this same PR (it went
  through ~6 rounds of review): the `schema.ts` comment on `transferRejectedPartnerId`
  claimed `linkTransferPairManually` "clears it on both legs" unconditionally — actually
  conditional (only when it currently points at the partner being relinked), contradicting
  the correct inline comment in `sync.ts` and its own dedicated test. And
  `importBatch.test.ts` referenced a nonexistent `transferRejectedAt` column name (predates
  the pair-scoped rename to `transferRejectedPartnerId`). Both fixed. Also fixed: a
  misplaced comment in `transferPair.test.ts` justifying "row 3" backtracking-avoidance that
  was attached to the wrong test (a 2-row test with no row 3 — the row-3 scenario is the
  *next* test); and `matchTransfers.ts`'s `assignAvoidingRejections` docstring misattributed
  its algorithmic safety to the "3+ accounts" guard, which bounds distinct accounts per
  bucket, not rows per direction — the real reason backtracking stays fast is that the
  rejection marker is single-valued (out-degree ≤ 1 per row), noted explicitly so the
  comment doesn't go stale if that column is ever made multi-valued (see the P3 below).
  (`src/db/schema.ts`, `src/lib/importBatch.test.ts`, `src/lib/transferPair.test.ts`,
  `src/lib/simplefin/matchTransfers.ts`)

- [ ] **P3** — `transfer_rejected_partner_id` is single-valued, so a row remembers only its
  MOST RECENT rejection. If a row is later paired-then-rejected against a different partner,
  the earlier rejection is silently overwritten; after both legs of an original A↔B
  rejection have each independently been re-rejected against something else, the original
  correction is gone entirely and the automatic matchers can re-link A↔B. Needs four
  rejections across two rows to hit — low probability for a single-user app — and a
  multi-valued rejection store (join table) is likely overkill for the value it adds, so
  documented rather than fixed: see the `KNOWN LIMITATION` comment on the schema column and
  the caveat added to CLAUDE.md rule 4. Revisit if this is ever actually hit in practice, or
  if `assignAvoidingRejections`'s near-linear-backtracking assumption (which depends on this
  column staying single-valued) is ever challenged by real bucket sizes growing past 2-3 rows
  per direction. (`src/db/schema.ts`, `CLAUDE.md`)

## Follow-ups from the `/plan-eng-review` pass (2026-09-04, envelope-budgeting plan)

Surfaced while reviewing [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md) (zero-based / EveryDollar-style budgeting, PR1 + PR2). None of these are closed by that plan; all five were captured deliberately rather than folded into scope.

- [ ] **P2** — **"Spent" means two different things depending on which page you are on.** `computeMtdSpent` (`src/lib/budget.ts:161`) returns a signed sum, so a refund *reduces* category spend on `/budget`. `loadMonthlyTrends` (`src/lib/trends/loadMonthlyTrends.ts:89`) filters `amount_cents < 0`, so the same refund is *invisible* on the dashboard trend chart. `loadGoals`' withdrawal query uses `< 0` as well. A $50 grocery refund therefore produces two different September grocery totals depending on which page you open, and nothing documents which is intended. The `/plan-eng-review` D5A decision extracted the genuinely shared half (a `categoryMonthPredicate` carrying the `transfer_pair_id IS NULL` + date-window SQL) and deliberately left the sign handling explicit at each call site with a comment naming its convention — precisely so this stays a visible product decision instead of being silently unified by a `mode` flag. What remains is picking a convention. Either answer moves an existing page's numbers, so it is worth deciding after a month of real use rather than now. (`src/lib/budget.ts`, `src/lib/trends/loadMonthlyTrends.ts`, `src/lib/goals/loadGoals.ts`)

- [ ] **P2** — **PR3: fund behavior unification.** The `kind='fund'` *column value* ships in PR1 (decision D1B, backfilled from `is_savings_goal`), so this item is behavior only, not a data migration. Three things are still open: (a) funds should render as budget rows the way EveryDollar's Funds do, instead of living exclusively on `/goals`; (b) `loadGoals` (`src/lib/goals/loadGoals.ts:37`) computes progress from `SUM(budget_periods.allocated_cents)` — money *planned*, not money that moved — so a goal reads $1,200 saved after six months of $200 allocations you then spent on groceries. PR1's D11A only *hides* the progress bar and percent-complete rather than fixing the math, so the false number is off-screen, not gone; (c) open question O2 — when you overspend a Fund, does the negative carry forward or reset? Deferred by scope decision `0e52e0af` specifically so it lands after the `TODOS.md` integration checkpoint (use the app on real data for a week), because it reinterprets goal data you already have. Blocked by: PR1 + PR2 shipped, plus one month of real fund use. (`src/lib/goals/loadGoals.ts`, `src/app/goals/page.tsx`, `src/lib/budget/loadMonthView.ts`)

- [ ] **P3** — **Split transactions conflict with the V1 exclusion list; decide, do not drift.** `CLAUDE.md`'s "What's NOT in V1" section lists "Split transactions (one category per transaction; override wins)" as a deliberate exclusion. EveryDollar has them, and after PR1 + PR2 this is the largest remaining fidelity gap: a $180 Costco run that is half groceries and half household goods must pick one envelope, which is the most common real-world reason a zero-based budget drifts from what actually happened. This is the single biggest item on this list — it touches the transactions schema, every sum in `src/lib/budget.ts`, categorization and its undo paths, and the dedup invariants in `CLAUDE.md` rules 3 and 4. Captured here so it becomes an explicit decision later rather than something that gets silently added because it seemed necessary mid-implementation. Blocked by: PR1 + PR2. (`src/db/schema.ts`, `src/lib/budget.ts`, `src/lib/categorize/`)

- [ ] **P3** — **Drop `categories.is_savings_goal` once PR1's read migration has settled.** PR1 decision D10A repoints **all seven** readers from the boolean to `kind` (`loadMonthView.ts:86`, `loadGoals.ts:44`, `loadMonthlyTrends.ts:61`, `categories.ts:40,43`, plus the three guards eng review round 2's decision A2 found this entry had missed: `categorizeTransaction.ts:71,77`, `bulkCategorize.ts:90,96`, `goals/actions.ts:41`), but `createGoalAction` (`src/app/goals/actions.ts:18`) keeps dual-writing it so the column stays truthful for anything not yet migrated. That leaves a write-only column, which is a trap for whoever reads the schema next and assumes it still means something. Removing a `NOT NULL` column in SQLite needs a table rebuild, so this must go through `scripts/migrate.mjs` with the `PRAGMA foreign_keys` handling described in `CLAUDE.md` rule 7 — not `drizzle-kit migrate`. Bundle it into PR3's migration rather than spending a rebuild on it alone. Blocked by: PR1 (D10A) shipped. (`src/db/schema.ts`, `src/app/goals/actions.ts`, `drizzle/`)

- [ ] **P4** — **Record the forgive-overspend rollover behavior as a decision, or change it.** `getEffectiveAllocation` (`src/lib/budget.ts:82`) computes `rolloverCents = Math.max(0, prior.effectiveCents - priorSpent)`, so overspending a rollover envelope by $300 vanishes at the month boundary and the next month opens clean. That is a defensible product call — EveryDollar's Funds go negative, YNAB makes you cover the overage explicitly, and forgiving it is a third valid option — but nothing in the code, the tests, or the docs says it was chosen rather than added to avoid a negative number. `/plan-eng-review` task T12 adds the rationale comment; what stays open is the underlying product question (O2 in the plan), which is best answered from real fund usage rather than in the abstract. (`src/lib/budget.ts`)

## Follow-ups from the `/plan-design-review` pass (2026-09-04, envelope-budgeting plan)

Design debt surfaced while reviewing [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md). The plan itself absorbed 24 design decisions (D1A-D24A); these four were deliberately left out of its scope.

- [ ] **P2** — **Dashboard card-stack redesign.** Codex hard-rejected `src/app/page.tsx` on two criteria during the design review: "generic SaaS card grid as first impression" and "app UI made of stacked cards instead of layout". Accounts, monthly summary, trends, backlog and quick links are all just vertically stacked cards, so the first screen of the app reads as stock shadcn rather than Ledger Paper. The fix is an information-architecture change, not a token swap: one dominant anchor (probably Left to Budget or a "budget complete" state once PR1 ships it) with a single next action, account tiles demoted to a compact ledger list, trends and backlog moved into secondary panes. Deliberately excluded from the envelope-budgeting plan — decision D9A restyles `/budget/[year]/[month]` only, because the dashboard has its own IA problem that a token substitution will not fix and it deserves its own mockup round. Blocked by: PR1 shipped, so there is a Left to Budget number available to anchor on. (`src/app/page.tsx`, `DESIGN.md`) **When this lands, also delete `SummaryStrip`'s `variant="plain"` (plan decision DS45).** PR1b extracts `SummaryStrip` and renders it on both surfaces; the `plain` variant exists only so this page is not left half-restyled while it waits for its own mockup round. Both callers pass `ledger` once the dashboard is done, the prop goes, and DS39's single ruled strip becomes unconditional. Grep `variant=` in `src/app/page.tsx` and `src/app/budget/[year]/[month]/page.tsx` to confirm the call sites before removing. (`src/components/ledger/summary-strip.tsx`)

- [ ] **P2** — **App-wide Ledger Paper adoption is ~15%.** Measured 2026-09-04, Ledger Paper tokens vs shadcn defaults per page: `/` 13:24, `/subscriptions` 4:25, `/goals` 2:38, `/transactions` 1:1, `/sync` 1:66, `/categorize` 0:2, `/import` 0:13, `/budget/[year]/[month]` 0:35. The tokens all exist (`globals.css` defines 50 of them), `DESIGN.md` documents them, and `design_handoff_nav_and_design_system/` has live HTML specimens — the system was designed and then largely not adopted. Note this gets *more* visible after decision D9A, not less: the budget page becomes the only fully on-system surface, so every other page will look like a different app. Migrate worst-first (`/sync` at 1:66, then `/goals`, then `/subscriptions`); `/transactions` at 1:1 is nearly untouched and is the cheapest place to establish the pattern. Mechanical className substitution, no behavior change, no new tests — which is also why nothing will force it to happen. Blocked by: D9A landing first as the reference implementation. (`src/app/**/page.tsx`, `src/app/globals.css`, `DESIGN.md`)

- [ ] **P3** — **`DESIGN.md` has no motion vocabulary and is about to acquire one animation.** Decision D6A′ adds the app's first and only motion: on transition into the Left to Budget success state, the numeral settles to ledger green over ~240ms and the check draws in, honoring `prefers-reduced-motion`, never firing on page load. `DESIGN.md` currently documents fonts, color tokens, radii, shadows and spacing cadence but says nothing about motion, so this token has no home and the next component that wants a transition will invent its own easing and duration. Add a Motion section naming the duration, the easing curve, the reduced-motion rule, and the principle that motion marks a state *transition* the user caused rather than decorating a render. One paragraph. Blocked by: D6A′ implemented, so the values are real rather than guessed. (`DESIGN.md`, `src/components/ledger/left-to-budget.tsx`)

- [ ] **P3** — **`src/app/sync/error.tsx` is the only error or loading boundary in the app.** Verified 2026-09-04: `find src/app -name 'error.tsx' -o -name 'loading.tsx'` returns exactly one file. Decision D24A adds an `error.tsx` for `/budget/[year]/[month]` because the allocation action changes from throwing to returning state and a thrown action inside a client island would otherwise take out the whole month editor. Every other route — `/transactions`, `/categorize`, `/import`, `/goals`, `/subscriptions` — still shows Next's default error screen on a throw and a blank page during a slow query. `CLAUDE.md` already documents the return-state-not-throw posture for `/sync` and explains why (several failures are reachable from ordinary use, and a throw takes out unrelated controls on the same page); that reasoning generalizes. Worth building the `∅` / `!` / `◐` state cards `DESIGN.md:184-190` already specifies as shared components first, so this is seven thin files rather than seven copies. (`src/app/*/error.tsx`, `src/app/*/loading.tsx`, `DESIGN.md`)

## Follow-ups from the `/plan-eng-review` round 2 pass (2026-09-04, envelope-budgeting plan)

Second eng review of [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md), run after the design review added 13 tasks and re-specced PR2's editor. 30 decisions were folded into the plan; these three were captured deliberately rather than folded into scope. (The fourth, month-scoping, amends the existing entry above rather than duplicating it.)

- [ ] **P3** — **PR3: drop `effective_allocation_cents` and the whole `invalidateForwardRollover` mechanism.** After PR1a this is a column that eight code paths write NULL into and nothing can read. Task T8 replaces the per-leaf rollover recursion with a set-based clamped prefix scan, removing the column's last reader-that-could-hit; decision TS1 then deletes `getEffectiveAllocation`'s `persist` option, removing the last writer of a non-NULL value. So `budget.ts:60`'s cache-hit branch becomes unreachable while `upsertAllocation`, `categorizeTransaction`, `bulkCategorize`, the three undo paths, `setCarryoverPolicy` and `setCategoryKind` all keep faithfully clearing it — PR2a's `copyPreviousMonth` fires the batched version across 40 categories per use. Decision P3 deliberately kept the code rather than ripping out eight call sites inside the PR that was split to bound its blast radius, and because PR3's fund work may legitimately want a real cache, in which case deleting the column now becomes a migration to add it back. What this entry exists to prevent: B5 hid for five releases because nobody wrote down that a column had no writers. This is the same shape read backwards — writers, no readers — and it needs the same explicit record. Task T10 rewrites the JSDoc to say the read branch is unreachable rather than adding a fourth trigger to a contract for a no-op. Trigger to act: PR3, or any decision to give funds real carry-forward behavior. Blocked by: PR3 fund semantics, which itself waits on the integration checkpoint above. (`src/lib/budget.ts`, `src/lib/budget/upsertAllocation.ts`, `src/lib/categorize/`, `src/db/schema.ts`)

- [ ] **P3** — **Delete `classifyCategory` and its `LeafLookup` type, or give them a caller.** `src/lib/categories.ts:61` exports `classifyCategory`, and `grep -rn 'classifyCategory' src/ | grep -v test` returns only the definition — zero non-test callers. Its `LeafLookup` type (`categories.ts:50-52`) also exposes `isSavingsGoal`, which makes it an eighth surface reading the boolean that decision A2 is retiring; PR3's "drop the column, no behavior change" would silently break it. This is the third instance of the same pattern in this codebase (`applyRuleAtImport` shipped in v0.3.0 with no callers and produced a 498-row backlog; `effective_allocation_cents` had no writers for five releases), which is worth noticing as a pattern rather than three coincidences. Deliberately not folded into A2's seven-site sweep: deleting a function that has tests deserves its own look rather than riding along in a mechanical repoint, because the tests are the reason it reads as intentional. Start by checking whether it was written for a caller that never landed. Depends on: nothing; could ride with PR1a's T5 if you decide quickly. (`src/lib/categories.ts`)

- [ ] **P3** — **O1: is `Reimbursement` income, or an expense that nets against itself?** Migration `0017` backfills `Reimbursement` (category id 42) to `kind='income'` on EveryDollar's model. The alternative is expense-kind, where its positive rows net against that same category's spending — which is better if a reimbursement usually offsets a specific expense you already categorized. This matters more than it looks because the choice is close to irreversible in-app: decision X1 only permits an expense→income kind change on a category whose transactions are *all positive*, and a reimbursement category will hold both signs, so once it is used you cannot flip it without creating a new category and re-categorizing. Nothing is at stake yet — it currently holds zero transactions — which is exactly why this needs a deliberate answer before it accumulates any. Check after a month: if most rows in it pair with an expense you already categorized elsewhere, the seed is wrong. Blocked by: the integration checkpoint (one week of real use). (`drizzle/0017_category_kind.sql`, `src/lib/budget.ts`)

## Follow-ups from the `/plan-eng-review` round 3 pass (2026-09-04, envelope-budgeting plan)

Third eng review of [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md), run after design review round 2. 15 decisions (`E1`-`E15`) were folded into the plan; one was captured here instead, and one amends the dashboard entry above rather than duplicating it. Codex ran as the outside voice against the repository rather than the plan text and independently found four of the five architecture findings.

- [ ] **P4** — **O5: when a rollover category has no `budget_periods` row for a month, should its accumulated balance reset to zero?** That is what happens today. `getEffectiveAllocation` (`src/lib/budget.ts:56`) returns `null` when the target month has no row, so the recursion's `if (prior)` guard at `:80` contributes `rolloverCents = 0` and the chain terminates. Fund $200/month for six months, skip funding it in November, and December opens at $200 rather than $1,200 — the balance is not clamped, it is erased. **This is a different mechanism from the forgive-overspend entry above** (`P4`, `Math.max(0, prior.effectiveCents - priorSpent)`): that one forgives money you *spent*, this one discards money you *did not touch*, and it fires on an absent row rather than a negative remainder. Worth keeping separate for that reason — they will probably be answered together at PR3, but merging them now is how the second one gets answered halfway. Currently latent: all 50 seeded categories are `carryover_policy: 'none'`, verified by probe, so no real balance is at stake yet. Plan decision E4 requires `P1`'s set-based prefix scan to reproduce the behavior exactly and adds the skip-month fixture to `TC30` that the existing oracle set never had (`budget.test.ts:311` is a chain-*start* case, not a mid-chain gap) — so by PR3 the behavior is pinned either way and what stays open is purely whether it is the behavior you want. Task T10 writes the rationale comment beside B3's, at the `if (prior)` guard. Blocked by: the integration checkpoint (one week of real use), then PR3 fund semantics — same gate as O2. (`src/lib/budget.ts`, `src/lib/budget/loadMonthView.ts`)
