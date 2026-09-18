# Todos

Short-term checklist. For the full roadmap see [PLAN.md](./PLAN.md). For context and design decisions see `.context/notes.md` — note `.context/` is gitignored (it holds real bank data), so it exists only on a machine where those artifacts were generated.

**Cross-reference entries by TITLE, never by line number.** This file is edited constantly, so a `TODOS.md:1165` pointer is a broken link waiting to happen — and it does not fail loudly, it silently starts naming a different entry. The 2026-09-09 audit found four such pointers already aimed at the wrong item, one of them at an entry that was about to be deleted. Quote the target entry's bolded title instead; it survives every edit above it.

**Also: verify before scheduling.** The same audit found 5 entries describing work that had already shipped, 15 duplicate clusters, and one real open item hidden behind a `[x]`. Every drift it found flattered the backlog — none understated progress. Re-measure an entry's premises against the live ledger and the code before acting on it.

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
- [x] Merchant normalizer in `src/lib/normalize.ts` — four-phase pure-function pipeline, Vitest-covered
- [x] Merchant-key backfill (`pnpm db:backfill-merchants`) — renormalizes rows and rewrites trained rules; see `docs/plans/merchant-normalization.md` T4
- [ ] `docs/plans/merchant-normalization.md` T3 / T5 / T6 — alias table, alias CRUD, re-run auto-categorization over the backlog. **Priority:** P2. T3 was measured worth only ~5 groups, so re-justify before building it.
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
- [x] shadcn components locked: Table (`/budget`), Dialog (allocate; also the `/accounts` charge dialog), Sonner (toasts), Combobox (inline picker on `/categorize` + `/transactions` via shared `CategoryCombobox`), **DropdownMenu** (the budget row `⋯` menu, and the `/transactions` row `⋯` menu added for "Mark as payment to →"). No TanStack per Track A decision; `table` is the shadcn primitive, not DataTable. Note the DropdownMenu wrapper is hand-written over Base UI `Menu`, not shadcn-generated — it has no entry in `components.json`'s registry set.
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
- [x] **P1 — DONE (2026-09-08)** — The relink fix stopped the crash but not the double-count it was meant to prevent, because the crash fix WAS the cause: clearing `external_id` erased the only record of which feed a row came from, and `sync.ts`'s content-dedup fallback is scoped to the account being synced, so account B claiming a feed account A used to hold re-imported every row fresh and silently. Fixed by recording provenance instead of erasing it. New nullable `transactions.simplefin_source_account_id` (migration `0020`, hand-edited — the generated SQL had no backfill, and without one SQLite's NULLs-are-distinct rule would have defeated the new unique index for every existing row AND made all 35 of them invisible to the id pass, re-importing them on the very next sync: the exact double-count, caused by its own fix). The partial unique index moved from `(account_id, external_id)` to `(simplefin_source_account_id, external_id)` — scoped by FEED, which is what a SimpleFIN id is actually unique within; `account_id` was only ever a proxy, and a wrong one the moment a link moves. `setAccountLink` no longer clears anything. The backfill joins through `accounts.simplefin_account_id`, which is normally the wrong question, and is exact HERE only because the old clearing means a row that still carries an `external_id` has not been through a relink — that argument is written into the migration header and is why nothing could repair a row already stripped. The ship review found the limit of that argument and it is now stated rather than glossed: `setAccountLink` only began clearing in v0.8.3 (`ca53e68`), five hours after sync shipped in v0.8.0 (`28aa181`), so a relink in that window would have left the tag intact. Checked against the live ledger immediately before applying: 0 rows with an `external_id` on an unlinked account, so the backfill is exact here — and the class is now closed in code anyway (below) rather than resting on the check. Verified against a `VACUUM INTO` copy of the live ledger: 1,562 rows preserved, 35 backfilled across both real feed ids (11 + 24), 0 tagged-without-provenance, 0 provenance-without-tag, `integrity_check` ok, `foreign_key_check` clean. Chosen over the two options this entry originally proposed: (a) a `/sync` review list for orphaned rows only DETECTS the corruption, the same posture as the unenforced prose warning it would replace; (b) reassigning `account_id` on relink is documented right here as only round-tripping when an account was linked to exactly one feed in its life, and the clearing is exactly what destroyed the evidence needed to check that — (b) becomes safe as a later follow-up now that provenance exists. One regression was caught during implementation and is covered: re-running `pnpm simplefin:claim` mints FRESH feed ids for the same real bank account, so the id pass cannot match; the content-dedup fallback therefore now accepts rows tagged with a DIFFERENT feed, not just untagged CSV rows, which the pre-fix clearing had been providing by accident. `sync.test.ts`'s pinning test ("known P1 gap") is inverted rather than deleted; `link.test.ts`'s clearing tests now assert preservation, one covers the one unrepairable residue (LEGACY orphans stripped before the column existed, which `setAccountLink` still warns about and which can only ever shrink), and a second `describe` block pins the warning query's own predicates. A second correctness fix came out of the ship review and is the reason this entry is longer than the fix: content-dedup candidacy has to test `simplefin_source_account_id IS NULL` as its OWN case. `ne()` is SQL `<>`, and `NULL <> 'ACT-1'` is NULL rather than true, so a row carrying an `external_id` with no provenance tag matched neither dedup pass AND was unprotected by the partial unique index (SQLite NULLs are distinct) — it would have re-imported on every sync. `0020`'s backfill produces exactly that row for a sync row on an unlinked account. Also `syncSimpleFin`'s insert now writes the non-null `feedId` binding threaded through `Staged`, not the nullable `account.simplefinAccountId`, so the app itself cannot mint one and tsc rejects a refactor that tries. 1,662 tests pass, `tsc --noEmit` clean. (`src/db/schema.ts`, `drizzle/0020_happy_mojo.sql`, `src/lib/simplefin/link.ts`, `src/lib/simplefin/sync.ts`)
- [x] **P2** — `syncNowAction` discards `outcome.warnings`. Fixed: `SyncActionState` carries `warnings` and a `warning` status, rendered by `ActionStatus`. A sync carrying warnings is never shown as a plain success, so a dark account can no longer report "Already up to date." (`src/app/sync/actions.ts`)
- [x] **P3** — Test gaps: `warnings[]` forwarding, the pending-row refusal, the cross-source candidacy guard, the whitespace dedup case, the out-of-window dedup case, unlink round-trips and WAL snapshot consistency are all covered (375 → 402 tests). Still uncovered: `findAmbiguousTransfers`'s window + stateless-resolution contract, and a non-zero `driftCents` case. (`src/lib/simplefin/`)

## Follow-ups from the `/ship` pre-landing review (2026-09-09, fund-usage-pass + drop-dead-rollover-cache)

The pre-landing review army caught one CRITICAL that was fixed in-branch: the round-5 fund clamp had been applied to `loadRolloverEffectiveByCategory` (the set-based render path) but NOT to `getEffectiveAllocation` (the per-category scalar read `upsertAllocation` returns), so a rollover fund's carried balance was correct on page load and inflated the moment the user typed into the Allocate cell. Both now route through `spendIgnoresPositiveRows`. Seven items were deferred out of this section. Six have since been closed or merged elsewhere and were struck by the 2026-09-09 audit: the X1 row-menu confirmation shipped in v0.26.0; the composite index, the container snapshot slot, `revalidateBudgetSurfacesAction` (both halves) and `liveAssignableKinds` were each filed a second time in a later section and are merged there. One remains here.

- [ ] **P3** — **`loadReclassifyCandidates` re-derives the usage MEASUREMENT that `loadCategoryKindUsage` now owns.** `categoryKindLock.ts` is the ONE spelling of rule 8's *policy*, but `setCategoryKind.ts`'s picker query still computes the same two facts inline — a grouped `negativeCount` over transactions and a `selectDistinct` over `budget_periods` — then applies its own `allPositive` and `!plannedCategoryIds.has(...)` tests. The picker being *stricter* than the writer is deliberate and documented; what is not deliberate is that a change to how "used" is MEASURED still has to be made twice. Source the three counts from `loadCategoryKindUsage` and keep only the stricter filter local. Found by the Maintainability specialist during `/ship` 2026-09-09. (`src/lib/budget/setCategoryKind.ts`)

## Follow-ups from the `/ship` pre-landing review (2026-09-08, feed-provenance branch)

Fixed on this branch, listed so the reasoning is findable:

- [x] **P1** — Content-dedup candidacy used `ne(simplefin_source_account_id, feedId)` alone, and SQL `NULL <> 'ACT-1'` is NULL rather than true. A row carrying an `external_id` with NO provenance tag therefore matched neither dedup pass, and the partial unique index could not stop its re-insert either because SQLite treats index NULLs as **distinct** — it would have re-imported on every sync, silently double-counting real money. Migration `0020`'s backfill produces exactly that row for a sync row whose account is currently unlinked, and the header's "a row still carrying an external_id has never been through a relink" argument does not cover it: `setAccountLink` only began clearing in v0.8.3 (`ca53e68`), five hours after sync shipped in v0.8.0 (`28aa181`). Measured 0 such rows on the live ledger before applying `0020`, but an unlink on `/sync` is one click, so this is closed in code: `isNull(simplefin_source_account_id)` is now its own arm of the `or()`. Found by the data-migration and security specialists independently. General rule, now in CLAUDE.md rule 3: **a three-valued `<>` is not the complement of `=`** — any "everything except mine" predicate on a nullable column needs its `IS NULL` arm written out.
- [x] **P2** — `syncSimpleFin`'s insert wrote `account.simplefinAccountId` (typed nullable) rather than the non-null `feedId` the dedup predicates keyed off. Same value, but it was the one write path that could ever mint the untagged row above. `feedId` now rides on the `Staged` type, so the value that decided a row was new is the value stored as its provenance, and tsc rejects any refactor that lets a null through.
- [x] **P3** — Doc accuracy: `PLAN.md` gate #1 read CLOSED while `sync.test.ts` pinned a still-open path (re-minted feed + a *different* local account); the gate now names that boundary. `link.ts`'s comment claimed content dedup gives legacy orphans a partial safety net, but `existingByContent` is `account_id`-scoped, so a different account claiming the feed cannot see them at all — comment and user-facing warning both corrected from "may not recognize" to "will not". `schema.ts`'s `transactions_feed_source_idx` comment claimed to back the dedup lookup; three specialists verified with `EXPLAIN QUERY PLAN` that the partial unique index covers that query, so the comment now says forward-looking and explicitly not load-bearing.

Open:

- [ ] **P3** — Sync makes an untagged row (external_id set, provenance NULL) a content-dedup *candidate* but never *repairs* it, so the row leans on content dedup forever — exact-signature, account-scoped and 45-day-bounded — while staying outside the id pass and outside the partial unique index (NULLs distinct). Failure shape: it survives one sync by content match, MX then revises the description on a later re-send, the signature `date|amount_cents|raw_memo` no longer matches, and it inserts a second time with no error. The convergent fix is cheap and evidence-based rather than a guess: in the same pass, for any untagged row whose `external_id` the current feed actually sends in this run, UPDATE its provenance to `feedId` and add the id to `seenExternalIds` — feed corroboration is what makes it evidence. **Deliberately not built at ship time:** it is a new write path in the most correctness-critical function in the app, defending a row class that is currently EMPTY (0 such rows on the live ledger, and the app can no longer create one — only `0020` on an unlinked account could). The `isNull` arm plus the widened relink warning already stop the silent-money-loss version. Build this before any future change that can produce an untagged row.

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
- [ ] **P4** — Money is `number` everywhere, with CLAUDE.md rule 1 carried by naming convention alone. A branded `Cents` type would make it a compile-time property; `parseAmountToCents` is the natural single point of introduction. Large diff, no behaviour change — only worth doing as a dedicated pass.
- [ ] **P4** — Simplification, advisory only (~120 lines removable): a shared batch-writer between `importBatch.ts` and `simplefin/sync.ts` (the snapshot → insert batch → insert rows → update count block is duplicated line-for-line); a shared `(date, |amount|)` bucketing helper between `transferPair.ts` and `simplefin/matchTransfers.ts` — CLAUDE.md rule 4 justifies a second decision *rule*, not a second bucketer. (This entry used to carry a third item, a `selectUnlinked(sinceIso, db)` helper for the query `linkTransfersByBucket` and `findAmbiguousTransfers` share verbatim. That query has since grown a third copy and is now tracked on its own — see **"The unlinked-rows SELECT now exists in three identical copies in `sync.ts`."**)

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
considered and explicitly scoped out, not forgotten. The second — a set-based `/budget`
query rewrite gated on the T18 measurement — was struck by the 2026-09-09 audit: its own
body already recorded it as STALE, because migration 0021 removed the cache and
`loadMonthView` has used a set-based prefix scan since T8, so the `2N + 3ND` fan-out the
whole item was built on does not describe the code. One remains.

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

- [x] **P2 → CLOSED (2026-09-16).** **`/categorize` is now month-scopeable.**
  `loadMerchantGroups(db, scope?)` takes an optional `{year, month}` and applies it
  ONLY to the grouping query (`count`/`totalCents`, and therefore which merchants
  appear at all) — `sampleMemos`, `totalRowCount`, `filedCategoryIds` and
  `existingRule` stay all-time on purpose, the same D3 reasoning ("how a merchant
  was filed before is the decision support") that already governed
  `totalRowCount`. `page.tsx` parses `?year=&month=` via a new
  `src/lib/categorize/scopeParams.ts` (lenient — an absent or unparseable value
  degrades to "all time" rather than 404ing, unlike `/transactions`' `.strict()`
  schema, since this is the page's first-ever query param with no second filter
  it could silently drop alongside) and a `ScopeNav` component mirrors `/budget`'s
  own `MonthNav` (prev/label/next as plain `Link`s, no client JS) rather than a
  second pattern for the same idea.
  **The write path is scoped too, not just the read — this was the actual
  design decision, not a mechanical extension.** "Categorize all N →" on a
  scoped page must file exactly N rows, never the merchant's whole history, or
  the feature's whole premise ("clear September, leave history for later")
  breaks the first time someone clicks it. `bulkCategorizeInputSchema` gained
  optional `scopeYear`/`scopeMonth` (both-or-neither via `.refine()`, same
  discipline as rule 4's `intent` field — a dropped one must never silently
  widen a scoped submit into a full-history one), threaded as hidden form
  fields from `MerchantRow`, and `bulkCategorize`'s own row-selection query
  applies the same date predicate. The Remember/rule decision is UNAFFECTED by
  scope: `applyRuleWrite` keys off `filedCategoryIds`, computed elsewhere from
  the whole merchant history, not from the scoped batch — training or removing
  a rule from a September-only submit reads exactly as if `/categorize` had no
  scope at all.
  **Resolved as part of this: the two-numbers-on-one-banner note above.** The
  `/categorize` counter (`loadUncategorizedBacklog`, already scope-capable since
  X4) now follows the page's own scope rather than staying hard-coded to
  all-time — so "48 transactions" in the banner and "48" summed across the
  scoped merchant rows never disagree. `/transactions`' own banner is untouched
  and stays all-time, which remains correct for that page.
  Verified live against the real ledger (via `pnpm dev` on the local, disposable
  copy — not the running Docker container's ledger): scoping to a month with
  real data narrowed a 25-row merchant to its 2 in-month rows, "Categorize all
  2 →" filed exactly those 2 and left the other 23 untouched under the same
  rule, and the all-time view immediately reflected the reduced count with the
  rule and history intact. 2223 tests pass, `tsc --noEmit` clean, lint clean.
  Also extracted `monthLabel` into `monthOfIso.ts` — it was
  byte-identical across three call sites (`page.tsx`, `_month-editor.tsx`,
  `_allocate-form.tsx`) before this branch needed a fourth copy for
  `ScopeNav`; `loadMonthlyTrends.ts`'s own short-form copy is a real variant
  (chart axis label) and was left alone.
  (`src/lib/categorize/loadMerchantGroups.ts`, `src/lib/categorize/bulkCategorize.ts`,
  `src/lib/categorize/validateBulkCategorizeInput.ts`, `src/lib/categorize/scopeParams.ts`,
  `src/app/categorize/page.tsx`, `src/app/categorize/_scope-nav.tsx`,
  `src/app/categorize/_categorize-ui.tsx`, `src/app/categorize/_merchant-row.tsx`,
  `src/lib/budget/monthOfIso.ts`)

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
  comment doesn't go stale if that column is ever made multi-valued. It was made
  multi-valued in v0.19.0 and the note did its job: see the P3 below, now closed — the
  search is budgeted instead.
  (`src/db/schema.ts`, `src/lib/importBatch.test.ts`, `src/lib/transferPair.test.ts`,
  `src/lib/simplefin/matchTransfers.ts`)

- [x] **P3 → DONE (v0.19.0)** — `transfer_rejected_partner_id` was single-valued, so a row
  remembered only its MOST RECENT rejection. Filed here as low-probability ("needs four
  rejections across two rows to hit") and judged not worth a join table. **That estimate was
  invalidated by the same-account reversal queue in this same release**, which made writing a
  rejection a ONE-CLICK act and turned the limitation into two live defects: silent erasure
  of an unrelated correction (after which the matchers re-link the pair the user rejected),
  and a review bucket with ≥2 candidates on both sides that can never reach the all-rejected
  state at all — proved unreachable by exhaustive search, and present on the live ledger as
  the 2×4 `2026-09-04 · $10.00` bucket. Replaced by `transfer_pair_rejections(low, high)`,
  keyed on the unordered pair, with the existing markers migrated across (`drizzle/0019`).
  Two knock-ons closed with it: `linkTransferPairManually`'s conditional marker-clear is gone
  (one row per pair means nothing to clobber), and `assignAvoidingRejections`' backtracking —
  whose speed genuinely did depend on out-degree ≤ 1 — is now explicitly budgeted, falling
  back to "send the bucket to review" rather than exploring a dense rejection graph.
  (`src/db/schema.ts`, `src/lib/transferRejections.ts`, `src/lib/simplefin/matchTransfers.ts`,
  `CLAUDE.md`)

## Follow-ups from the `/plan-eng-review` pass (2026-09-04, envelope-budgeting plan)

Surfaced while reviewing [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md) (zero-based / EveryDollar-style budgeting, PR1 + PR2). None of these are closed by that plan; all five were captured deliberately rather than folded into scope.

- [x] **P2 — DONE v0.19.0 (2026-09-08)** — **"Spent" means two different things depending on which page you are on.** `computeMtdSpent` (`src/lib/budget.ts`) returned a signed sum so a refund reduced category spend on `/budget`, while `loadMonthlyTrends` filtered `amount_cents < 0` so the same refund was invisible on the dashboard chart. **Not hypothetical when it was finally measured**: September 2026 showed Misc at `$10.00` on `/budget` and `$295.00` on the dashboard, and Groceries differed by `$23.75`. Convention picked: **signed everywhere** (decision D2=A) — an envelope model means a refund restores spending capacity, and it aligns the chart to what `/budget` already rendered rather than introducing a second convention. (`leftToBudgetCents` is untouched either way — it is `plannedIncome − allocated − plannedFunds` and carries no spend term at all; an earlier version of this entry gave that as the *reason* for the choice, which was wrong.) `loadMonthlyTrends` now uses the same signed sum. The `amount_cents < 0` filter could NOT simply be deleted: it was silently doing a second job, excluding income (which is positive), and removing it alone would have pulled 43 paycheck/interest rows worth +$52,131.17 into the six-month window as ~$52k of negative spend — replaced by an explicit `kind = 'expense'` subquery, which is what "spending" actually means. `loadGoals` was deliberately NOT converted; see the P3 below and the analysis in the comment above `loadGoals`' `withdrawalRows` query. (`src/lib/trends/loadMonthlyTrends.ts`, `src/components/ledger/trend-chart.tsx`)

- [x] **P2 → CLOSED PERMANENTLY (2026-09-17, `/plan-eng-review`).** **PR3: what a fund's progress MEANS, and the paydown envelope that waits on the answer.** (Merged 2026-09-09: this was filed three times — as part (b) of "PR3: fund behavior unification" here, as the `categories.account_id` P2 in the liability review, and again as a P3 in the 2026-09-08 triage. Part (c) of the original entry, the overspent-fund carry question, moved to **"The three rollover open questions"** below, where its two siblings already live. Part (a) — funds rendering as budget rows rather than living only on `/goals` — closed 2026-09-08 in v0.23.0 when the FUNDS band became editable and started writing `budget_periods` through the same `upsertAllocation` the other two bands use.)
  **Decision: planned-only, permanently.** A fund's progress is money allocated, never money moved — formalizing the behavior the code already had. `categories.account_id` and the reconciled-paydown-envelope redesign below are retired as a deliberate non-goal, not deferred further; the concrete need that motivated them (plan a card paydown, check whether you hit it) already shipped decoupled from this question in v1.5.0's `accounts.paydown_target_cents`. `/goals`' copy no longer promises this is temporary ("...until that's true"), and DESIGN.md now names explicitly what stays unsupported: spending from a fund and replenishing it later (an actual Emergency Fund payout is just an ordinary expense with no connection back to the fund).
  **An outside review of this exact decision found the premise it was about to formalize was FALSE, and that turned into the real fix.** DESIGN.md and this entry both claimed "nothing can ever populate `withdrawn`" as structurally guaranteed by three independent guards. Two of the three (`assertAssignableCategory`, `CategoryCombobox`) only cover the manual categorize paths — the automated import-time rule matcher (`buildRuleMatcher`, `src/lib/rules.ts`) had a one-sided guard that refused only a *positive* row into a fund, on the theory that a negative row is an intentional withdrawal. It missed that `setCategoryKind` never touches `category_rules`: a rule trained while a category was `expense`/`income` survives untouched if that category is later reclassified to `fund`, so an ordinary sequence (retarget a category's last transaction elsewhere with Remember unchecked, leaving it unused; reclassify it to `fund`; re-import a matching debit) silently auto-filed a withdrawal into the fund with no explicit user action — the exact divergence this whole section claimed was impossible. **Fixed**: `rules.ts` now refuses a fund match on *either* sign, closing the loophole and making the invariant actually true rather than true-in-one-path. `rules.test.ts` gained a regression test pinning the exact repro ("trained BEFORE the category was reclassified to fund") and two existing tests that had asserted the old, now-wrong one-sided behavior were corrected. 2243 tests pass (was 2241 before this branch), `tsc --noEmit` clean. (`src/lib/rules.ts`, `src/lib/rules.test.ts`, `src/app/goals/page.tsx`, `DESIGN.md`, `PLAN.md`)
  **A pre-landing Red Team pass asked the question closing the guard doesn't answer: had the loophole already fired on this ledger before the fix landed?** Measured directly rather than inferred: `SELECT count(*) FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.kind = 'fund'` against the live container ledger returns **0** — the one real fund (Emergency Fund, created via `createGoalAction`, which writes `kind='fund'` directly and is never reclassified) was never exposed to the loophole. The invariant DESIGN.md states was never violated in practice, not merely closed going forward. Pre-landing review (6 specialists + Red Team) found and fixed two other small issues: a missing fund-fallthrough regression test (testing specialist) and two comments in `budget.ts`/`loadMonthView.ts` that misattributed a documented residual to CLAUDE.md instead of TODOS.md (maintainability specialist), plus one stale test comment in `loadMonthView.test.ts` still describing the old one-sided guard.
  **A second, independent path into a fund survived the `rules.ts` fix, and a Codex adversarial pass found it: undo.** `undoCategorizeTransaction` restored a transaction to its snapshotted prior category with no check on that category's *current* kind — categorize a row, reclassify its old category to `fund` in a second tab, click the original action's 10-second Undo toast, and the row lands in the fund with no rule involved at all. Reproduced directly against the code, not inferred. Fixed the same way as `rules.ts`: the check happens fresh inside the write transaction (rule 11), and falls back to `null` (uncategorized) rather than the fund — the same fallback this function already used for a row someone else re-categorized mid-window. `undoBulkRetarget`'s structurally similar unguarded restore was checked and left alone: it is deliberate, since `bulkRetarget` allows a fund as a retarget SOURCE and its undo has to be able to restore into one. `_transaction-row.tsx`'s optimistic UI update was also fixed to use the server's actual `restoredCategoryId` rather than its own stale `priorCategoryId` closure value, and to add a short toast note when the fallback fires — the previous code would have shown the fund still "selected" client-side while the server had silently reverted to Uncategorized. 2245 tests pass (2 new: the fund-fallback case and a NULL-prior-stays-NULL parity case), `tsc --noEmit` clean, lint clean. (`src/lib/categorize/undoCategorizeTransaction.ts`, `src/lib/categorize/undoCategorizeTransaction.test.ts`, `src/app/transactions/_transaction-row.tsx`, `DESIGN.md`)
  **The "`undoBulkRetarget`'s unguarded restore is deliberate, not a bug" claim two paragraphs up was itself wrong, and a `/pr-review-toolkit` pass on the already-open PR found why.** Both code-reviewer and silent-failure-hunter, independently, reproduced the same race with no crafted input: retargeting a merchant's rows off a category is exactly what can leave that category unused (zero transactions, zero `budget_periods` rows), and an unused category is freely reclassifiable to `fund` with zero confirmation (rule 8). Reclassify it to `fund` from the `⋯` menu inside the same 10-second undo window the retarget's own toast is still open for, click Undo, and the rows land back in the now-fund category — the exact bug `undoCategorizeTransaction` was just fixed for, on the one write path that fix didn't touch. The original dismissal's reasoning (a fund is a legitimate retarget SOURCE, so undo must be able to restore into one) only covers a source that was ALREADY a fund at retarget time, not one that BECOMES one during the window. **Fixed**, with a simplification code-reviewer argued for over a more surgical snapshot-carried "was already a fund" flag: `undoBulkRetarget` now unconditionally re-checks the source category's current kind inside its write transaction and falls back to `null` whenever it's a fund, no exceptions — the one behavior this gives up (undoing a deliberate drain of a `pnpm db:studio`-created fund) isn't worth preserving given this whole decision's own thesis that such a fund shouldn't exist. `UndoBulkRetargetResult` and `UndoCategorizeTransactionResult` were both converted from optional fields to discriminated unions in the same pass (2 independent reviewers — type-design-analyzer and code-reviewer — flagged the optional-field shape as a `??`-footgun that would silently reintroduce this exact bug class at the call site). `_retarget-form.tsx`'s toast now names "Uncategorized" instead of repeating the source category's name when the fallback fires. Also fixed in the same pass: `scripts/backfill-merchants.src.mjs`'s collision-ranking mirrored `buildRuleMatcher`'s archived-category skip but not its fund-kind skip, so a merchant-key collision between a live rule and a dead fund-pointing rule could have deleted the live one (code-reviewer); three now-stale docstrings in `budget.ts`/`loadMonthView.ts` that re-enumerated the guard list inline and had gone stale twice in one review cycle were pointed at DESIGN.md instead, closing the recurring pattern rather than patching it a third time (comment-analyzer); `loadGoals.ts`'s in-code analysis — the one CLAUDE.md rule 1 explicitly sends readers to — still described PR3 as open and repeated an already-stale "zero funds on the ledger" claim (code-reviewer); and `_transactions-ui.tsx`'s backlog counter undercounted on both the categorize AND undo directions whenever "Apply to past" moved rows that were NOT the target row's own prior/restored category (pre-existing, unrelated to the fund bug, found incidentally and fixed at the user's call — `onCategorized`/`onUndone` now report a precise crossed-the-NULL-boundary count instead of reconstructing it from one row's id). 2249 tests pass, `tsc --noEmit` clean, lint clean. (`src/lib/categorize/undoBulkRetarget.ts`, `src/lib/categorize/undoBulkRetarget.test.ts`, `src/lib/categorize/undoCategorizeTransaction.ts`, `src/app/transactions/_retarget-form.tsx`, `src/app/transactions/_transaction-row.tsx`, `src/app/transactions/_transactions-ui.tsx`, `src/components/ledger/write-toast.ts`, `scripts/backfill-merchants.src.mjs`, `scripts/backfill-merchants.test.mjs`, `src/lib/budget.ts`, `src/lib/budget/loadMonthView.ts`, `src/lib/goals/loadGoals.ts`, `DESIGN.md`)
  **The math.** `loadGoals` computes progress from `SUM(budget_periods.allocated_cents)` — money *planned*, not money that moved — so a goal reads $1,200 saved after six months of $200 allocations you then spent on groceries. PR1's D11A only *hides* the progress bar and percent-complete rather than fixing it, so the false number is off-screen, not gone. `/goals` now leads with `totalContributedCents` rather than `progressCents` (v0.23.0), which makes both pages show the same quantity under the word "planned" — an honest label on the number, not a fix to what it counts.
  **Codex's round-5 correction, which is why there is no experiment to run.** `progressCents` (`allocated − withdrawn`) and `totalContributedCents` can only diverge if a fund has TRANSACTION rows, and nothing in the app can file one: `assertAssignableCategory` throws `SavingsGoalCategoryError` on `kind='fund'` for all three categorize paths, `CategoryCombobox` filters funds out of the picker, and `rules.ts` refuses a positive row into a fund at import. The two numbers are identical on any ledger this app can produce. So this is a decision to write down, not a measurement to take — and it was partly written down, in `DESIGN.md`'s "What a fund's progress means". What stays open is whether that model is the one you want.
  **[2026-09-08 historical snapshot — both flagged claims above are superseded, not restated.]** "`rules.ts` refuses a positive row into a fund" describes the pre-2026-09-17 one-sided guard the entries above this one found false and closed (both signs refused now, and the undo paths too). "What stays open is whether that model is the one you want" is answered: closed permanently, v1.6.1, planned-only. Left in place as the round-5 record rather than edited, per this file's own convention of correcting forward rather than rewriting history.
  **Live exposure, and how it moved.** The 2026-09-08 triage measured **zero `kind='fund'` categories and zero non-null non-zero `target_cents`** (60 expense, 3 income) and concluded the wrong number had never been rendered for anyone. Round 5 later the same day created the first fund, so as of 2026-09-09 the ledger holds **1 fund, 2 fund `budget_periods` rows, 1 rollover category, 2 budgeted months**. Re-run `select kind, count(*) from categories group by kind` before picking this up rather than trusting either figure.
  **Do NOT "finish the alignment" without settling the meaning first.** The v0.19.0 signed-spend pass deliberately left `loadGoals`' withdrawal query alone: `progressCents = allocated − withdrawn`, and a *net* withdrawn figure makes a deposit into a fund **increase** progress on top of the allocation already counting the same intention. The query is still `amount_cents < 0`, with that analysis recorded in the comment above its `withdrawalRows` query. The tests stay green either way.
  **The consumer waiting on the answer: `categories.account_id` and a genuinely reconciled debt-paydown envelope.** The liability plan originally proposed a `kind='fund'` category per credit card as the paydown envelope (decision D5=B). Codex's outside-voice pass killed it with three citations: `categorizeTransaction` explicitly *rejects* `kind='fund'` for transaction categorization, fund rows carried read-only `plannedCents` and nothing else at the time, and `categories` has no foreign key to `accounts` at all. A "Visa paydown fund" would therefore be a number you type that nothing in the app can ever reconcile against the actual card. Decision D13=B dropped it; the MVP answer is "read the card balance on `/accounts`," which is true but gives no way to *plan* a paydown and then check whether you hit it — the actual goal behind the credit-card request. Doing it properly means linking a category to an account, teaching the fund band to compute progress from money that *moved*, and relaxing the categorize guard. A paydown envelope built on today's fund math inherits the same false number, which is why it is one entry: settle the progress question first, or build both together.
  Deferred by scope decision `0e52e0af` specifically so it lands after the integration checkpoint (use the app on real data for a week), because it reinterprets goal data you already have. Blocked by: liability PR1 + PR2 shipped (done), plus one month of real fund use. (`src/lib/goals/loadGoals.ts`, `src/app/goals/page.tsx`, `src/lib/budget/loadMonthView.ts`, `src/db/schema.ts`, `src/lib/categorize/categorizeTransaction.ts`, `DESIGN.md`)
  **Partially addressed, 2026-09-17 (v1.5.0, `docs/plans/card-paydown-target.md`), WITHOUT reopening this entry's fund-semantics question.** The "consumer waiting on the answer" this paragraph names — a way to plan a card paydown and check whether you hit it — now has a narrow, decoupled fix: a recurring `accounts.paydown_target_cents` (cards-only, same shape as `credit_limit_cents`/`minimum_payment_cents`), compared against the existing `paidDownCents` actual. It never touches `categories`, `assertAssignableCategory`, or the `kind='fund'` machinery, and does not answer whether money should ever move into a fund — that product question, and the `categories.account_id`-linked-fund redesign this entry originally sketched, both remain exactly as open as this paragraph already describes.

- [ ] **P3** — **Split transactions conflict with the V1 exclusion list; decide, do not drift.** `CLAUDE.md`'s "What's NOT in V1" section lists "Split transactions (one category per transaction; override wins)" as a deliberate exclusion. EveryDollar has them, and after PR1 + PR2 this is the largest remaining fidelity gap: a $180 Costco run that is half groceries and half household goods must pick one envelope, which is the most common real-world reason a zero-based budget drifts from what actually happened. This is the single biggest item on this list — it touches the transactions schema, every sum in `src/lib/budget.ts`, categorization and its undo paths, and the dedup invariants in `CLAUDE.md` rules 3 and 4. Captured here so it becomes an explicit decision later rather than something that gets silently added because it seemed necessary mid-implementation. Blocked by: PR1 + PR2. (`src/db/schema.ts`, `src/lib/budget.ts`, `src/lib/categorize/`)

- [ ] **P3** — **Drop `categories.is_savings_goal` once PR1's read migration has settled.** PR1 decision D10A repointed the categorization readers from the boolean to `kind` (`loadMonthView`, `loadGoals`, `loadMonthlyTrends`, `categories.ts`, plus the three guards eng review round 2's decision A2 found this entry had missed: `categorizeTransaction`, `bulkCategorize`, `goals/actions.ts` — now all funnelled through `assertAssignableCategory`).
  **CORRECTED 2026-09-09: this entry scoped the removal as one dual-writing call site, and there are THREE writers plus three live readers.** Re-measured with `grep -rn "isSavingsGoal\|is_savings_goal" src/ | grep -v '\.test\.'`:
  - **Writers (3):** `src/app/goals/actions.ts` (`createGoalAction`), `src/lib/budget/manageCategories.ts` (`createCategory`, `isSavingsGoal: kind === "fund"`), and `src/lib/budget/setCategoryKind.ts` (`isSavingsGoal: newKind === "fund"`). The last two are newer than this entry and both cite `setCategoryKind`'s convention of keeping the column truthful, so the dual-write has spread rather than settled.
  - **Readers (3), all in `src/lib/categories.ts`:** the `LeafLookup` type field, the `select`, and the row mapping. Which means the column is NOT write-only as this entry claims — `classifyCategory` still surfaces it, and that function is separately tracked for deletion (see **"Delete `classifyCategory` and its `LeafLookup` type, or give them a caller"**). Deleting `classifyCategory` first removes all three readers and makes this a genuine write-only column, which is the order to do it in.
  A write-only column is a trap for whoever reads the schema next and assumes it still means something. Removing a `NOT NULL` column in SQLite needs a table rebuild, so this must go through `scripts/migrate.mjs` with the `PRAGMA foreign_keys` handling described in `CLAUDE.md` rule 7 — not `drizzle-kit migrate`. Bundle it into PR3's migration rather than spending a rebuild on it alone. Blocked by: PR1 (D10A) shipped; `classifyCategory` decided. (`src/db/schema.ts`, `src/app/goals/actions.ts`, `src/lib/budget/manageCategories.ts`, `src/lib/budget/setCategoryKind.ts`, `src/lib/categories.ts`, `drizzle/`)

- [ ] **P4** — **The three rollover open questions, which are one decision made in three places.** (Merged 2026-09-09: filed separately as the forgive-overspend P4 here, open question O5 in the round-3 review, and part (c) of "PR3: fund behavior unification". They are merged as ONE ENTRY WITH THREE NAMED MECHANISMS, deliberately — the O5 entry argued against merging on the grounds that "merging them now is how the second one gets answered halfway", and that risk is real, so the mechanisms are kept distinct below rather than blended. What was wrong was carrying three unchecked boxes for one PR3 decision point.)
  **(1) Forgive-overspend.** `getEffectiveAllocation` computes `rolloverCents = Math.max(0, prior.effectiveCents - priorSpent)`, so overspending a rollover envelope by $300 vanishes at the month boundary and the next month opens clean. That is a defensible product call — EveryDollar's Funds go negative, YNAB makes you cover the overage explicitly, and forgiving it is a third valid option — but nothing in the code, the tests, or the docs said it was *chosen* rather than added to avoid a negative number. Task T12 adds the rationale comment; the product question stays open. (`src/lib/budget.ts`)
  **(2) O5 — absent-row reset.** When a rollover category has no `budget_periods` row for a month, its accumulated balance resets to zero. `getEffectiveAllocation` returns `null` for a month with no row, so the recursion's `if (prior)` guard contributes `rolloverCents = 0` and the chain terminates. Fund $200/month for six months, skip funding it in November, and December opens at $200 rather than $1,200 — the balance is not clamped, it is **erased**. **This is a different mechanism from (1)**: that one forgives money you *spent*, this one discards money you *did not touch*, and it fires on an absent row rather than a negative remainder. Task T10 writes the rationale comment beside B3's, at the `if (prior)` guard. Plan decision E4 required PR1's set-based prefix scan to reproduce the behavior exactly and added the skip-month fixture to TC30 that the existing oracle set never had — so the behavior is pinned either way and what stays open is purely whether it is the behavior you want. (`src/lib/budget.ts`, `src/lib/budget/loadMonthView.ts`)
  **(3) O2 — an overspent FUND.** When you overspend a Fund, does the negative carry forward or reset? Same shape as (1) but on the band whose whole purpose is accumulation, which is why it was tracked with the fund work rather than here. Deferred by scope decision `0e52e0af` so it lands after the integration checkpoint, because it reinterprets goal data you already have.
  **Live state.** The round-3 note that "all 50 seeded categories are `carryover_policy: 'none'`, so no real balance is at stake" is no longer true: as of 2026-09-09 the ledger has **1 rollover category across 2 budgeted months**, and rollover has executed for real (`+$250.00 rollover → $500.00`). Blocked by: PR3 fund semantics — answer all three in one sitting, from real fund usage rather than in the abstract.

## Follow-ups from the `/plan-design-review` pass (2026-09-04, envelope-budgeting plan)

Design debt surfaced while reviewing [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md). The plan itself absorbed 24 design decisions (D1A-D24A); four were deliberately left out of its scope. **Three remain** — the fourth, "`src/app/sync/error.tsx` is the only error or loading boundary in the app", was struck by the 2026-09-09 audit as false: `find src/app \( -name error.tsx -o -name loading.tsx \)` now returns 22 files, and every route the entry named as lacking one has both. D24A's `/budget/[year]/[month]` boundary landed and the pattern was carried across the app.

- [ ] **P2 (PARTIALLY DONE — see note)** — **Dashboard card-stack redesign.** Codex hard-rejected `src/app/page.tsx` on two criteria during the design review: "generic SaaS card grid as first impression" and "app UI made of stacked cards instead of layout". Accounts, monthly summary, trends, backlog and quick links are all just vertically stacked cards, so the first screen of the app reads as stock shadcn rather than Ledger Paper. The fix is an information-architecture change, not a token swap: one dominant anchor (probably Left to Budget or a "budget complete" state once PR1 ships it) with a single next action, account tiles demoted to a compact ledger list, trends and backlog moved into secondary panes. Deliberately excluded from the envelope-budgeting plan — decision D9A restyles `/budget/[year]/[month]` only, because the dashboard has its own IA problem that a token substitution will not fix and it deserves its own mockup round. Blocked by: PR1 shipped, so there is a Left to Budget number available to anchor on. **Update 2026-09-07: DS49 closed the two hard rejections.** The liability-accounts PR replaced the `AccountTile` grid with ruled row-lists and added `Closest to limit` as a ruled list, so the balance and proximity sections are no longer cards. What is still open is the rest of the IA: one dominant anchor with a single next action, and the trend/backlog panes. The `variant="plain"` deletion below is still pending — DS49 explicitly did NOT touch `SummaryStrip`. (`src/app/page.tsx`, `DESIGN.md`) **When this lands, also delete `SummaryStrip`'s `variant="plain"` (plan decision DS45).** PR1b extracts `SummaryStrip` and renders it on both surfaces; the `plain` variant exists only so this page is not left half-restyled while it waits for its own mockup round. Both callers pass `ledger` once the dashboard is done, the prop goes, and DS39's single ruled strip becomes unconditional. Grep `variant=` in `src/app/page.tsx` and `src/app/budget/[year]/[month]/page.tsx` to confirm the call sites before removing. (`src/components/ledger/summary-strip.tsx`)

- [ ] **P2** — **App-wide Ledger Paper adoption is ~15%.** Measured 2026-09-04, Ledger Paper tokens vs shadcn defaults per page: `/` 13:24, `/subscriptions` 4:25, `/goals` 2:38, `/transactions` 1:1, `/sync` 1:66, `/categorize` 0:2, `/import` 0:13, `/budget/[year]/[month]` 0:35. The tokens all exist (`globals.css` defines 50 of them), `DESIGN.md` documents them, and `design_handoff_nav_and_design_system/` has live HTML specimens — the system was designed and then largely not adopted. Note this gets *more* visible after decision D9A, not less: the budget page becomes the only fully on-system surface, so every other page will look like a different app. Migrate worst-first (`/sync` at 1:66, then `/goals`, then `/subscriptions`); `/transactions` at 1:1 is nearly untouched and is the cheapest place to establish the pattern. Mechanical className substitution, no behavior change, no new tests — which is also why nothing will force it to happen. Blocked by: D9A landing first as the reference implementation. (`src/app/**/page.tsx`, `src/app/globals.css`, `DESIGN.md`)

- [ ] **P3** — **`DESIGN.md` has no motion vocabulary and is about to acquire one animation.** Decision D6A′ adds the app's first and only motion: on transition into the Left to Budget success state, the numeral settles to ledger green over ~240ms and the check draws in, honoring `prefers-reduced-motion`, never firing on page load. `DESIGN.md` currently documents fonts, color tokens, radii, shadows and spacing cadence but says nothing about motion, so this token has no home and the next component that wants a transition will invent its own easing and duration. Add a Motion section naming the duration, the easing curve, the reduced-motion rule, and the principle that motion marks a state *transition* the user caused rather than decorating a render. One paragraph. Blocked by: D6A′ implemented, so the values are real rather than guessed. (`DESIGN.md`, `src/components/ledger/left-to-budget.tsx`)

## Follow-ups from the `/plan-eng-review` round 2 pass (2026-09-04, envelope-budgeting plan)

Second eng review of [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md), run after the design review added 13 tasks and re-specced PR2's editor. 30 decisions were folded into the plan; these three were captured deliberately rather than folded into scope. (The fourth, month-scoping, amends the existing entry above rather than duplicating it.)

- [x] **P3 — DONE (2026-09-08, migration `0021_drop_rollover_cache`; see the round-5 section at the end of this file).** **PR3: drop `effective_allocation_cents` and the whole `invalidateForwardRollover` mechanism.** After PR1a this is a column that eight code paths write NULL into and nothing can read. Task T8 replaces the per-leaf rollover recursion with a set-based clamped prefix scan, removing the column's last reader-that-could-hit; decision TS1 then deletes `getEffectiveAllocation`'s `persist` option, removing the last writer of a non-NULL value. So `budget.ts:60`'s cache-hit branch becomes unreachable while `upsertAllocation`, `categorizeTransaction`, `bulkCategorize`, the three undo paths, `setCarryoverPolicy` and `setCategoryKind` all keep faithfully clearing it — PR2a's `copyPreviousMonth` fires the batched version across 40 categories per use. Decision P3 deliberately kept the code rather than ripping out eight call sites inside the PR that was split to bound its blast radius, and because PR3's fund work may legitimately want a real cache, in which case deleting the column now becomes a migration to add it back. What this entry exists to prevent: B5 hid for five releases because nobody wrote down that a column had no writers. This is the same shape read backwards — writers, no readers — and it needs the same explicit record. Task T10 rewrites the JSDoc to say the read branch is unreachable rather than adding a fourth trigger to a contract for a no-op. Trigger to act: PR3, or any decision to give funds real carry-forward behavior. Blocked by: PR3 fund semantics, which itself waits on the integration checkpoint above. (`src/lib/budget.ts`, `src/lib/budget/upsertAllocation.ts`, `src/lib/categorize/`, `src/db/schema.ts`)

- [ ] **P3** — **Delete `classifyCategory` and its `LeafLookup` type, or give them a caller.** `src/lib/categories.ts` exports `classifyCategory` (line 146 as of 2026-09-09 — this entry cited `:61`, which the file outgrew), and `grep -rn 'classifyCategory' src/ | grep -v test` returns only the definition — zero non-test callers. Its `LeafLookup` type (line 135) also exposes `isSavingsGoal`, which makes it the LAST surface reading the boolean that decision A2 is retiring; PR3's "drop the column, no behavior change" would silently break it, and deleting this function is what turns `is_savings_goal` into a genuinely write-only column (see **"Drop `categories.is_savings_goal` once PR1's read migration has settled"**, which now depends on this one). This is the third instance of the same pattern in this codebase (`applyRuleAtImport` shipped in v0.3.0 with no callers and produced a 498-row backlog; `effective_allocation_cents` had no writers for five releases), which is worth noticing as a pattern rather than three coincidences. Deliberately not folded into A2's seven-site sweep: deleting a function that has tests deserves its own look rather than riding along in a mechanical repoint, because the tests are the reason it reads as intentional. Start by checking whether it was written for a caller that never landed. Depends on: nothing; could ride with PR1a's T5 if you decide quickly. (`src/lib/categories.ts`)

- [ ] **P3** — **O1: is `Reimbursement` income, or an expense that nets against itself?** Migration `0017` backfills `Reimbursement` (category id 42) to `kind='income'` on EveryDollar's model. The alternative is expense-kind, where its positive rows net against that same category's spending — which is better if a reimbursement usually offsets a specific expense you already categorized. This matters more than it looks because the choice is close to irreversible in-app: decision X1 only permits an expense→income kind change on a category whose transactions are *all positive*, and a reimbursement category will hold both signs, so once it is used you cannot flip it without creating a new category and re-categorizing. Nothing is at stake yet — it currently holds zero transactions — which is exactly why this needs a deliberate answer before it accumulates any. Check after a month: if most rows in it pair with an expense you already categorized elsewhere, the seed is wrong. Blocked by: the integration checkpoint (one week of real use). (`drizzle/0017_category_kind.sql`, `src/lib/budget.ts`)

## Follow-ups from the `/plan-eng-review` round 3 pass (2026-09-04, envelope-budgeting plan)

Third eng review of [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md), run after design review round 2. 15 decisions (`E1`-`E15`) were folded into the plan; one was captured here instead, and one amends the dashboard entry above rather than duplicating it. Codex ran as the outside voice against the repository rather than the plan text and independently found four of the five architecture findings.

The one item captured here — open question **O5**, whether a rollover category's accumulated balance should reset in a month with no `budget_periods` row — was merged into **"The three rollover open questions, which are one decision made in three places"** by the 2026-09-09 audit, which is where its two siblings already lived. The section is left in place because its framing is the record of that review; it holds no open items of its own.

## Follow-ups from the `/ship` pre-landing review + specialist army + Red Team (2026-09-04, envelope-budgeting PR2a/PR2b)

Landing PR2a (client-owned budget editor) and PR2b (category CRUD/archive/reclassify) went through three pre-landing review cycles, a four-specialist army (Testing/Maintainability/Data-Migration/API-Contract), and a Red Team pass. Most real findings were fixed in-branch (a swallowed-edit race and a stale-allocations-after-copy-month bug in the client editor, an X1/DS32 evidence gap in the reclassify picker, two API-contract gaps in `budget/actions.ts`, a missing archived-category guard on `upsertAllocation`, and orphaned empty groups). These two were deliberately deferred instead — narrow enough, and far enough from the shipped UI's reachable paths, that fixing them isn't worth widening this branch's diff.

- [ ] **P3** — **`createCategory` (`src/lib/budget/manageCategories.ts:72`) doesn't check that `parentId` is unarchived, or that it has no activity of its own.** It only checks the parent exists. Not reachable from the shipped UI — `NewCategoryRow` only ever passes an already-established group's id (see the empty-group fix in this same round: a group only becomes "established" once it has its first child) — but `createCategoryAction` is a plain callable Server Action, and this app's own no-auth threat model (`categoryErrors.ts`'s `CategoryArchivedError` doc comment reasons about exactly this) treats every Server Action as a network-reachable endpoint regardless of what the UI does. Two distinct gaps worth closing together: (a) passing an archived category's id as `parentId` would un-hide it as a group header while it's still flagged archived; (b) passing a category with its own real transaction/allocation history would retroactively turn it into a parent, silently dropping its own activity out of `expenseLeavesAll`/`summarize()` (`loadMonthView.ts`) — a wrong-number bug, not a crash. Found by Red Team during `/ship` 2026-09-04. (`src/lib/budget/manageCategories.ts`)

- [x] **DONE (v0.24.0 — resolved by deletion, not by extraction)** — **The "invalidate forward from the earliest `budget_periods` row" block is duplicated, not shared, between `setCategoryKind.ts` and `manageCategories.ts` (`setCarryoverPolicy`).** Both copies are gone with migration 0021: the cache they invalidated (`budget_periods.effective_allocation_cents`) had had no writer for four releases, so the two `earliestPeriod` SELECTs and both `invalidateForwardRollover` calls were deleted rather than merged into the shared `invalidateForwardFromEarliestPeriod` this entry proposed. The pattern the entry named was real and did recur — it just recurred somewhere else (rule 8, fixed the same release by `categoryKindLock.ts`). Originally found by the Maintainability specialist during `/ship` 2026-09-04.

## Follow-ups from the `/plan-eng-review` pass (2026-09-06, liability-accounts-and-budget-signals plan)

Surfaced while reviewing [docs/plans/liability-accounts-and-budget-signals.md](./docs/plans/liability-accounts-and-budget-signals.md) (credit cards + mortgage as liability accounts, dashboard budget-proximity tiles; PR1 + PR2). None are closed by that plan; all four were captured deliberately rather than folded into scope. **Three remain here** — the fourth, `categories.account_id` and a reconciled debt-paydown envelope, was merged by the 2026-09-09 audit into **"PR3: what a fund's progress MEANS, and the paydown envelope that waits on the answer"**, since it was blocked on that decision and said so.

- [ ] **P3** — **`loadAccountBalances` runs one aggregate query per account, inside the Spine, on every page render.** `loadAccountBalances` maps over `accounts` and issues a separate `SUM(amount_cents) / MAX(date)` query per row. UPDATED 2026-09-07: the double pass is already gone — this PR added `loadAccountBalancesForRequest` (React `cache()`), and both `Spine` and `/` use it, so a dashboard load runs the map once, not twice. What remains is the per-account query inside that single pass: N queries, i.e. 4 at today's account count rather than the 8 this entry originally claimed. Collapses to a single `GROUP BY account_id`. Deliberately NOT fixed in the liability PR (Section 4 of that review recommended against it): better-sqlite3 is synchronous and local and these hit `transactions_account_date_idx`, so at N=4 the cost is microseconds — this is a structural smell, not a latency problem, and the function's comments about pending-row exclusion and `ledgerAsOfDate` are load-bearing for `/sync`'s drift check. Do it standalone, with `loadAccountBalances.test.ts` green on both sides. Blocked by: nothing; just wants to be the only thing in its diff. (`src/lib/accounts/loadAccountBalances.ts`, `src/components/ledger/spine.tsx`)

- [ ] **P3** — **Finish the `moneyTone` extraction: ONE call site left.** The liability plan's decision D9=A extracted `moneyTone(cents, { context })` into `src/lib/money.ts` and converted the three sites that PR touched (`src/app/page.tsx` ×2, `src/components/ledger/spine.tsx`). A sixth copy, `src/components/ledger/envelope-card.tsx`, was deleted outright by that plan's D8=A. **CORRECTED 2026-09-09: this entry claimed two local copies remained; only one does.** `_month-editor.tsx` now imports `TONE_CLASS` from `@/lib/budget/resolveRowDisplay` rather than declaring its own, so the single remaining local lookup map is `src/components/ledger/summary-strip.tsx`. (`src/components/ledger/trend-chart.tsx` also declares a local `moneyTone`, but it is a different function — it takes a float dollar value inside a Recharts tooltip, not signed cents — so it is not a copy of this one and is out of scope here.) Worth finishing because this rule has already produced a measured divergence — `spine.tsx` emitted `money-neg` where every other site emitted `text-money-neg` — and because "sign decides color" is exactly the kind of rule that quietly grows an exception. Note the destination is a decision, not a given: `MONEY_TONE_CLASS` and `TONE_CLASS` are two tone maps that agree on three of four keys (tracked separately below), and `summary-strip.tsx` has to pick one. Blocked by: nothing. (`src/lib/money.ts`, `src/components/ledger/summary-strip.tsx`)

- [x] **P3** — **Revisit importing credit card transactions instead of entering them by hand.**
      **RESOLVED v1.1.0 (2026-09-09).** The liability plan's decision D10=C gave credit cards three explicit movements: a payment (transfer pair from checking), a manually-entered charge (an ordinary categorized transaction, `import_source='manual'`), and a reconcile (an anchor move). That was honest and kept card spending visible to the budget, but the charge path was data entry, and data entry decays. This entry's original blocking condition ("liability PR2 shipped, plus roughly two months of real use") never fired — the actual trigger was a live SimpleFIN probe (2026-09-09) that measured Citi's feed as clean (9 transactions/89 days, 0 pending), which retired the two blockers this entry names: `bank_transaction_number` was never required (`matchTransfers.ts`'s bucket matcher has no such dependency, so the CSV rule 4 concern didn't apply), and dedup already had an `external_id`/content-signature story (rule 3) that needed no new design. The pending-authorization concern held — real pending rows on cards would still be refused — but Citi's own feed reports none. Shipped as `docs/plans/card-transaction-import.md`'s PR1: a linked card now imports its own transactions, with a D8.1 accounting cutover (no historical backfill, to avoid double-billing against already-categorized checking-side payments) and dedicated refusals on both hand-entry write paths once a card is importing. AMEX/Bank-of-America-shaped cards not on the feed still get hand-entry exactly as this entry describes — unchanged for them. (`src/lib/accounts/manualTransaction.ts`, `src/lib/simplefin/sync.ts`, `docs/plans/card-transaction-import.md`)

## Follow-ups from the `/plan-design-review` pass (2026-09-06, liability-accounts-and-budget-signals plan)

Design review of [docs/plans/liability-accounts-and-budget-signals.md](./docs/plans/liability-accounts-and-budget-signals.md), run after the eng review. 20 decisions (`DS49`-`DS68`) were folded into that plan as a new "Design specification" section, along with 12 new implementation tasks (T16-T27) and a raised priority on T15. Codex ran as the outside voice against the plan plus `DESIGN.md` and triggered two hard rejections, both closed in-plan by DS49. These three were captured here instead — each is a real finding whose fix is larger than, or orthogonal to, the liability feature.

- [x] **P2 — DONE (v1.5.1, 2026-09-17).** **Raise the global type scale to a 16px base (16 / 14 / 12).** `src/app/globals.css:92` sets `--text-base: 15px`, `--text-sm: 13px`, `--text-xs: 11px`. Codex flagged this against the universal readability rule that body text is never under 16px, and the finding is correct as stated: prose rendered at `--text-xs` is 11px, and this app uses `--text-xs` for helper text, not only for labels. Decision DS66b answers it *narrowly* — on the new liability surfaces only, uppercase letterspaced mono labels may stay at `--text-xs` (a legitimate typographic device, not body text) while every sentence-case body, helper, or error string uses `--text-base`. That is a defended position, not compliance, and it leaves 11px prose everywhere else in the app. Deliberately not fixed in the liability PR: 15px is a deliberate density choice for a ledger app, reversing it changes every page's line count and every table's fit, and it would need a visual sweep of all nine routes — a global type change riding inside a feature PR is exactly the diff nobody can review. Do it standalone. Start by grepping for `text-xs` on nodes containing sentences rather than labels; that subset alone may be the whole fix. Blocked by: nothing. (`src/app/globals.css`, `DESIGN.md`)
      **Done as the standalone PR this entry asked for.** Tokens moved to 12/14/16px. The "grep for `text-xs` on sentence nodes" heuristic *was* most of the fix: six genuine sentence-case strings (empty-state helpers on `/goals` and `/subscriptions`, two `/sync` notes, `/import`'s anchor explanation, `/import/success`'s prior-anchor revert note) moved `text-xs`→`text-base`; every uppercase/mono label, table header, form-field label, and tabular numeric figure was deliberately left alone, matching DS66b's own narrow answer extended app-wide rather than applied everywhere indiscriminately. `text-sm` (general UI chrome — buttons, table cells, form controls) was left alone entirely; it benefits from the token floor raise (13→14px) without needing per-instance reclassification, since Codex's original finding was specifically about `--text-xs` at 11px, not `--text-sm`.
      **Design review (Codex, calibrated against DESIGN.md and the shared `StateCard` component) caught two real follow-on issues before merge, both fixed same-session:** the `/goals` and `/subscriptions` empty-state titles were left at `text-sm` while their descriptions moved to `text-base`, inverting the title/description hierarchy relative to `StateCard`'s own pattern (title >= description) — fixed by bumping both titles to `text-base` too, with hierarchy now carried by `font-medium` weight + `ink-1`/`muted-foreground` color instead of size. And `/import/success/[batchId]/page.tsx`'s prior-anchor note (money + date facts inheriting `font-mono` from its parent, plus a recovery sentence) was over-eagerly bumped in the first pass — reverted back to `text-xs` to match its sibling current-balance line, since on reflection it's tabular/metadata content, not standalone prose.
      **Claude adversarial review caught a real, unrelated regression the diff introduced silently:** `.spine-peek`'s sidebar account-balance rows use `--text-sm`, and a code comment (also duplicated in DESIGN.md) justified skipping a `min-width`/ellipsis truncation rule on `.peek-name` with an explicit width-budget calculation pinned to the OLD 13px figure ("`($302,480.11)` in 13px mono leaves ~100px for a name"). The token bump to 14px silently invalidated that documented assumption with no truncation safety net in place. Fixed: `.peek-name` now gets `min-width: 0` + ellipsis truncation, `.peek-amt` gets `flex-shrink: 0` (a dollar figure is never the thing that clips), and both stale comments were corrected. **General lesson, worth remembering for the next global CSS-token change: grep for comments/docs referencing the OLD pixel value, not just visually check the pages the diff directly touches — a shared token can invalidate a documented assumption in a file nowhere near the files you edited.**
      2269 tests pass, `tsc --noEmit` clean, lint clean.

- [ ] **P3** — **Finish the `/import` restyle: the CSV upload form and the anchor-repair section.** Decision DS64 converts the "Add an account" form to Ledger Paper tokens as part of T15, because that form is where a credit card is born and its asset-worded copy is a ledger-corruption path (see T15, raised to P1). The rest of the page is untouched, so `/import` ships visibly half-converted — one form on system, two forms still on raw `zinc-*`. Worth finishing because `/import` is the app's worst-measured design-system-adoption surface: 0 Ledger Paper tokens to 13 shadcn/zinc usages, measured 2026-09-04 (learning `mm-design-system-documented-not-adopted`), which is the reasoning behind that learning's own conclusion — adding one on-system component to an off-system page reads as careless, where a consistent default shell merely reads as plain. Deliberately deferred out of the liability PR because a full-page restyle touches the import path, the most correctness-critical code in the app, for purely visual reasons. Note the anchor-repair form gains importance under DS56: "Reconcile instead →" makes anchor editing a mainline recovery flow rather than a repair hatch, so it stops being a page only you ever see.
  **The amber-token half, merged in here 2026-09-09 — `import/preview` is the last raw-Tailwind offender.** `DESIGN.md`'s amber inventory table names four surfaces using the raw Tailwind `amber-*` palette rather than the shared `color-mix(in oklch, var(--accent-amber) …)` formula. `D21` converted three of them in the drilldown PR — the two sticky backlog strips (`_categorize-ui.tsx`, `_transactions-ui.tsx`) and the Uncategorized row badge (`_transaction-row.tsx`'s `CategoryBadge`, which `D20` made load-bearing by keeping amber as the one badge colour that encodes a *state* rather than a label). The fourth, `import/preview/[id]/page.tsx` (raw `amber-300`/`amber-50`/`amber-800`/`amber-700`, flagging calendar-invalid rows and the pending badge), was deliberately excluded: `D21` scoped itself to "surfaces this flow renders", and `/import` sits on the import path — the most correctness-critical code in the repo — which is the same reason the restyle above is parked. Mechanical when done: same formula, no behavior change, no tests. These two were filed as separate entries pointing at each other with "do them together"; they are one pass over one route.
  Blocked by: T15 landing (v0.16.0) for the restyle half; nothing for the amber half. (`src/app/import/page.tsx`, `src/app/import/preview/[id]/page.tsx`, `DESIGN.md`)

- [ ] **P3** — **A 6-month debt trend line, and the balance history it needs.** Decision DS58 gives each card a "paid down $500.00 this month" figure and puts the same aggregate under the dashboard's `Debt` subtotal, which closes the immediate feedback gap the design review found at step 6 of the user journey (you pay the card, the payment is correctly transfer-paired and therefore invisible to every spend query, and nothing in the app acknowledges it happened). What it does not close is the reflective read — *am I actually getting out of debt* across months. **This is currently unbuildable, and the reason is structural, not effort:** there is no historical balance series anywhere in the schema, and the mortgage has zero transaction rows by decision D3=A, so its history cannot be reconstructed the way a card's can. `accounts.prior_starting_balance_cents` stores exactly one prior value, not a series. Doing this properly means either a `balance_snapshots` table written on every anchor move and every sync balance pass, or accepting a cards-only chart that silently omits the largest debt you have. Recharts is already in and `src/components/ledger/trend-chart.tsx` is the pattern. Entangled with **payoff modeling**, deferred in the same plan for the same "wants a month of real data first" reason — decide them together. Blocked by: liability PR1 + PR2 shipped, plus enough months of data to make a line meaningful. (`src/db/schema.ts`, `src/components/ledger/trend-chart.tsx`, `src/lib/accounts/paidDownCents.ts`)

- [ ] **P2** — **Make `transactions.import_batch_id` nullable so manual rows are not batches at all.** Raised by Codex's outside-voice pass on 2026-09-07 during the second `/plan-eng-review` of `docs/plans/liability-accounts-and-budget-signals.md` (finding E21). Codex's framing: `import_batches` currently means an atomic write with one timestamp, one snapshot, one warning channel, one count, and batch-scoped undo assumptions like `isLatestBatch` — so hanging hand-entered card charges off it "turns batch into a junk drawer." The plan originally specified one manual batch created lazily and reused forever (D6=B point 4), which freezes `imported_at`, requires a read-modify-write increment on `transaction_count` for a number nobody reads, and permanently falsifies `snapshot_path`, `snapshot_warning`, `anchored_starting_balance_*` and `prior_starting_balance_*`. E21 moved it to **one batch per manual operation** — truthful, cheaper (no lazy lookup, no increment), and roughly 240 small rows a year at ~20 manual entries a month with no batch-list UI to clutter. This TODO is the fully-correct version: a hand-typed row genuinely is not an import, so `import_batch_id` should be nullable and the `'manual'` value should come back out of both `import_batches.source` and `transactions.import_source`, taking `batchLabel.ts`'s carve-out and `isLatestBatch`'s source filter with it. Deferred on risk, not merit: it reworks the `(account_id, import_batch_id, import_row_hash)` unique index that CLAUDE.md rule 3 depends on for CSV dedup — the most correctness-critical index in the schema — and every join on `import_batch_id` needs a null check. Do not ride this in the same PR as migration 0018 and five new write-path guards. Blocked by: liability accounts PR1 + PR2 shipped, so the manual write path exists and has been exercised against real data first.
  **This item WAS the 1.0.0 gate** (decided 2026-09-07 while shipping v0.16.0), on the reasoning that credit cards were the last thing on CLAUDE.md's "What's NOT in V1" list, so V1 is arguably feature-complete — but 1.0.0 also implies a settled data model, and calling 1.0 the release *before* reworking the most correctness-critical index in the schema is backwards. `PLAN.md` no longer calls it the gate.
  **CORRECTED 2026-09-08 (backlog-triage pass), merged in here 2026-09-09 — the stated risk above is misdiagnosed, and the item is blocked by its own precondition.** Both halves are worth keeping because the deferral above rests on the first one.
  1. **The unique index is not the hazard.** Both SQLite and Postgres treat NULLs as DISTINCT in a unique index, so a NULL `import_batch_id` never collides, and every CSV and SimpleFIN row still carries a non-null batch id — `(account_id, import_batch_id, import_row_hash)` keeps its exact current behavior for every row rule 3 cares about. The real hazard is the SQLite **table rebuild** that dropping `NOT NULL` requires (rule 7): `transactions` carries one self-referencing FK (`transfer_pair_id`; the second, `transfer_rejected_partner_id`, was removed in v0.19.0) and is the `onDelete: 'cascade'` parent of `import_batch_categorizations`. Plan around *that*.
  2. **Scope is smaller than the entry implies:** 25 non-test references across 7 files (measured 2026-09-08).
  3. **The precondition is unmet.** The item names its own blocker as the manual write path having "been exercised against real data first" — the live ledger had **0 manual batches and 0 manual transactions** at the 2026-09-08 measurement and still had 0 on 2026-09-09, so v0.16.0's hand-entered card path has never written a row. Blocked by: actually using the manual card-charge path.
  (`src/db/schema.ts`, `src/lib/accounts/manualTransaction.ts`, `src/lib/batchLabel.ts`, `src/lib/simplefin/undoSync.ts`, `PLAN.md`)

## Follow-ups from implementing the liability-accounts plan (2026-09-07)

Found while building, not while planning. Each is a real finding whose fix is
larger than, or orthogonal to, the feature.

- [ ] **P3** — **`DropdownMenuLabel` was broken as exported, and nothing caught it.** `src/components/ui/dropdown-menu.tsx` wraps Base UI's `Menu.GroupLabel`, which reads `MenuGroupContext` and THROWS (`Menu group parts must be used within <Menu.Group> or <Menu.RadioGroup>`) — and the module exported no `Group` to satisfy it. Using the label took the whole `/transactions` route into its error boundary. Fixed in place by adding `DropdownMenuGroup`, but the class of problem is worth naming: this file is a hand-written Base UI wrapper (no `components.json` registry entry), so every part it exports is a part somebody wrote and nobody exercised. `_category-menu.tsx`, its only consumer for months, uses Trigger/Content/Item/Separator and never a Label, so there was no way to find out short of using it. Worth an audit pass over the other hand-written `ui/` wrappers (`combobox.tsx` has by far the largest exported surface) for parts with zero consumers. Note this is the same shape as CLAUDE.md rule 6's `applyRuleAtImport` story — written, exported, documented, never called. (`src/components/ui/`)

- [ ] **P3** — **`/accounts` has no route-level test coverage, by convention.** CLAUDE.md scopes tests to logic, not UI components, and the route follows that: every rule it renders lives in a tested pure module (`accountClass`, `isLongTermLiability`, `summarizeBalances`, `resolveBalanceAction`, `resolveUtilizationDisplay`, `resolveStalenessDisplay`, `paidDownCents`, `rankByProximity`) and the write paths are tested through `manualTransaction.test.ts`. What is NOT covered anywhere is the wiring: that the row actually calls `resolveBalanceAction`, that DS56's handoff moves focus, that the D12 refusal renders its recovery. Those were verified once by hand in a browser and are now only protected by review. If this app ever adopts a component-test story, `/accounts` is where it pays for itself first — it has four independent per-row server actions live at once. (`src/app/accounts/`)

- [ ] **P3** — **The mobile layouts (DS65) were written but never seen at 375px.** The row-list surfaces use `flex-wrap` plus explicit `hidden sm:block` / `sm:hidden` pairs for the 5-row/3-row `Closest to limit` split, and every new action carries `min-h-11` (44px) with `w-full sm:w-auto` stacking. That is the DS65/DS66 spec implemented faithfully, but the browser harness used during implementation could not produce a narrow viewport (`innerWidth` stayed pinned at 1301 regardless of window size), so none of it was visually confirmed. **Attempted a second time during the v0.16.0 ship review and failed the same way** — `resize_window` to 375x812 left `window.innerWidth` at 1201, and the only running dev server belonged to a different checkout (`/accounts` 404'd against it). Two independent harnesses now, same outcome; treat browser-driven narrow-viewport checks in this repo as unavailable until someone confirms otherwise. Check `/accounts` and `/` at 375px on a real device or with DevTools device emulation before trusting it; the specific risks are the Visa row's five stacked metadata lines and the reconcile form's two inputs plus button. (`src/app/accounts/_account-row.tsx`, `src/app/accounts/_card-controls.tsx`, `src/app/page.tsx`)

- [ ] **P3** — **`resolveStalenessDisplay` is not wired to the asset rows, and the two date formats differ slightly.** Asset rows on `/accounts` render `updated Sep 6` from `ledgerAsOfDate` through a shared `formatMonthDay`, while liability rows render the full `resolveStalenessDisplay` label with its amber threshold. That is intentional — an asset's "staleness" is a different question (its newest posted row, not a hand-entered or fed balance) and CLAUDE.md rule 1 already has `classifyBalanceFreshness` for the drift version of it. But the two now sit adjacent in one list looking like the same field, and a reader will eventually assume the asset one goes amber too. Either give assets a real freshness rule or visually distinguish the two. (`src/app/accounts/_account-row.tsx`)

- [ ] **P3** — **The manual card write path deliberately takes no pre-write snapshot, and that decision should be revisited if it ever writes more than one row.** CLAUDE.md rule 5 says every batch import snapshots first, and `createCardActivity`/`markAsCardPayment` do create real `transactions` rows via a synthetic `import_batches` row — so they look batch-shaped. They are not: each writes exactly one row (plus, for a payment, one mirror), inside one transaction, reversible from the UI only in part — `unmarkCardPayment` deletes the mirror, but THERE WAS NO DELETE PATH FOR A HAND-ENTERED CHARGE (`delete(schema.transactions)` appeared only in `undoSync.ts` and for the payment mirror), so a mistyped charge needed raw SQL. **UPDATED 2026-09-09: that half is closed** — `removeCardActivity` ships a real delete path from the `/transactions` row menu, so the "reversible from the UI only in part" clause no longer weakens the argument below. What is still missing is an in-place EDIT; see **"There is no EDIT path for a hand-entered card charge"**. This follows the same reasoning E19 applied to anchor writes and rejected snapshotting for, and it matches the existing precedent that ordinary transaction writes (categorize, bulk-categorize) do not snapshot either. A whole-database `VACUUM INTO` before a single hand-typed row would also churn the retention-of-10 pool that `commitImport`/`syncSimpleFin` auto-prune, evicting a real import's snapshot to protect a $12 coffee. Raised by a review pass on 2026-09-07 as worth stating rather than leaving implicit. Revisit if the manual path ever grows a bulk entry mode. (`src/lib/accounts/manualTransaction.ts`)

## Follow-ups from the `/ship` pre-landing review (2026-09-07, liability accounts)

Seven specialists plus a second adversarial pass over the fixes. Everything
correctness-shaped was fixed in the PR; these are the ones deliberately left.

- [ ] **P3** — **`src/app/accounts/actions.test.ts` re-implements the Server Action pipeline instead of importing it.** The `reconcile()` and `revert()` helpers copy each action's chain line for line, so no assertion in the file can fail in response to a change in `actions.ts`. That is the pre-existing convention in this repo (`import/actions.test.ts`, `budget/actions.test.ts` do the same, because `revalidatePath`/`redirect` close over the singleton DB and cannot run under `:memory:`) — but it is precisely the blind spot that let the two DS64 negation copies drift apart while the suite stayed green, which is what the shared `owedDollarsToSignedCents` was extracted to fix. The durable fix is to move the DB-free portion of each action into an exported pure function that both `actions.ts` and the test import, so the test exercises the real path rather than a replica. Doing it for all four `/accounts` actions is a refactor of its own. (`src/app/accounts/actions.test.ts`, `src/app/accounts/actions.ts`)

- [ ] **P3** — **`MONEY_TONE_CLASS` and `TONE_CLASS` are two tone maps that agree on three of four keys.** `src/lib/money.ts`'s map is keyed `positive | negative | neutral | plain`; `src/lib/budget/resolveRowDisplay.ts`'s is `positive | negative | neutral | muted`. Both were added in the liability PR, and `money.ts`'s own docstring warns two paragraphs above it about exactly this ("two vocabularies for one rule"). Not merged in the PR because the two serve genuinely different callers — account rows versus budget rows — and collapsing them means picking one union and teaching every consumer the fifth member. Worth doing when a third tone map appears; that is the point at which the warning has come true. (`src/lib/money.ts`, `src/lib/budget/resolveRowDisplay.ts`)

- [ ] **P4** — **The `FIELD` / `LABEL` Tailwind constants are declared in three places.** `_charge-dialog.tsx`, `import/_create-account-form.tsx` and `_card-terms-form.tsx` each define their own, and the first two have already diverged by one class (`transition-colors`); `_balance-forms.tsx` inlines a fourth near-variant. Small, and the fix is a shared module, but it touches four form files for purely cosmetic gain and none of them are correctness-critical. (`src/app/accounts/`, `src/app/import/_create-account-form.tsx`)

- [ ] **P4** — **The dashboard's `BalanceRow` and `/accounts`' `AccountRow` re-implement the same name+amount header.** Same `isLongTermLiability` mute, same `moneyToneClass` context ternary, same `owed …` aria-label, differing only by `sm:px-5` and a tabular-nums utility — so DS59/DS66 have two implementations one Tailwind edit apart. `NetWorthRow` and `SubtotalRow` were extracted into `components/ledger/balance-list.tsx` for exactly this reason; this is the third candidate and the least trivial, because `AccountRow` also owns the utilization bar, staleness label and four action affordances the dashboard deliberately omits. (`src/app/page.tsx`, `src/app/accounts/_account-row.tsx`)

- [ ] **P4** — **`revertLiabilityBalanceAction` is a toggle, not an idempotent undo.** It swaps current and prior anchor, so submitting twice returns to where you started and reports success both times. That is deliberate — it makes the undo itself undoable, which is worth more on a single-user local app than one-shot semantics — but it means a stale second tab re-applies the balance the user just reverted, and the `has no previous balance to go back to` guard can never fire after the first revert. If this ever bites, the fix is a hidden `expectedCents` on the form, refusing when it no longer matches the stored anchor. (`src/app/accounts/actions.ts`)

## Follow-ups from the `/pr-review-toolkit:review-pr` pass on PR #41 (2026-09-07)

Fixed in the same pass, listed for the record: the normalizer header's false
"intra-phase steps are reorderable" claim (it invited a silent key-moving edit —
swapping phase 3's phone rule and `TRAILING_STATE` fails seven tests); the
backfill wrapper's dead stale-image detection (keyed on exit 127 and an
`err.message` that `stdio: "inherit"` guarantees is empty — a missing script
argument exits 1); the backfill's rollback snapshot sharing `PRE_MIGRATE_PREFIX`,
which `docker/entrypoint.src.mjs` prunes to 10 on every container boot (now
`BACKFILL_PREFIX`, unpruned); and the post-`--apply` verification block, whose
checks were unfalsifiable and whose results never reached the exit code.

Left open:

- [x] **The collision ranking now models `buildRuleMatcher`'s archived-category
      skip.** `src/lib/rules.ts` skips a rule whose category is archived (rule 8
      makes archiving inert, not deleting), so replicating only `compareRules`'
      sort let an archived rule outrank and DELETE the live rule that was
      actually firing. The rules query now joins `categories.archived_at`,
      archived-category rules sort last, and the `<= KEPT` / `-- deleted` lines
      mark them `(ARCHIVED — never fires)`. `conflicting` deliberately still
      counts an archived rule's category: that over-asks for
      `--resolve-conflicts`, which is the right direction for the one flag
      gating money movement.
- [x] **`contains`/`regex` rules are now reported, though still never
      rewritten** (a substring is not a key — rule 10). The plan counts each
      non-exact rule's reach against the old keys and the new ones and prints
      any that change, flagging a drop to zero as `DEAD, and no backfill can
      repair it`. Reported rather than refused on purpose: the normalizer change
      is what kills such a rule, at the moment it lands — refusing here would
      only withhold the repair for the rows.
- [x] **A degraded snapshot (`consistent: false`) now REFUSES rather than warns**,
      behind `--allow-degraded-snapshot`, exiting 3. This is not inconsistency
      with `commitImport`, which warns and proceeds: that path persists its
      warning to `import_batches.snapshot_warning` where `/import/success`
      renders it AND has a logical undo, so a degraded snapshot costs a safety
      net that is already doubled. This has neither, and rule 5's measured
      failure mode is a fallback copy that would not open at all
      (`SQLITE_CORRUPT`) — with a reader pinned, which this script always has by
      construction, since you reach it through `docker compose exec` into the
      running app container. The snapshot file is deliberately not deleted on
      the refusal path: `consistent: false` often still means a restorable plain
      copy, and discarding it to tidy an error path would throw away a
      possibly-good rollback point.
- [ ] **`runCli` has no test coverage at all.** `planBackfill` is well covered;
      every line that touches disk is not. The two-pass temp-value rewrite is
      the one piece of write logic the planner cannot express, and deleting it
      leaves the whole suite green. **Priority:** P2. Fix: a tmp-file
      better-sqlite3 DB with the real `drizzle/` migrations, seeded with a
      swap-shaped collision (rule A `"X"→"Y"` while rule B holds `"Y"→"X"`).
      The wrapper is now testable too — `main` takes an injectable `exec`.
- [ ] **"Largest group wins" has no defined tie-break.** `sort` by count
      descending is stable, so a 1-vs-1 split resolves to whichever key the
      `SELECT` (which has no `ORDER BY`) happened to return first. The CLI
      prints `x1, x1` with no marker that the choice was arbitrary.
      **Priority:** P3.
- [ ] **Deleted subscription dismissals are reported as a count, never by
      name.** `dismissalPlan` carries `from`/`next` and throws them away.
      Collisions get a full per-rule listing; dismissals get an integer, and the
      rows are unreachable from the UI by construction. **Priority:** P3.
- [ ] **A plain dry run exits 2 on a category-conflicting collision**, before
      the `DRY RUN — nothing written` line, and suggests a command strictly more
      dangerous than the read-only one that was asked for. Intentional, but
      undocumented as a *dry-run* behavior. **Priority:** P3.

## Follow-ups from the `/plan-design-review` pass (2026-09-07, categorize-merchant-drilldown plan)

Design review of [docs/plans/categorize-merchant-drilldown.md](./docs/plans/categorize-merchant-drilldown.md), run after the eng review. Eight decisions (`D16`-`D23`) were folded into that plan as a new "Design specification" section, along with 10 new implementation tasks (T6-T15). Two outside voices ran (Codex gpt-5.4 + a fresh Claude subagent) and agreed 7/7 on the litmus scorecard; both independently triggered hard rejection #7 (app UI made of stacked cards instead of layout), which `D17` closes. These three were captured here instead — each is real but larger than, or orthogonal to, the drilldown feature.

- [x] **P2 → CLOSED (2026-09-17, `docs/plans/cache-components-migration.md`).** `cacheComponents: true` is on. `_pending-pick.ts` is deleted — `_merchant-row.tsx`'s pick is plain `useState` now, and Activity preserves it across the `/categorize` → `/transactions` → back round trip for free, verified live through 8+ intervening route visits (well past the docs' "3 routes" figure) on both `pnpm dev` and a production standalone build. `prunePendingPicks` is gone with it: component state has no afterlife to prune (sessionStorage did, which is why that function existed).
  **The migration was staged by risk, not flipped blind, because the audit found the real hazard wasn't route-config migration (that part was trivial) but Activity's blanket, non-incremental change to navigation itself — this app has real correctness, not just UX, riding on "leaving a route resets its state" in several places.** Two silent-freeze bugs were caught and fixed along the way, both invisible to `pnpm build`'s error output and only found by reading its route table: `/api/health` had gone fully `○ Static` (its `db.get()` call is a plain synchronous read the Cache Components validator can't see, so the healthcheck would have frozen `{ok:true}` forever regardless of real DB health — fixed with `await connection()`) and `/budget/categories` was eligible for the same freeze (archiving/unarchiving a category would never have shown up there again). A third, distinct problem hit `pnpm build` itself as a hard FAILURE rather than a silent freeze: `Spine`'s root-layout `connection()` call and `SpineMonth`/`SpineTabs`' `usePathname()` reads both blocked the static shell of routes with nothing else to make them dynamic (chiefly `/_not-found`) — fixed with the `<Suspense>` split below (pre-landing review, maintainability specialist — the original version of this note conflated all three under one "both are synchronous DB reads" claim, which was only true of the first two). Four real stale-state regressions were found live and fixed: `CardTermsDisclosure`/`ReconcileDisclosure` (`/accounts`) stayed OPEN with a stale "Updated…" message after a nav-away-and-back (new shared `useCloseOnHide` hook, `src/components/ledger/use-close-on-hide.ts`); `/goals`' `UpdateTargetForm` and `CreateGoalForm`, and `/import`'s `CreateAccountForm`, had no toggle at all to close but still showed a stale success/error message the same way (new shared `useStatusResetOnHide` hook, `src/components/ledger/use-status-reset-on-hide.ts`) — the first version of that hook read a ref during render and failed this repo's `react-hooks/refs` lint rule, rewritten to pure `useState` with a `[state]`-keyed effect instead. `/budget/[year]/[month]`'s live-editor flush-on-leave and its freshness-on-return were BOTH verified correct with no changes needed (effect cleanups fire on Activity-hide the same as unmount; `revalidatePath` correctly busts the Activity-cached RSC payload — watched Spent recompute live across a return visit). `/sync` survived a real navigate-away-mid-pending-sync repro cleanly. `/transactions`' `_retarget-form.tsx` had two separate TODOS.md-documented P4 residuals (below); only one of them — the missing `key={normalizedMerchant}` — had its risk widened by Activity, and is now closed by `<RetargetForm key={merchant}>` rather than left deferred a second time. The other (the `chosenIsGone` banner/Remember-guard message co-render overlap) is an unrelated display-only issue this migration doesn't touch and stays open. `_reclassify-income.tsx`'s uncontrolled shadcn `Dialog` (no explicit `open`/`onOpenChange`) was assessed and left as a recorded residual: it's "unreachable today" per its own docstring (zero income categories never happens with real seeded data), so fixing its Activity-preserved-open-dialog risk blind wasn't worth doing under this pass — pick it up if that banner ever becomes reachable. The toast-reporting components (`_unarchive-button.tsx`, `_categorize-buttons.tsx`) were reviewed and are correctly unaffected — they never held persistent inline state to begin with. `_charge-dialog.tsx` needed a closer look than "unaffected" (pre-landing review, maintainability specialist — its own success path closes-and-toasts, but that leaves the REFUSAL path unexamined, and this hook's own docstring names `_charge-dialog.tsx` alongside the two disclosures it WAS wired into): on a refusal the dialog stays open showing the error message, with no reset. Traced through rather than assumed safe: the message describes why THIS typed draft (amount/date/merchant/category, all controlled state) was refused, and Activity preserves the draft and the message together — so on return the message is still describing the form exactly as it reads, not a stale claim about something that already happened (the class of bug `useCloseOnHide`/`useStatusResetOnHide` exist for). That is also exactly the "preserve a draft the user was composing" case Next's own preserving-UI-state guide recommends keeping. Deliberately NOT wired to `useCloseOnHide` — doing so would discard a legitimately-preserved, still-accurate draft+explanation pair, not fix a bug. 2241 tests pass (2269 baseline minus 28 deleted `_pending-pick.test.ts` cases), `tsc --noEmit` clean, lint clean. (`next.config.ts`, `src/app/categorize/_merchant-row.tsx`, `src/app/categorize/_categorize-ui.tsx`, `src/app/sync/page.tsx`, `src/app/api/health/route.ts`, `src/app/budget/categories/page.tsx`, `src/components/ledger/spine.tsx`, `src/components/ledger/spine-month.tsx`, `src/components/ledger/spine-tabs.tsx`, `src/components/ledger/use-close-on-hide.ts`, `src/components/ledger/use-status-reset-on-hide.ts`, `src/app/accounts/_card-terms-form.tsx`, `src/app/accounts/_balance-forms.tsx`, `src/app/goals/_goal-forms.tsx`, `src/app/import/_create-account-form.tsx`, `src/app/transactions/page.tsx`)

- [ ] **P3** — **Give the other eight `/transactions` filters the removal affordance `merchant` gets.** `D18` rebuilds `FilterSummary` from a `parts.join(" · ")` `<p>` into a real chip row, where the active merchant renders as a filled terracotta chip with an `×` that drops only that filter. The other eight (search, account, category, dateFrom, dateTo, amountMin, amountMax, pending) render as non-removable outline chips, so the only way to drop one WITHOUT retyping the others is `clearFiltersHref`, which wipes all nine at once. (Each of the eight does have its own `name=`d control in `FilterBar` — blank it and hit "Apply filters" — and `clearFiltersHref` is no longer a bare `/transactions`: it preserves `pageSize`, deliberately.) This asymmetry is deliberate, not an oversight: merchant is the only result-shaping filter with **no control in the `FilterBar` panel below** (a typeable merchant input was rejected — `merchant=` is exact-match on a normalized key, so typing `amazon` silently returns zero rows), which is exactly why it needed a chip and the others did not. Recorded so the next reader files it as a decision rather than an unfinished job. If picked up, the cost is per-filter markup on a chip row that already exists after T9 — no new machinery — but weigh it against nine chips stacked above a panel that already edits all nine. Blocked by: T9 landing. (`src/app/transactions/page.tsx`)

## Follow-ups from the post-implementation review (2026-09-07, categorize-merchant-drilldown)

Three `feature-dev:code-reviewer` agents reviewed the implemented branch in parallel (correctness, simplicity/DRY, project conventions). Everything they raised was either fixed in the branch or is recorded below. Both entries here are refactors that would have grown the feature PR's blast radius past the files it otherwise needed to touch, which is the only reason they are not done.

- [ ] **P3** — **Extend `BacklogBanner` with a trailing slot instead of hand-rolling a third and fourth amber banner.** `src/app/_components/BacklogBanner.tsx` already owns the sticky amber strip: `-mx-5` bleed, `backdrop-blur`, the shared `color-mix(in oklch, var(--accent-amber) 18%/45%/50%, …)` formula, and a `variant` prop that decides whether the CTA link renders. `_categorize-ui.tsx`'s `BacklogHeader` and `_transactions-ui.tsx`'s `BacklogStrip` are near-duplicates of it, reimplemented rather than reused, because each needs something the component does not expose — the categorize one carries T15's `N of 181 merchants done` progress counter on the right, the transactions one a `Bulk →` link, and the categorize one takes a *live* client-side count rather than the server `UncategorizedBacklog` object. All three would collapse into `BacklogBanner` given (a) a `trailing?: React.ReactNode` slot and (b) accepting `count`/`totalCents` directly instead of only the whole backlog object. T14/D21 converted the two copies onto the amber token so at least the *colour* can no longer drift three ways, but the shell still can — and DESIGN.md's amber inventory now has to name three call sites where it should name one. Not done in the feature PR because `BacklogBanner` is rendered by `/budget` too, so changing its API means regression-testing a page the drilldown never touched. Blocked by: nothing. (`src/app/_components/BacklogBanner.tsx`, `src/app/categorize/_categorize-ui.tsx`, `src/app/transactions/_transactions-ui.tsx`, `DESIGN.md`'s amber table)

- [ ] **P3** — **Move `/transactions`' header components out of `page.tsx` into `_filter-header.tsx`.** `FilterHeader`, `FilterChips` and `MerchantSummary` (D18's header block) live inline in `src/app/transactions/page.tsx` and are roughly half its length, which leaves the page doing both data-fetch/compose *and* header rendering. Every sibling piece of this feature's UI is already its own file — `_filter-bar.tsx`, `_transaction-row.tsx`, `_transactions-ui.tsx`, `_row-menu.tsx` — and `categorize/page.tsx` is the shape this one should match: parse, load, compose, done. Purely mechanical (the three components are cohesive and share no state with the page beyond their props); the reason it is parked is that it would have added a fourth new file to a PR that had already grown from 5 files to 22, for zero user-visible change. Do it the next time this file is opened for another reason. Blocked by: nothing. (`src/app/transactions/page.tsx`, new `src/app/transactions/_filter-header.tsx`)

## Follow-ups from the `/ship` pre-landing review (2026-09-07, categorize-merchant-drilldown)

Six specialist reviewers (testing, maintainability, security, performance, design, red team) ran against the implemented branch. Fifteen findings were fixed in the branch and are in the v0.18.0 CHANGELOG; the rest were recorded here. A later six-agent review pass (code, tests, comments, silent failures, type design, simplification) then closed two more of these entries in-branch — the `pageSize` P2 and the `MAX_SEARCH_LENGTH` recovery P3, both now fixed and removed from this list. The `pageSize` fix is the one worth knowing about: `pageSize` is now a member of `TransactionsFilterValues`, so the exhaustiveness guard covers it, and a new compile-time assertion in `_filter-bar.test.ts` closes the third edge of the contract — a key that exists in the schema but was never added to the filter type, which is how `pageSize` escaped the guard in the first place. The 375px expanded-disclosure layout that the plan flagged as "unresolved — needs eyes at implementation" was verified live at 390px against a purpose-built fixture ledger during this ship, and produced one of the fixes (the promoted memo line was truncating to one line), so it is closed rather than parked.

- [x] **P3 — DONE** — **A merchant that comes back is invisible for the rest of the sitting.** `_categorize-ui.tsx`'s `dismissed` set was write-mostly: `groups = initialGroups.filter((g) => !dismissed.has(g.normalizedMerchant))`, and the only removal path was the toast's Undo inside its 10s window. Both categorize actions `revalidatePath("/categorize")`, so an import, a `/sync`, or an undo in another tab could put new uncategorized rows under an already-dismissed merchant and the client kept filtering it out. Fixed by splitting the one set into TWO with different lifetimes, which is what the entry above could not see: `done` is monotonic and feeds only the progress counter; `hidden` feeds only the filter and is CLEARED on every new server payload, because the list the server just sent is authoritative about what is left. That is simpler than the reconcile this entry proposed (record the count dismissed at, un-dismiss when the server reports more) and needs no per-merchant bookkeeping. The optimistic hide still works: between the submit and the revalidation, `initialGroups` is the same array identity, so `hidden` survives exactly as long as it is useful. Cleared during render rather than in a `useEffect` — an effect would paint one frame with the previous payload's hidden set applied to the new list, a visible flicker on precisely the rows this fixes. `totalMerchants` became a UNION rather than `groups.length + done.size`, because a merchant that comes back is now in both sets at once and adding the sizes double-counted it. (`src/app/categorize/_categorize-ui.tsx`)

- [ ] **P3** — **Merging `categoryId` into a merchant link nullifies the header the same feature added.** D23 makes a row's merchant link merge into the active filters rather than replace them, which is right for a date range. It is wrong for `categoryId`: `summarizeByCategory` shares `buildPredicates` with the list, so clicking a merchant from `/transactions?categoryId=none` produces a breakdown containing only the NULL bucket. The header renders `53 rows, 53 uncategorized` with no `· 49 filed as Gas` — the filing history its own docstring calls "the answer you clicked to ask" — and nothing says why it is missing. Either drop `categoryId` (and probably `pending`) when adding a merchant, or have `MerchantSummary` say the breakdown is scoped by an active category filter. Blocked by: nothing. (`src/app/transactions/_transaction-row.tsx`'s `PrimaryLabel`, `src/app/transactions/page.tsx`'s `MerchantSummary`)

- [ ] **P3** — **The focus treatment is inconsistent in two directions at once.** (Merged 2026-09-09: filed twice — the token-drift half here, the `/sync` coverage half as a P4 in the sync pending-state review. One look at the focus story fixes both; two looks is how they diverge again.)
  **Token drift.** `src/components/ledger/focus-ring.ts` hardcodes `outline-[var(--accent-terracotta)]` at full strength, while `globals.css` already defines `--ring` as `color-mix(in oklch, var(--accent-terracotta) 55%, transparent)` for exactly this purpose, and every shadcn control uses it (`button.tsx` `focus-visible:ring-ring`, `input.tsx` `focus-visible:ring-ring/50`). So they differ in both colour strength and geometry — the drift the constant was extracted to stop, one level up. Switching to `outline-[var(--ring)]` keeps the `outline` geometry (which is deliberate, see the comment) and adopts the token. Wants a look at both together before changing, since it makes the hand-rolled ring visibly softer.
  **Coverage.** None of `/sync`'s five submit buttons carries `FOCUS_RING` at all, so they fall back to the UA outline while 17 call sites across six other files use the terracotta ring. `DESIGN.md` names `FOCUS_RING` as the one focus treatment for interactive elements outside `components/ui`, including buttons written inline. Pre-existing, but `SubmitButton` (`src/app/sync/_submit-button.tsx`) is now the single place that fixes all five at once: fold it into the `cn(...)` there. Every caller already carries `rounded-md`. Do it with the `SubmitButton` promotion to `src/components/ledger/` if that lands first — one edit instead of two.
  Blocked by: nothing. (`src/components/ledger/focus-ring.ts`, `src/app/globals.css`, `src/app/sync/_submit-button.tsx`)

- [ ] **P3** — **Real bank data predating this branch is still in the public repo's test fixtures.** The v0.18.0 ship anonymized every live-ledger merchant key this branch introduced, but the security reviewer's sweep also surfaces older ones that were already on `main`: `src/lib/normalize.test.ts:692` (`FD *CA DMV 658 *SVC 800-777-0133 CA`), `src/lib/rules.test.ts:56` (`SHELL OIL 1234`), and `src/lib/__fixtures__/sample-checking.csv`. Store numbers and a phone number, in a public repo. These are load-bearing normalizer fixtures — `normalize.test.ts` pins the exact transformation — so substituting them means re-deriving what each case proves, not a search-and-replace. Do it in one deliberate pass rather than opportunistically. Blocked by: nothing. (`src/lib/normalize.test.ts`, `src/lib/rules.test.ts`, `src/lib/__fixtures__/`)

- [ ] **P3** — **`merchantDrilldownHref` lives in `src/lib/budget/` and no longer has a reason to.** Its docstring justifies the location as "beside its sibling, rather than opening a third URL-builder module" — but the same PR opened `src/lib/transactions/searchParams.ts`, which owns the `merchant` param this function emits and the `flatten()` behaviour its docstring reasons about. The result is `/categorize` importing a categorize→transactions link builder from `@/lib/budget/` with no budget involvement anywhere on the path. Move it beside its actual contract partners, or update the rationale to describe the layout as shipped. Blocked by: nothing. (`src/lib/budget/transactionsDrilldownHref.ts`, `src/lib/transactions/`)

- [ ] **P3** — **Pre-existing touch-target and contrast gaps the design pass surfaced but that this branch did not introduce.** The 44px floor (DS66) that every new control in this feature meets is not met by the two row Save/Submit buttons (`h-8` = 32px, `_merchant-row.tsx`, `_transaction-row.tsx`), the eight `/transactions` filter-bar inputs and selects (`py-1` ≈ 29px, and `text-sm` = 13px, which makes iOS Safari zoom the viewport on focus; the ninth control, the Apply button at `py-1.5`, is under the 44px floor but is not an input, so the zoom half does not reach it), or `/categorize`'s `← Budget` back link (which also has no focus ring, while its `/transactions` mirror got both). Separately, the sample memos and the row memo line render `--ink-3` at 11px, which computes to ~4.23:1 on `--paper-0` — under the 4.5:1 AA floor for text that size, on the text the disclosure exists to show. The contrast one is worth fixing first and is a one-token change to `text-ink-2`; it is parked only because it changes the look of a surface a design review just signed off on, so it wants eyes rather than a unilateral edit.
  **A third contrast case, filed separately and merged in here 2026-09-09 because its own entry said it belonged here: the two halves of the merchant drilldown use different VISITED tones.** `_merchant-row.tsx` sets `visited:text-ink-3`, `_transaction-row.tsx` sets `visited:text-ink-2`, and both docstrings justify `visited:` with the same argument (a page worked through in passes). `ink-3` measures ~4.23:1 on `--paper-0`, so following a link on `/categorize` drops its text under AA — on the page most likely to be worked through in passes. Same look, same token change, same eyes; do not fix it alone.
  Blocked by: nothing. (`src/app/categorize/_merchant-row.tsx`, `src/app/transactions/_transaction-row.tsx`, `src/app/transactions/_filter-bar.tsx`, `src/app/categorize/page.tsx`)

## Follow-ups from the `/ship` pre-landing review (2026-09-08, categorize-merchant-drilldown, second pass)

Seven specialists (testing, maintainability, security, performance, design, simplification, red team) re-ran against the branch after the six-agent fix pass. Fifteen findings were fixed in-branch and are in the v0.18.0 CHANGELOG — the `includeTransfers` empty-state misdiagnosis, the `/categorize` → `/transactions` revalidation gap, the empty-merchant-key asymmetry, the order-dependent session-storage suite, the recovery-link tests that asserted against a copy of the code, the `191`/`181` count, two false claims in the focus-ring docstring, two overstated docstrings, and three missing focus rings. Performance found nothing; the security finding was a false positive (all four flagged AMAZON tokens return zero hits against the live ledger). The rest are recorded here. Five earlier design findings (the `h-8` submit buttons, the filter-slab density, the `--ink-3` memo contrast, `/categorize`'s `← Budget` link, the third amber banner) are NOT repeated below — they are already parked in the section above.

- [x] **P2 → CLOSED (2026-09-17, v1.4.2).** **`Categorize all N →` can promise rows `/categorize` structurally cannot offer.**
      Took the second of the entry's own two named options: kept one breakdown
      and made the CTA say the count is scoped, rather than forcing
      `includeTransfers` false (which would have made the header describe a
      row set the list itself is not showing — the exact thing sharing
      `buildPredicates` exists to prevent). `MerchantSummary`'s `scoped` prop
      already existed for every OTHER filter (`hasNonMerchantFilters`); it
      just didn't know `includeTransfers` was in the same class, because
      `hasNonMerchantFilters` deliberately excludes it — correctly, for the
      different question IT answers ("why is the list empty", where a
      widening toggle can never be at fault; see its own docstring).
      Verified live (not unit tested initially — `MerchantSummary` is a UI
      component, out of V1 test scope): `CHEAPER CIGARETTES MANTECA` (11
      transfer-paired uncategorized rows of 34) read "Categorize all 34 →"
      before the fix with `includeTransfers=true`, and "Categorize this
      merchant →" (no number) after. The unaffected case (`includeTransfers`
      off) is unchanged: "Categorize all 23 →", matching what `/categorize`
      can actually show.
      **`/ship`'s pre-landing review (2026-09-17) found and fixed two more
      things, both same-session.** The Testing specialist flagged the
      `scoped` decision itself as money-consequential logic left inlined with
      zero coverage — extracted into `isMerchantSummaryScoped(values)`
      (`_filter-bar.tsx`, exported, composing `hasNonMerchantFilters(values)
      || values.includeTransfers === true`), called from `page.tsx`, with 4
      new unit tests. The Maintainability specialist caught a genuine
      overclaim in both new docstrings — "a transfer-paired row is ALWAYS
      `category_id IS NULL`" is false (`linkCardPayment`'s D4.1 warns rather
      than refuses when the source leg is already categorized, and
      `linkTransferPairManually` never touches `categoryId`), and the
      "(rule 3)" citation attached to it didn't support the claim (rule 3 is
      about dedup keys, not transfer pairing) — corrected to "usually, not
      provably always uncategorized," verified against both functions by two
      independent passes (structured + adversarial). Both adversarial passes
      (Claude subagent, Codex) then ran clean — no fixable findings.
      2247/2247 tests pass, `tsc --noEmit` clean, lint clean.
      (`src/app/transactions/page.tsx`, `src/app/transactions/_filter-bar.tsx`,
      `src/app/transactions/_filter-bar.test.ts`)
      Original entry:
      **`Categorize all N →` can promise rows `/categorize` structurally cannot offer.** With `?merchant=X&includeTransfers=true`, `summarizeByCategory` shares the list's predicates (correctly), so transfer-paired rows land in the NULL-category bucket — they always carry `category_id = NULL`, deliberately. `MerchantSummary` derives `uncategorized` from that bucket and links to `/categorize`, whose `loadMerchantGroups` excludes paired rows unconditionally (`isNull(transferPairId)`) and whose `bulkCategorize` refuses them. The header says N; the destination can only ever show fewer. The fix is a design call, not a mechanic: either compute the actionable figure with `includeTransfers` forced false — which makes the header describe a row set the list is not showing, the exact thing sharing `buildPredicates` exists to prevent — or keep one breakdown and say the count is scoped. Narrow to reach (needs the transfers toggle AND a merchant with paired rows), which is why it is not fixed blind. Blocked by: nothing. (`src/app/transactions/page.tsx`'s `MerchantSummary`, `src/lib/categorize/loadTransactions.ts`)

- [ ] **P3** — **`merchant` is gated two different ways, and only `flatten` keeps them agreeing.** `buildPredicates` tests `filter.merchant !== undefined && filter.merchant !== ""`, while EIGHT render sites test `!== undefined` alone: in `page.tsx` the `← Categorize` back link, the removable chip and the `categoryBreakdown` switch; plus `_transaction-row.tsx`'s `merchantFiltered` dimming switch, `PrimaryLabel`'s memo promotion and `TransferRowItem`, and `_transactions-ui.tsx`'s column-header label and merchant `EmptyState`. Today `flatten` drops `""` so the states cannot diverge — but the `!== ""` guard exists precisely because that is not being relied on, and if it is ever reached the page renders an empty chip, a return link and a merchant breakdown over an unfiltered 1,540-row list. One line fixes it for good: normalize `parsed.data.merchant || undefined` once, right after the parse, so predicate and render read the same value. Blocked by: nothing. (`src/app/transactions/page.tsx`, `src/lib/categorize/loadTransactions.ts`)

- [ ] **P3** — **`resolveActiveCategoryName` and `resolveActiveAccountName` are module-private in `page.tsx` and unreachable from a test.** The same condition D11 fixed for `resolveIsPending` by extracting it, left in place for its two siblings. Their unmatched-id branch is what makes `FilterChips` fall back to `Category {id}` for an archived category arriving from an old `/budget` drilldown, and nothing exercises it. Move them beside `resolveIsPending` and cover the three branches each (unset, matched, unmatched). Blocked by: nothing. (`src/app/transactions/page.tsx`, `src/lib/transactions/searchParams.ts`)

- [ ] **P3** — **`ColumnHeaders` and `TransactionColumnHeaders` are the same component written twice**, down to a copied six-line comment explaining the `cn()`-not-a-template-string choice; and `Pagination`'s Prev/Next are four near-identical blocks whose enabled class string is spelled a third time as `EmptyState`'s `actionClass`. Roughly 27 lines. Advisory only — neither is a defect, and both were left alone deliberately rather than churn an otherwise-ready PR. Do them the next time either file is opened. Blocked by: nothing. (`src/app/categorize/_categorize-ui.tsx`, `src/app/transactions/_transaction-row.tsx`, `src/app/transactions/_transactions-ui.tsx`)

- [ ] **P3** — **The drilldown renders inside the disclosure when there is something to disclose, and beside it when there is not.** `_merchant-row.tsx`'s docstring says the link "is rendered in BOTH branches, not just inside the panel," which is literally true and was a deliberate reversal of D22. But in the with-samples branch it sits inside the collapsed `<details>`, so "See all N transactions →" is one click away on the ~10% of groups that cannot explain themselves and two clicks away on the rest — the opposite of the emphasis the comment argues for. Either hoist it out of `<details>` in both branches or say in the comment that it is deliberately behind the disclosure whenever there is something to disclose. Blocked by: nothing. (`src/app/categorize/_merchant-row.tsx`)

## Follow-ups from the `/pr-review-toolkit:review-pr` pass on PR #43 (2026-09-08)

Six specialists (code, tests, comments, silent failures, type design, simplification) reviewed the branch after the second `/ship` pass. Everything below was verified against the live ledger or by mutation before being written down. Nineteen findings were fixed in-branch and are in the v0.18.0 CHANGELOG. One was disproven and dropped: the security sweep's flagged AMAZON reference tokens return zero hits against the ledger, so they are synthetic. The rest are here.

The test findings in this section are unusual in that each was PROVEN by mutating the source and confirming the whole suite stayed green — they are known-unbound, not suspected-unbound.

- [x] **P2 → CLOSED (2026-09-15).** **`page.tsx`'s header derivations and range guards are unbound.** Fixed by extraction, exactly as this entry's own fix line suggested: `isDateRangeInverted`/`isAmountRangeInverted`/`pendingFilterChipLabel` now live beside `resolveIsPending` in `searchParams.ts`, and `uncategorizedCount`/`filedBreakdownRows` live beside `CategoryBreakdownRow` in `loadTransactions.ts`. `page.tsx`'s three call sites (`FilterHeader`'s two `notFound()` guards, `FilterChips`, `MerchantSummary`) now call these instead of inlining the comparisons. Each mutation this entry named (`>` → `<` on both range guards, swapping the two `pendingFilterChipLabel` branches, swapping which bucket `uncategorizedCount`/`filedBreakdownRows` reads) was verified by hand to fail its new direct test before being reverted — proven, not merely asserted fixed. 2163 tests pass (was 2132), `tsc --noEmit` clean. (`src/lib/transactions/searchParams.ts`, `src/lib/categorize/loadTransactions.ts`, `src/app/transactions/page.tsx`)

- [x] **P2 → CLOSED (2026-09-15).** **`FilterBar`'s two quick links are inline, which is the defect `merchantSearchRecoveryHref` was extracted to fix, left standing on its siblings.** Fixed exactly as specced: `thisMonthHref(values, year, month)` and `clearFiltersHref(values)` are now exported from `_filter-bar.tsx` beside `merchantSearchRecoveryHref`, and `FilterBar` calls them instead of holding local consts. Both named mutations (`clearFiltersHref` dropping the `pageSize` carry-forward, `thisMonthHref` dropping the `...values` spread) were verified to fail their new direct tests before being reverted. (`src/app/transactions/_filter-bar.tsx`, `src/app/transactions/_filter-bar.test.ts`)

- [x] **P2 → CLOSED (2026-09-15).** **The fourth carry-forward gate is asserted against the serializer, not against the form.** Closed via the source-text-scan option this entry named, not a jsdom project: a new test in `_filter-bar.test.ts` reads `_filter-bar.tsx`'s own source with `readFileSync`, extracts every `name="..."` string literal with a regex, and asserts that set equals `VISIBLE_FIELDS` exactly. This is a fact about the source text, not a render, so it does not cross into the UI-component testing CLAUDE.md rules out of V1 — the open question this entry left unresolved. Verified against the exact scenario named: renaming `<select name="pending">` to `name="status"` while leaving `"pending"` in `VISIBLE_FIELDS` fails the new assertion (confirmed by hand, then reverted). (`src/app/transactions/_filter-bar.tsx`, `src/app/transactions/_filter-bar.test.ts`)

- [ ] **P3** — **`merchantDrilldownHref` and `transactionsDrilldownHref` build `/transactions` URLs from bare string literals and no test proves those names parse.** Both bypass `filterValuesToSearchParams` entirely, so they sit outside all four contract gates; `transactionsDrilldownHref.test.ts` never imports `searchParamsSchema`. The docstring records this class happening once already (`year`/`month`), and `.strict()` changed its symptom from "silently widens" to "404s", not from "happens" to "cannot happen". Six lines: round-trip both builders' output through `searchParamsSchema.safeParse(flatten(...))`. Blocked by: nothing. (`src/lib/budget/transactionsDrilldownHref.test.ts`)

- [ ] **P3** — **The `"page"` exemption is not pinned to the schema.** `Exclude<SchemaKey, ... | "page">` does not error when `"page"` is absent from `SchemaKey`, so renaming it in the schema leaves a stale exemption while `_transactions-ui.tsx`'s bare `params.set("page", ...)` keeps emitting a param `.strict()` now rejects — every page-2 link 404s. One line: `const PAGE_PARAM = "page" satisfies SchemaKey`, used at both sites. Blocked by: nothing. (`src/app/transactions/_filter-bar.test.ts`, `src/app/transactions/_transactions-ui.tsx`)

- [x] **P3 → MOOT (2026-09-17, `docs/plans/cache-components-migration.md`).** **`hydrate()` claims the store before the walk, so a partial failure is permanent.** Superseded, not fixed: `src/app/categorize/_pending-pick.ts` — the whole module this bug lived in — was deleted in the cache-components-migration (Stage 2), replaced by plain component `useState` with no `sessionStorage` hydration step to have this bug at all. Left here as a record that the class of bug existed, not as an open action item. (was: `src/app/categorize/_pending-pick.ts`)

- [x] **P3 → MOOT (2026-09-17, `docs/plans/cache-components-migration.md`).** **`hydrate()`'s namespace filter is unbound, and dropping it has a concrete consequence.** Same supersession as the entry above — the file this bug lived in is deleted. (was: `src/app/categorize/_pending-pick.test.ts`)

- [ ] **P3** — **Three test titles assert facts their fixtures do not establish.** `loadTransactions.test.ts`'s "matches URL-hostile keys literally — no wildcard" uses `#`, `*`, `/` — not one `LIKE` wildcard (`%` or `_`), so the title's central claim is the one thing untested; add `UTIL_CO` with a decoy `UTILXCO`. Its "sorts Uncategorized last even when it is the biggest group" uses a 1-vs-1 tie, and when uncategorized genuinely is biggest the behaviour is the opposite. And `loadMerchantGroups.test.ts`'s `expect(memo).toMatch(/AM/)` is decorative — every fixture memo contains "AM". Blocked by: nothing. (`src/lib/categorize/loadTransactions.test.ts`, `src/lib/categorize/loadMerchantGroups.test.ts`)

- [ ] **P3** — **Simplification, verified and not taken.** `page.tsx:88-89,136-151` hand-rebuilds a shape the schema already produces — `const { page: pageParam, ...rest } = parsed.data` is ~13 lines shorter and structurally deletes the hazard the four-line comment beside it warns about, at the cost of losing this site's excess-property check (`NO_UNCARRIED_SCHEMA_KEYS` still catches it, one file over). `_merchant-row.tsx` spells the merchant-name span twice and the copies had already diverged on `title` (fixed this pass; a local `MerchantName` component would stop it recurring). `loadMerchantGroups.test.ts` has a 22-line transfer-pair block duplicated verbatim plus a 4× `expect(group).toBeDefined()` preamble (~35 lines). None fixes a defect. Blocked by: nothing. (various) (`_pending-pick.test.ts`'s own fresh-module/warn-once duplication, previously listed here, is moot — the file was deleted in the cache-components-migration.)

- [ ] **P4** — **`seedAccount`/`seedBatch`/`seedCategory`/`seedTxn` are duplicated across 31 files.** (Merged 2026-09-09: filed three times, at 13, 19 and "13+" files. The real count, re-measured on this branch with `grep -rl "function seedAccount" src/ | wc -l`, is **31** — 30 `*.test.ts` files plus `src/lib/simplefin/test/syncFixtures.ts`, which is itself the shared home built for one suite pair. Every stated figure in this file was low; each was true when written and none was re-measured.) Roughly 1,400 lines. `src/lib/test/db.ts` already exists as the shared test-infra home; the concrete move is the four seeders into `src/lib/test/seed.ts`, parameterized on `TestDbHandle`, with `syncFixtures.ts` re-exporting rather than re-declaring. Entirely pre-existing and it grows by one or two files per release, which is why the count keeps being wrong rather than merely stale. Blocked by: nothing — it just wants to be the only thing in its diff, because it touches 31 files. (`src/lib/test/db.ts`, new `src/lib/test/seed.ts`, 30 `*.test.ts` files, `src/lib/simplefin/test/syncFixtures.ts`)

## Follow-ups from the `/plan-eng-review` backlog-triage pass (2026-09-08)

Triage of the 91 open items above, run against the **live ledger** rather than
the docs. Two items in this file were disproven and one new defect was found;
the sign-convention half was fixed in the same pass (D2=A) and is in the
CHANGELOG. Codex (gpt-5.4) ran as the outside voice and independently reached
the same verdict on the 1.0.0 gate.

- [x] **P1 — DONE** — **A same-account transfer and its reversal were structurally unpairable, so both legs landed in a spend category.** Every pairing path required the two legs to span two DIFFERENT accounts — `transferPair.ts:60`, `matchTransfers.ts` (`if (accountIds.length < 2) continue`), and `linkTransferPairManually` itself — which is correct for a transfer but left a reversal, where both legs sit on ONE account, invisible to all three. Measured 2026-09-08: 10 rows in 2026-09 alone, filed to `Misc`, netting exactly $0.00. Fixed with a **review queue, never an auto-linker**, because the shape is not evidence: across the live ledger's 8 months, 15 candidate pairs include at least two coincidences that would have DELETED real spending if auto-linked — `"ATM Surcharge fees refund"` opposite a genuine `APPLE.COM/BILL` charge at $3.99, and `"Zelle Transfer Payment ID"` opposite a real $200.00 ATM withdrawal. New pure `findSameAccountReversals` (`src/lib/simplefin/sameAccountReversals.ts`) buckets on `(accountId, date, |amount|)` and returns only `AmbiguousBucket`s — there is no `pairs` field to consume by accident. `linkTransferPairManually` gained an `allowSameAccountReversal` opt-in that is a **server-action argument, never a form field**, so a crafted or stale POST cannot set it; the default path still throws `two different accounts`, pinned by the pre-existing test which passes unchanged. `/sync` renders both queues through one extracted `ReviewQueue` component rather than a second copy of the 55-line form. 14 buckets on the live ledger today, ~2/month after that.

- [x] **P2 — DONE (surfaced, not eliminated)** — **A row can be claimed by BOTH `/sync` review queues, and that overlap is a genuine ambiguity rather than a bucketing bug.** `matchTransfers` buckets on `(date, |amount|)` and excludes same-account shapes with a per-BUCKET test — `if (accountIds.length < 2) continue` (`matchTransfers.ts`) — not a per-row one, while `findSameAccountReversals` buckets on `(accountId, date, |amount|)`. So a date-and-amount holding a same-account +/− pair AND rows on another account comes out of both queries. **Measured live 2026-09-08: 1 of 14 current buckets** — `2026-09-04 · $10.00`, spanning accounts 2 and 1, 7 rows. **The obvious fix is wrong and was rejected with evidence.** Stripping same-account +/− pairs out of a mixed bucket before the counting argument runs destroys the bidirectional case `matchTransfers`' own comment blesses ("Two accounts trading in both directions is still fine — A→B and B→A consume disjoint rows and never compete"): probed directly, `[A +5000, B −5000, A −5000, B +5000]` currently returns `pairs: [[1,2],[4,3]]` with zero ambiguous, and stripping would remove all four rows and kill two correct auto-links. Account A holding both signs against B is EITHER a reversal on A or a legitimate bidirectional transfer, and nothing in the data distinguishes them — which is precisely why it is a review queue in the first place. Resolved by making it legible instead of adjudicating it: `overlappingRowIds` (`sameAccountReversals.ts`) computes the intersection and both queues render an amber cross-reference naming the other heading, so the money can only be paired once and the user sees both readings before choosing. Remaining exposure: none silent — a wrong choice is still possible, but it is now an informed one. (`src/lib/simplefin/sameAccountReversals.ts`, `src/app/sync/_review-queue.tsx`, `src/app/sync/page.tsx`)

- [ ] **P3** — **The `/sync` reversal queue does not exclude pending rows, and neither does the transfer queue it sits beside.** CLAUDE.md rule 4 makes pending exclusion load-bearing on the CSV ±1 path — `linkTransferPairs`' `sameDayUnpaired` filters `is_pending = false` because a pending row can carry Star One's shared `6098` placeholder transaction number and look like a legitimate match for an unrelated posted row. Neither `findAmbiguousTransfers` (`sync.ts`, pre-existing) nor the new `findSameAccountReversalCandidates` carries that filter, so a still-pending row can reach either review queue and be linked by hand; pairing it excludes it from every spending surface, and when it later posts `commitImport` updates it in place and keeps the pairing, so the mistake is invisible afterwards. Not introduced by the reversal work — the new query was written consistent with its sibling — which is why it is filed here rather than fixed inside it: the fix belongs to both queries at once, and it needs a decision on whether a pending row is a legitimate candidate at all. Blocked by: nothing; it just wants one decision applied in two places. (`src/lib/simplefin/sync.ts`)

- [ ] **P4** — **The unlinked-rows SELECT now exists in three identical copies in `sync.ts`.** (Merged 2026-09-09: this was also the third clause of the v0.8.0 review's "Simplification, advisory only" P4, filed when the query had two copies. That clause now points here.) `linkTransfersByBucket`, `findAmbiguousTransfers` and `findSameAccountReversalCandidates` each carry the same column list, the same `and(gte(date, sinceIso), isNull(transferPairId), NOT_MANUAL)` predicate and the same `adjudicatedByTxnNumber` map. The deliberate divergence between the two review queues is about which MATCHER consumes the rows, not about how they are loaded, so the read can be shared without weakening that argument. This is why the P3 above lands in two places instead of one. Also worth folding in: `/sync` runs two of these on the same render, reading essentially the whole table twice (sub-millisecond at 1,562 rows — a tidiness item, not a performance one). Extract `selectUnlinkedTransferRows(sinceIso, db)`. (`src/lib/simplefin/sync.ts`)

- [ ] **P4** — **The trend chart's empty state tells you to import when the fix is to categorize.** `isEmpty` is `months.every((m) => m.byCategory.length === 0)` and `byCategory` only counts rows with a non-null `category_id` whose category `kind = 'expense'`, so a ledger with hundreds of UNCATEGORIZED rows — the documented normal state of this app, and 477 rows today — renders "Import more transactions to see spending trends." Importing more will not help. Pre-existing (the old `totalSpentCents === 0` condition was reached the same way), so it did not block the sign-convention pass, but the fix needs `loadMonthlyTrends` to report whether the window had any rows at all, which is why it is not a copy-only change. Say "Categorize some transactions to see spending trends" and link `/categorize` when rows exist but none are categorized expenses; keep the import copy only for a genuinely empty window. (`src/components/ledger/trend-chart.tsx`, `src/lib/trends/loadMonthlyTrends.ts`)

## Follow-ups from the `/plan-eng-review` backlog-triage pass (2026-09-08, round 2)

Second triage, run against the live ledger rather than the docs, answering
"what next" after v0.19.0. Two deferred items were disproven with measurements,
one gate in `PLAN.md` was found underspecified, and the Remember guard below
shipped in the same pass. Codex (gpt-5.4) ran as the outside voice and widened
the guard's scope from two bad keys to two key CLASSES, which is what shipped.

- [x] **P2 — DONE** — **Both categorize paths turned any `normalized_merchant` into a global `exact` rule with no check on whether the key means anything.** both write paths called `createOrUpdateRule` on the stored key whenever Remember was ticked (they now share `applyRuleWrite`; the line numbers this entry originally cited are stale); `buildRuleMatcher` then files every future matching row without asking again. The checkbox defaults to unchecked at both render sites (`_merchant-row.tsx`, `_transaction-row.tsx`), so this was never silent at the moment of training — but it is silent from then on, which is the part that matters. Two key classes are wrong to train and they fail for opposite reasons: **lossy** keys, where the normalizer discarded the only thing naming a counterparty (`normalize.ts`'s `EMBEDDED_TIMESTAMP` + `MEMO_TAIL` strip turns `Online 08/13/2026 10:21:58 MEMO: Lesa's Prescription Ref# 6B162` into `ONLINE`); and **multi-category** keys, where the key is a real merchant this ledger has already filed two ways. The two halves are derived differently on purpose — multi-category is read from the data with no list to maintain, lossy cannot be (the text is gone by the time the key exists) so it is a curated set held to `KNOWN_CITIES`' evidence-only bar. New pure `classifyKeyTrainability` (`src/lib/categorize/keyTrainability.ts`, ZERO imports — `/categorize` evaluates it client-side, and the DB half is a separate `resolveKeyTrainability.ts` so drizzle stays out of that route's bundle; verified against the built client-reference manifest). The verdict takes the union of filed categories AND the category being assigned right now, so it is order-independent and catches the case that matters most: the user discovering mid-action that this merchant spans two envelopes. Refusal withholds the RULE ONLY — the rows are still filed, because the decision about those rows is sound even when generalizing it is not. Measured live: 5 of 180 groups get the checkbox disabled (`ONLINE` 25 rows, `MOBILE` 15, `AMAZON` 53, `COSTCO WHSE` 53, `JACK IN THE BOX` 1 — those counts are of the UNCATEGORIZED BACKLOG; across all rows `ONLINE` is 39 and `MOBILE` 27, which is the figure `LOSSY_MERCHANT_KEYS` and the CHANGELOG quote); the other 175 groups / 290 rows are untouched. `JACK IN THE BOX` is no longer among them — see the post-UPDATE fix below. (`src/lib/categorize/keyTrainability.ts`, `resolveKeyTrainability.ts`, `bulkCategorize.ts`, `categorizeTransaction.ts`, `loadMerchantGroups.ts`, `src/app/categorize/_merchant-row.tsx`, `src/app/transactions/_transaction-row.tsx`)

- [x] **P2 — DISPROVEN, do not build as scoped** — **merchant-normalization T6 ("re-run auto-categorization over the backlog") is worth 6.6%, not the sweep it reads like.** The Weekend-1 item **"`docs/plans/merchant-normalization.md` T3 / T5 / T6"** parks T3/T5/T6 together on the note that T3 measured out at ~5 groups; T6 was never measured at all. It is now: replaying every existing rule over the 437-row backlog matches **29 rows** (22 by `exact`, 7 by `contains`) across 6 groups — `AUDIBLE` 7, `SAFEWAY` 6, `BLOCK 21 WINERY` 4, `WALMART` 3, `COSTCO GAS` 1, `JACK IN THE BOX` 1. T3's alias table measures no better on current data: exactly **1** uncategorized group is a ≥9-char prefix of an already-filed key. The one real fragmentation case is Save Mart, split across five keys (`SAVEMART` 13, `SAVEMART MANTEC` 9, `SAVE MART MANTE` 9, `SAVE MART RIPO` 1, `SAVE MART CENTER F` 3) because the bank truncates the store-name field at different widths — a normalizer cannot fix truncation, which is the argument FOR an alias table, but one merchant is not a business case. Re-measure before building either; do not treat that entry's ~5-group figure as covering T6.

- [x] **P2 — DONE (2026-09-08).** Gate #3 was specified (a second budgeted month AND a category actually on `rollover`), then closed by use: 2026-10 exists with 24 rows and `Emergency Fund` carries $250 forward. The evidence the entry disputed was itself corrected — the all-NULL cache column proved nothing, and that column is now gone (migration 0021). **`PLAN.md`'s 1.0.0 gate condition #3 is underspecified, and the obvious way to close it does not close it.** The gate says "a second budgeted month" because "carryover and rollover have therefore never actually run against real data." Copying September into October exercises `copyPreviousMonth` and carryover; it does NOT exercise rollover. Measured 2026-09-08: **all 63 live categories have `carryover_policy = 'none'`** and all 20 `budget_periods` rows have `effective_allocation_cents = NULL`. `getEffectiveAllocation` (`src/lib/budget.ts:70`) only computes a non-zero `rolloverCents` when `carryoverPolicy === "rollover"`, so the whole rollover subsystem — the migration column, the lazy cache, and the `invalidateForwardRollover` contract fired from four call sites — has never produced a non-zero value in production. Corroborates **"PR3: drop `effective_allocation_cents` and the whole `invalidateForwardRollover` mechanism"** with the evidence that entry lacked, and forces a real fork: switch at least one category to `rollover` and use it for a month, or delete the machinery. Do not close #3 on `budget_periods` row count alone. Codex reached the same conclusion independently from the envelope-budgeting `/plan-eng-review` section. (`PLAN.md`, `src/lib/budget.ts`)

- [x] **P3 — DONE** — **The pre-UPDATE trainability read was deliberately conservative in one case, and the test pinning it asserted the opposite of what its title said.** A row that was the key's ONLY filed row and was being MOVED from one category to another still counted the category it was leaving: the union was two, the rule refused, even though after the move the key is unanimous. This entry predicted the fix correctly — "computing the post-UPDATE filing set rather than the pre-UPDATE one, which is a different query, not a reordering" — and that is what `resolveKeyTrainability`'s `excludeTxnIds` does. It also under-scoped the harm at "reachable on `JACK IN THE BOX` and nowhere else": the refusal ALSO removed the rule, and the stated workaround (re-tick Remember on a second row) does not apply once the key genuinely looks split. The test — `"MOVING a row off its only category does not refuse on the category it left"` — asserted `ruleRefusal?.reason === "multi-category"`, i.e. the inverse of its own name, which is how this survived a review pass. Both are fixed. (`src/lib/categorize/resolveKeyTrainability.ts`, `src/lib/categorize/categorizeTransaction.test.ts`)

## Follow-ups from the `/ship` pre-landing review (2026-09-08, Remember guard)

Six specialists plus a Red Team pass reviewed the guard branch. Eight findings
were auto-fixed in-branch and are in the v0.20.0 CHANGELOG. One was escalated to
a decision (D1=C) and fixed here: the refusal now removes a contradicting exact
rule instead of leaving it standing.

Everything below was then re-reviewed by `/pr-review-toolkit:review-pr` on the
same day (six specialists again, over the shipped branch rather than the working
tree) and most of it was CLOSED in that pass — see the next section for what that
review found on its own. Line references in the entries below are as of the
original triage and have not been re-resolved; the code they name has moved.

- [x] **P1 — DONE** — **`/subscriptions` was a third `bulkCategorize` caller with `rememberMerchant: true` that threw the result away, so its refusals were invisible.** Worse than "invisible": that page has no undo at all and its actions returned `void`, so the `BulkCategorizeSnapshot` was unreachable even in principle, and `loadSubscriptions` does not filter on `category_id` — so a merchant already filed under a working rule was still on the "Categorize all" list. Fixed two ways: the sweep no longer passes `allowRuleRemoval`, so it cannot remove a rule at all; and its logic moved to `src/lib/subscriptions/categorizeSubscriptions.ts` (explicit `db`, therefore tested) reporting per-merchant outcomes that `_categorize-buttons.tsx` renders through Sonner.

- [x] **P2 — DONE** — **`loadFiledCategoryIds` counted filings under ARCHIVED categories as contradicting evidence.** An archived category's rules never fire (`buildRuleMatcher` skips them, rule 8), so such a filing cannot contradict a live rule — it refused Remember on a key whose only category that still matters is unanimous, citing categories the user can no longer pick. Both spellings now join `categories` and require `archived_at IS NULL`, pinned in `resolveKeyTrainability.test.ts` with a live-category control.

- [x] **P2 — DONE** — **The filed-rows predicate was written out by hand in two places, held together by comments and one test.** Extracted to `filedCategoryEvidenceWhere` (`resolveKeyTrainability.ts`), which takes the MERCHANT CONDITION as a parameter because that is the only part that legitimately differs — `eq()` for one key, `inArray()` for a page of groups. The parity test stays.

- [x] **P3 — DONE** — **The empty key `""` was in `LOSSY_MERCHANT_KEYS` but unfileable on the bulk path and un-undoable on both.** One decision applied in all three places it needed to be: `.min(1)` is gone from `bulkCategorizeInputSchema.normalizedMerchant` and from `normalizedMerchant`/`priorRule.matchValue` in both snapshot schemas. `/categorize` lists that group like any other, so Submit throwing `Invalid bulk categorize input` on it was a dead end with no alternative route.

- [x] **P3 — DONE** — **`checked={remember && trainability.trainable}` masked the tick rather than clearing it, so it resurrected.** `handlePick` now clears `remember` outright when the new pick makes the key untrainable. The mask stays too, because the verdict can also move under a stale page.

- [x] **P3 — DONE** — **`src/app/categorize/actions.ts` had no test file while its `/transactions` sibling did.** `src/app/categorize/actions.test.ts` now mirrors it: the compile-time assertion that `ruleRefusal` is not a snapshot key, the strict-parse counterpart, the JSON round-trip through a real undo, and the empty-key case.

- [x] **P4 — DONE** — **The verdict→refusal derivation was copy-pasted into both write paths.** Both now call `applyRuleWrite`, which is also the only place that decides whether a refusal removes the existing rule. The copies had already drifted: `categorizeTransaction` never captured `insertedRuleId`.

- [x] **P4 — DONE** — **The refusal wording lived in two client files.** `describeRuleRefusal` (`src/lib/categorize/refusalNotice.ts`) builds the sentence once, server-side, which is also what lets it NAME the removed rule's category; `describeRuleUndo` does the same for the undo toast.

## Follow-ups from `/pr-review-toolkit:review-pr` (2026-09-08, over the shipped guard)

Six specialists over PR #45 as pushed. Two critical findings and six important
ones, all fixed in the same pass along with the eight items above; the CHANGELOG
and rule 6 carry the user-facing and design halves. What is left open is here.

- [x] **P2 → CLOSED (2026-09-15).** **`/transactions` can now disable the Remember checkbox the way `/categorize` does, instead of only warning after the fact.** `loadFiledCategoryCountsByMerchant` (`resolveKeyTrainability.ts`) is the batched query this entry called for, shared by `/categorize`'s `loadFiledCategoryIdsByMerchant` (grouped, no self-exclusion needed — every row it groups is `categoryId IS NULL`) and `/transactions`' `loadTransactions` (a flat row list, so `TransactionRow.filedCategoryIds` self-excludes each row's OWN sole-contributed category — `count === 1` on its own current category — emulating the server's `excludeTxnIds=[row.id]` EXACTLY, not conservatively; ship-review adversarial passes (Claude + Codex, two rounds, cross-model) verified this algebraically and by scratch reproduction). `TransactionRowForm` wires it into `classifyKeyTrainability` exactly as `_merchant-row.tsx` does — disabled/grayed checkbox, inline reason text, "clear the tick, don't just mask it" on pick change, and (new in this branch) also on any revalidation-driven row-prop refresh, closing a stale-consent path the first adversarial round found (a tick given for one picked category could silently carry over and train a rule for a different one after a sibling row's write changed the evidence underneath it).
      **A second gap surfaced by the same review, fixed in the same branch:** disabling the checkbox on `!trainable` alone also disabled the ONE gesture rule 6 documents as the repair path for a poisoned rule — a refusal that CONTRADICTS an existing exact rule still deletes it server-side (`applyRuleWrite`'s `shouldDelete`), but a disabled checkbox can never submit `rememberMerchant=true` to reach that branch. `describeRuleAction` (`keyTrainability.ts`) is a client-side mirror of `shouldDelete`'s exact formula (verified line-by-line against `applyRuleWrite.ts` by the second adversarial round) that relabels the checkbox to "Remove conflicting rule" and keeps it ENABLED whenever ticking it would still do something (delete a contradicting rule), even though it can't train a new one. Needed a third batched query, `loadExactRulesByMerchant` (extracted to `src/lib/rules.ts`, replacing `loadMerchantGroups.ts`'s own inline copy — same DRY move as the counts query), so `/transactions` knows each merchant's existing rule the way `/categorize` already did via `MerchantGroup.existingRule`. Because this can fire with the pick UNCHANGED (a lossy key like `ONLINE` removes its rule unconditionally, regardless of category match — same as `shouldDelete`), `/transactions`' Save button also needed its own fix: the "nothing changed" disable guard (`pickerValue === String(currentCategoryId)`) now has an escape hatch for `remember && ruleActionEnabled`, or ticking "Remove conflicting rule" on an already-correctly-filed row had no way to actually submit.
      Verified live against the real ledger on BOTH surfaces (a merchant with an existing rule, picking a contradicting category shows "Remove conflicting rule" enabled with the rule's target named in the message) and by unit tests: `describeRuleAction`'s full branch table in `keyTrainability.test.ts`, `loadExactRulesByMerchant` in `rules.test.ts`, `existingRule`/self-exclusion coverage in `loadTransactions.test.ts`, and updated cross-surface parity tests in `resolveKeyTrainability.test.ts` (parity holds for an uncategorized row; a categorized row's self-exclusion divergence from the group figure is asserted as the intended fix, not a regression). 2132 tests pass, `tsc --noEmit` clean, two independent adversarial rounds (Claude + Codex, cross-model) converged with no further findings. (`src/lib/categorize/resolveKeyTrainability.ts`, `src/lib/categorize/keyTrainability.ts`, `src/lib/categorize/loadMerchantGroups.ts`, `src/lib/categorize/loadTransactions.ts`, `src/lib/rules.ts`, `src/app/categorize/_merchant-row.tsx`, `src/app/transactions/_transaction-row.tsx`)

- [ ] **P4 — no integration test ties `describeRuleAction`'s formula to `applyRuleWrite`'s actual server behavior end-to-end.** `keyTrainability.test.ts` unit-tests the pure formula in isolation, and its docstring quotes `applyRuleWrite`'s `shouldDelete` expression as the thing it mirrors, but nothing runs an actual `categorizeTransaction`/`bulkCategorize` call with `allowRuleRemoval: true` and asserts the DB outcome (rule deleted or not) matches what `describeRuleAction` predicted for the identical inputs — the same class of drift risk `resolveKeyTrainability.test.ts`'s other parity tests already close for the WHERE-clause predicates. A shared table of cases run through both the pure function and a real `categorizeTransaction` call would close the residual "the mirror could silently drift on a future `applyRuleWrite` edit" risk. Not blocking — the current formula was hand-verified line-by-line against the server twice — but worth doing whenever `applyRuleWrite.ts` next changes. (`src/lib/categorize/keyTrainability.test.ts`, `src/lib/categorize/applyRuleWrite.ts`)

- [ ] **P2** — **A rule with a lot of history behind it is still removed when one row is retargeted.** Move one of 50 rows filed by `K → Shopping` and the rule goes. `applyRuleWrite` documents why this is the better of two available wrongs (the alternative silently files every future row where the user has just said is not the only answer), and it is now visible and reversible rather than silent. But the underlying gap is real and is not a predicate problem: there is no way to bulk-RETARGET already-filed rows anywhere in the app — `applyToPast` only touches `category_id IS NULL`. With one, the whole situation would be a two-step the user could actually complete. **The two-step now exists (round-4 P2, below): `bulkRetarget` on `/transactions?merchant=…` moves every row filed under one category for a key, and passes the whole moved set as `excludeTxnIds`, so ticking Remember on a move that makes the key unanimous RETRAINS the rule instead of removing it.** What is still true is the single-row case this entry actually names — retarget ONE of 50 rows and the rule still goes, because one row does not make the key unanimous and intent is not in the data. That is `applyRuleWrite`'s documented better-of-two-wrongs and is unchanged; the difference is that the user now has an action that reaches the other 49.

- [ ] **P3** — **`import_batch_categorizations.rule_id` does not survive a remove/restore cycle.** The FK is `onDelete: 'set null'`, so removing a rule nulls provenance on every row it ever auto-filed, and `restorePriorRule` re-inserting under the same id does not put those pointers back. No consequence today: that column has writers only (`importBatch.ts`, `simplefin/sync.ts`) and no readers. The first reader has to know, so it is written down in `restorePriorRule`'s docblock as well as here.

- [ ] **P4** — **`LOSSY_MERCHANT_KEYS` is a curated set and nothing tells you when it is stale.** (Merged 2026-09-09: filed twice, here and in the round-2 triage above, which carried the detector sketch.) The three entries have live evidence today (`ONLINE` 39 rows, `MOBILE` 27, and `""` at 0 rows but reachable, per `merchantLabel`'s existence). A future `normalize.ts` change could retire a key or mint a new lossy one and nothing would notice — the same staleness class CLAUDE.md rule 10 documents for `normalized_merchant` generally. **Cheapest detector:** have `db:backfill-merchants` report any single-token key above a row-count threshold that carries more than N distinct `raw_memo` shapes, alongside its existing collision report. Not urgent — the cost of a missing entry is one trainable key that should not be, which the multi-category half often catches anyway. (`src/lib/categorize/keyTrainability.ts`, `scripts/backfill-merchants.src.mjs`)

## Follow-ups from the `/plan-eng-review` "what next" pass (2026-09-08, round 3)

Third triage in one day, run against the live ledger. The finding was the
premise: v0.18.0, v0.19.0 and v0.20.0 were each produced BY a "what next" pass,
each shipped real engineering, and across all three not one measured product
fact moved — backlog 437, budgeted months 1, funds 0, rollover categories 0,
manual rows 0, all unchanged. Open items in this file went 63 → 100 over the
same three releases. Codex (gpt-5.4) ran as the outside voice and corrected the
sequencing (fix the P1 *before* the usage pass, not after) and the gate-#2
recipe (it needs a fund, not a manual card charge — manual rows were removed
from the gate as misframed). Decisions: D1=A (P1 first, then a one-session usage
pass), D2=B (leave `AMAZON`/`COSTCO WHSE` uncategorized), D3=C (feed-provenance
column).

- [ ] **P3** — **Structurally-undecidable backlog rows are indistinguishable from
      undecided ones, and after D2=B that is permanent.** `BacklogBanner`
      (`src/app/_components/BacklogBanner.tsx`) renders `backlog.count` as a raw
      number with no notion of *why* a row is still uncategorized. D2=B files 178
      of 180 merchant groups and deliberately leaves `AMAZON` (53) and
      `COSTCO WHSE` (53) alone, because their memos carry zero separating signal —
      every Costco memo is `COSTCO WHSE #1031 MANTECA CA Card #:NNNN` byte-for-byte
      except the card last-4, and every Amazon memo is `AMAZON MKTPL*<opaque>`.
      So the amber strip permanently reads 106 and never reaches zero, which is
      exactly the "trains you to ignore it" cost the decision accepted. The verdict
      already exists as a pure function — `classifyKeyTrainability`
      (`src/lib/categorize/keyTrainability.ts`) returns `multi-category` for both
      keys — so this is a join in the read model, not new logic: report
      "N undecided · M undecidable" and let the CTA target only the N. Note the
      honest fix for these two groups is split transactions (see **"Split
      transactions conflict with the V1 exclusion list; decide, do not
      drift"**),
      which is on the V1 exclusion list; this item makes the residue legible, it
      does not resolve it. Blocked by: nothing.
      (`src/app/_components/BacklogBanner.tsx`, `src/lib/budget/loadMonthView.ts`)

- [x] **P2 → CLOSED (2026-09-17, stale — closed by the /plan-eng-review "what
      next" pass reviewing TODOS.md/PLAN.md, not by new work).** The premise
      this entry was measured against — Citi feed-linked, zero transaction
      rows, no path for a card to import its own spending — was superseded
      2026-09-09 through 09-15 by `docs/plans/card-transaction-import.md`,
      which this entry's own later corrections never circled back to: PR1
      shipped the accounting cutover (D8.1) so a linked card imports its own
      transactions from the day it was reconciled forward, and PR2 (T9) added
      `linkCardPayment` for retroactively pairing a checking payment to the
      card's own imported row. `paidDownCents`, the utilization bar and the
      balance sum are no longer vacuous by construction on an importing card
      — they depend on the card actually having posted activity since its
      anchor, which is a live-ledger fact rather than a code gap. Left as a
      historical record rather than deleted: this entry (and the "CORRECTED
      2026-09-08" / "CORRECTED AGAIN 2026-09-09" trail below it) is a
      documented case of the general rule its own last paragraph states —
      re-measure every premise against the live database before acting on a
      usage-pass TODO — and deleting it would lose that example. See
      `PLAN.md`'s "SUPERSEDED (2026-09-09, same day)" note under the 1.0.0
      gate for the decision that made this obsolete.
      Original entry:
      **v0.16.0's liability feature has no rows behind it, and nothing in
      the docs says so.** Measured 2026-09-08: accounts 3 (`Fixed Rate 1st Mortgage`)
      and 4 (`Citi Bank`, `-$2,206.43` owed) are both feed-linked and both hold
      **zero transaction rows**; all 1,562 rows sit on accounts 1 and 2. Three
      consequences, none of which look like a bug from the code: `paidDownCents`
      returns $0 by construction (its cross-account `EXISTS` can never match with
      no rows to pair), no utilization bar renders (`credit_limit_cents` is NULL,
      which DS64 makes legitimate), and the "paid down this month" line is absent
      on both `/accounts` and the dashboard. Meanwhile 21 rows of debt paydown sit
      in checking filed as ordinary spend with no partner to pair against:
      `CITI CARD ONLINEPAYMENT` 4 rows / $1,120.00, `AMEX EPAYMENT ACH PMT` 7,
      `BANK OF AMERICA PAYMENT` 6, `MOBILE DEPOSIT STAR ONE CU` 7 — all with
      `transfer_pair_id IS NULL`. The 4 Citi rows are fixable today through the
      existing `/transactions` row menu ("Mark as payment to Citi Bank"); AMEX and
      BofA are not accounts at all, so they have no repair path and are arguably
      correct as spend. This is the same shape as the fund and rollover stories:
      the largest release in the repo (39 tasks) renders an anchor balance and
      nothing else. Do not read the liability surfaces as verified until the card
      carries rows.
      **CORRECTED 2026-09-08 (round-4 triage). This entry previously read
      "Blocked by: getting the Citi feed to import transactions … the P1 closed
      in v0.21.0, so linking the card is now just a link." Both halves were
      false, and the second one sent the reader at an action with no effect.**
      A credit card can be feed-linked and will still never import a
      transaction row: `partitionLinkedAccounts` (`src/lib/simplefin/sync.ts`)
      routes every account where `accountClass(type) === "liability"` to
      `balanceOnlyAccounts` — **cards as well as the mortgage, not just the
      mortgage** — and
      `docs/plans/liability-accounts-and-budget-signals.md` lists "Importing
      credit card transactions from any feed" as an explicit V1 exclusion.
      Account 4 already HAS `simplefin_account_id` set and zero rows; that is
      the design working, not a pending link. The relink P1 was never this
      item's blocker.
      Two paths actually put rows on a card, and they validate different
      things:
      (a) `createCardActivity` (`/accounts` → "Add a charge") — **refused on or
      before the anchor** (D12), and Citi's anchor is `2026-09-08`, so no
      historic card spending can be entered this way; only charges dated from
      tomorrow forward. This is the path that exercises the balance math and
      the utilization bar.
      (b) `markAsCardPayment` (`/transactions` row menu) on the 4
      `CITI CARD ONLINEPAYMENT` rows (2026-06-26, 07-20, 08-14, 08-27;
      $1,120.00 total) — mints a synthetic manual mirror on the card. It
      deliberately ACCEPTS a pre-anchor date and correctly leaves the balance
      unmoved, because an anchor dated after the payment already includes it
      (E5/F11, pinned by `manualTransaction.test.ts`). So (b) is cheap and
      real — it writes the first `import_source='manual'` rows this ledger has
      ever had and makes `paidDownCents` non-zero — but it validates the
      pairing path only, NOT card spend, utilization, or the balance sum.
      Blocked by: nothing. Do (b) now; (a) needs a real card charge to happen
      after today. (`src/lib/accounts/paidDownCents.ts`,
      `src/lib/accounts/resolveUtilizationDisplay.ts`, `src/app/accounts/`,
      `src/lib/simplefin/sync.ts`, `src/lib/accounts/manualTransaction.ts`)
      **CORRECTED AGAIN 2026-09-09 (round-6 triage). "Do (b) now" was wrong,
      and all THREE of the benefits the paragraph above claims for it are
      false — measured against the live ledger, not re-read from the code.**
      This is the third consecutive round where a stated blocker or benefit
      turned out to be misdiagnosed, and the first where acting on the entry
      would have cost something, because (b) is a 30-second click that
      presents as free.
      1. **"no utilization bar renders (`credit_limit_cents` is NULL)" is
         already stale.** The limit is `320000` ($3,200). Against `-220643`
         owed the bar renders at ~69%. `resolveUtilizationDisplay` gates on
         the limit being present and positive (DS64), nothing else, so this
         has been true since the limit was entered — the entry was describing
         the ledger of a few hours earlier.
      2. **(b) does NOT make `paidDownCents` non-zero.** The figure is
         month-bounded — `between(monthBoundary(y, m), lastDayOfMonth(y, m))` —
         and the four `CITI CARD ONLINEPAYMENT` rows are dated 2026-06-26,
         07-20, 08-14 and 08-27. September, the only month `/accounts` and the
         dashboard render, stays `$0`. And DS58 omits the line at `0` as well
         as at `null`, so the visible change on either surface is **nothing**.
         It would make June, July and August non-zero — months no surface
         displays.
      3. **(b) permanently disables the card's automatic balance.** Writing
         the mirror rows makes `hasAnyTransactionRows(4)` true, and
         `refreshLiabilityBalances` (`src/lib/simplefin/sync.ts`) SKIPS any
         balance-only account that has rows, with a warning, because
         SimpleFIN's `balance-date` is an instant and rule 1's anchor must be
         a close-of-day figure. Today that pass runs on every `/sync` and the
         Citi anchor is moving daily (`balance_source: 'feed'`,
         `prior_starting_balance_date: '2026-09-07'` against an anchor of
         `2026-09-08`). `resolveBalanceAction` flips the row from Refresh to
         Reconcile at the same moment. That is the design working exactly as
         D7/D15 specify — it is just not free, and the entry called it cheap.
      `unmarkCardPayment` is the way back, so this is revertible; the anchor
      moves it would strand are not, since `prior_starting_balance_*` holds
      exactly one value (rule 9).
      **RE-SEQUENCED: do (b) only alongside (a), not before it.** When a real
      post-anchor card charge exists, the card has rows anyway and the feed
      refresh is going away regardless — at that point the mirror rows cost
      nothing and (a) + (b) together validate spend, utilization, the balance
      sum AND the pairing path, which is the whole feature rather than a
      quarter of it. Until then the card's balance is correct and current for
      free, which is worth more than four backlog rows.
      **The general rule, worth more than this entry:** a usage-pass TODO
      written from code-reading names benefits the ledger has already
      delivered, or that a month-bounded query cannot deliver. Re-measure
      every premise against the live database before acting on one — and
      specifically check whether the write trips a `hasAnyTransactionRows` or
      other zero-row gate somewhere else in the app.


## Follow-ups from the `/plan-eng-review` pass (2026-09-08, sync pending-state plan)

- [ ] **P3** — The ~12 other server-rendered submit buttons outside `/sync` have the
      same no-feedback gap the sync branch fixes: `/import` (4), `/budget` (4),
      `/accounts` (3), `/goals` (2), `/subscriptions` (1) — enumerate with
      `grep -rn 'type="submit"' src/app`. Two of them write money (`/import`'s confirm,
      `/accounts`' Reconcile), and none of them greys out or changes label while the
      server action is in flight, so a double click is one impatient moment away. The
      sync branch builds the reusable half — `src/app/sync/_submit-button.tsx`, exporting
      `PendingFieldset` (a `<fieldset disabled={pending}>` that freezes the payload
      controls, not just the button) and `SubmitButton` (label swap + `disabled` +
      `disabled:opacity-50`), both reading `useFormStatus`. Adopting it elsewhere is one
      line per call site. Do the promotion at that point: `git mv` it to
      `src/components/ledger/submit-button.tsx` and add a row to `DESIGN.md`'s state
      components table, which is where the second consumer earns it a place in the design
      system. Two caveats before starting. (1) It is NOT uniformly mechanical: `/budget`'s
      buttons live in client components that already hold a transition, where
      `useTransition` is the better fit and `useFormStatus` buys nothing — check each
      surface for `"use client"` first (`grep -rl '"use client"' src/app`). (2) None of
      these routes has UI test coverage and CLAUDE.md's "What's NOT in V1" section says that stays true, so
      every surface needs a manual pass. **Depends on:** the sync pending-state branch
      landing first, since it is what creates the component.
      (`src/app/sync/_submit-button.tsx`, `src/components/ledger/`, `DESIGN.md`)

- [ ] **P4** — `src/app/sync/ActionForm.tsx:54` declares
      `children: React.ReactNode | ((pending: boolean) => React.ReactNode)` and the
      `typeof children === "function"` branch below it
      unwraps it, advertising a pending API that **no caller can ever use**: both consumers
      (`_review-queue.tsx`, `page.tsx`) are Server Components with no `"use client"`
      directive, and a function child is not serializable across the RSC boundary. Verified
      zero callers by grep. It is a live footgun — it is the first thing you reach for when
      adding pending state to a `/sync` button, and it costs twenty minutes to discover why
      it cannot work. Narrow the type to `React.ReactNode` and drop the
      `typeof children === "function"` branch; `pnpm exec tsc --noEmit` proves the deletion
      is safe. Four lines. Deliberately deferred out of the pending-state branch (D5) to
      keep an unrelated cleanup out of a small UX fix, even though that branch edits the
      same file for `announceSuccess`. The replacement it should have been is
      `useFormStatus` in a nested client component, which is what
      `node_modules/next/dist/docs/01-app/02-guides/forms.md:316` documents for exactly this
      case. **Depends on:** the sync pending-state branch landing first, so the replacement
      exists before the dead path is removed. (`src/app/sync/ActionForm.tsx`)

## Follow-ups from the `/ship` pre-landing review (2026-09-08, sync pending-state)

Nine reviewers ran over this branch — six specialists, a red-team pass, and two adversarial
passes (Claude and Codex). Everything with a money consequence was fixed on the branch; these
are what was deliberately left.

- [x] **P2 → CLOSED AS NOT-A-BUG (2026-09-16), after a same-day fix was built,
      shipped through review, and then reverted for being a regression.**
      `/sync`'s five forms lost progressive enhancement when `ActionForm`
      started wrapping the Server Action in an inline client closure for
      `useActionState` — a closure carries no `$$FORM_ACTION`, so React's
      server renderer falls back to `action="javascript:throw new
      Error('React form unexpectedly submitted.')"` on all five. This entry
      went through TWO rounds of "claimed limitations need evidence"
      correction in one day, and the second one reverses the first:
      **Round 1 (same session, verified by curl): "defaults to GET on the
      current URL" was wrong** — the SSR'd HTML carries the poison-pill
      `action` above, not an absent one, so a naive read of the fix ("keep
      the raw action, move `publish()` elsewhere") looked sufficient, and a
      hydration-gate fix (`PendingFieldset` disables on `!hydrated`, via a
      `useHydrated()` hook shared with `_month-editor.tsx`'s existing
      T24/DS17 instance) was built, tested (2188 passing, `tsc`/lint clean),
      and taken through a full specialist review army (0 findings across
      testing/maintainability/performance/simplification/design) plus a
      Claude adversarial subagent (also 0 findings — it verified the fix's
      *mechanics* were sound without questioning whether the underlying
      premise still held).
      **Round 2 (Codex adversarial challenge, `/ship` Step 11) found what
      both rounds above missed: the poison-pill `action` string is not a
      dead end, it's a HANDSHAKE.** React 19's Fizz SSR renderer injects an
      inline bootstrap `<script>` — confirmed present verbatim in this app's
      own `/sync` SSR output — that installs a document-level `submit`
      listener recognizing exactly that placeholder string. When it fires,
      the listener calls `preventDefault()` (so nothing navigates and
      nothing throws), captures the submitter and a `FormData` built from
      the form AND the specific button that fired (via a hidden-input
      insert/remove trick so the submitter's own `name=value`, e.g.
      `intent=reject`, survives), and queues `[form, submitter, formData]`
      onto `document.$$reactFormReplay`. Once hydration attaches to that
      exact `<form>` fiber, React reads `document.$$reactFormReplay`,
      resolves the action from the form's CURRENT client props
      (`formProps.action` — literally whatever function is attached, no
      `$$FORM_ACTION` required for this half), and re-dispatches the
      captured submission through it. **Verified empirically, not just by
      reading the source:** built a minimal but faithful repro (real
      `react-dom/server` + `react-dom/client` 19.2.8, the exact
      `useActionState`-wrapped-closure shape `ActionForm.tsx` uses,
      hydration deliberately delayed 4s) and clicked the submit button while
      the page still read "idle" (pre-hydration). Four seconds later, once
      hydration ran, the mutation fired correctly — `{"status":"ok","message":
      "mutated! intent=reject"}` — with the exact submitter value the
      pre-hydration click had captured. `window.location` never changed at
      any point.
      **This means the hydration-gate fix was a REGRESSION, not an
      improvement, and has been reverted (not merged).** Before it: a
      pre-hydration click was captured and self-healed once hydration
      completed — worst case, delayed feedback on a local app that
      "hydrates in milliseconds." After it: `PendingFieldset`'s
      `<fieldset disabled>` makes the button natively un-clickable during
      that exact window (a disabled control cannot fire a submit event at
      all, so there is nothing for the replay listener to capture) — turning
      a self-healing race into a true lost click that requires the user to
      notice and click again. The fix would have shipped a worse bug than
      the one it closed, and it passed a FULL specialist + adversarial
      review army (testing, maintainability, performance, simplification,
      design, and a Claude adversarial subagent) before Codex's structural
      challenge caught it — none of those passes questioned whether the
      "pre-hydration submit is lost" premise itself was still true, they all
      accepted it as already-established ground truth from round 1's own
      re-verification and reviewed the fix's mechanics on top of it. Reverted:
      `src/app/sync/_submit-button.tsx`, `src/app/budget/[year]/[month]/_month-editor.tsx`
      back to their pre-branch content; the extracted
      `src/components/ledger/use-hydrated.ts` deleted (it existed only to
      serve the second, now-reverted call site — the original T24/DS17 use
      stays inline in `_month-editor.tsx` where it already was).
      **Residual, recorded rather than chased further:** the replay queue
      (`document.$$reactFormReplay`) is an array, not a single slot, so
      multiple pre-hydration clicks on the SAME or DIFFERENT buttons before
      hydration completes could all queue and all replay once it attaches —
      not verified either way whether that could double-submit a mutation
      this app's server actions don't already guard against (most of the
      five already refuse on stale/duplicate state — see the sync doctrine's
      "a no-op is never reported as a completed action" — but this specific
      shape, N queued replays firing in sequence against a since-mutated
      DB, was not tested). Also unverified: whether a form that legitimately
      re-renders with a DIFFERENT action between the click and the replay
      (none of these five do) would replay against the stale one. Both are
      narrow, require deliberate rapid pre-hydration multi-clicking on a
      local single-user app that hydrates in milliseconds, and are TRUE of
      `main` today regardless of anything on this branch — nothing here
      makes them worse or better. Not chased further under review pressure;
      flagged for whoever next touches `ActionForm.tsx`.
      (`src/app/sync/ActionForm.tsx`, `src/app/sync/_submit-button.tsx`)

- [ ] **P3** — Keyboard focus drops to `<body>` on every `/sync` submit. `SubmitButton`
      sets `disabled={pending || disabled}` on the button the user just activated, and
      `PendingFieldset` disables the rest of the card in the same commit; a disabled element
      cannot hold focus, and nothing restores it. On the review queue, which renders up to a
      dozen structurally identical cards, one Enter press sends the next Tab back to the top
      of the document. This is a regression: before the pending work the buttons were plain
      `<button type="submit">` with no `disabled`, so focus survived. The plan's manual
      checklist (step 10) anticipated it and it was accepted for the branch. Fix by keeping
      the pressed submitter focusable — `aria-disabled` plus an `onClick` guard on the
      button itself, leaving the hard `disabled` to the `<select>`s that are the payload —
      or by capturing a ref and re-`focus()`ing when `pending` clears.
      (`src/app/sync/_submit-button.tsx`)

- [ ] **P3** — Rejecting one combination of a MULTI-CANDIDATE reversal bucket leaves the
      rejected pair selected and unmarked. `bucketKey`
      (`${reason}-${date}-${absAmountCents}-${positives[0]?.id}`) is unchanged by a
      rejection, because `findSameAccountReversals` returns the full `positives`/`negatives`
      arrays and uses `isRejected` only to drop a bucket once EVERY combination is dead. So
      React reuses the node, the two uncontrolled `<select>`s keep the pair just rejected,
      and every `<option>` still reads as available. The live ledger has a 2x4 bucket, so
      this is the real shape. Landing the inline `ActionStatus` (D1 during /ship) means the
      card at least says what happened, which is what made this survivable — but the pair
      is still selected and one more click on "Link as reversal" will link it, because
      `linkTransferPairManually` CLEARS a rejection rather than refusing it
      (`clearPairRejection`, `sync.ts`). Two fixes, ideally both: return the rejected
      `(positiveId, negativeId)` set from `findSameAccountReversals` so the queue can
      disable those option combinations, and fold a rejection count into `bucketKey` so the
      card remounts and clears its selection. Consider also making
      `linkTransferPairManually` refuse — rather than silently clear — a pair that currently
      has a `transfer_pair_rejections` row; the silent clear is only defensible for the
      cross-account queue, which has an explicit "Link as transfer anyway" affordance and
      copy for it. The same-account queue has neither. Found by the red-team pass during
      /ship. (`src/lib/simplefin/sameAccountReversals.ts`, `src/app/sync/_review-queue.tsx`,
      `src/lib/simplefin/sync.ts`)

## Follow-ups from the `/plan-eng-review` "what next" pass (2026-09-08, round 4)

Fourth triage in one day, run against the live ledger inside the running
container. It set out to confirm round 3's D1=A (the P1 shipped as v0.21.0, so
do the usage pass next) and found that one leg of that pass is impossible:
a fund can be created and never funded. Codex (gpt-5.4) ran as the outside
voice and found it; this pass verified it independently and reversed its own
recommendation on the strength of it. Decisions: **D1=B** (build the fund
contribution control FIRST, then run the usage pass — the first "what next"
deliverable in five releases whose consumer is named before it is built),
**D2=A** (correct the false blocker at the liability entry above).

Ledger state at the time of this pass, for the next person who measures:
1,562 rows (1,316 checking / 246 savings / **0 on both liabilities**);
382 uncategorized non-transfer rows across 166 merchant groups (was 437/180
that morning); 61 expense + 3 income + **0 fund** categories; **all 64 on
`carryover_policy='none'`**; 22 `budget_periods` rows, **all month 9**;
**0 rows with `import_source='manual'`**; 172 rules.

- [x] **P1** — **DONE (D3=C, 2026-09-08, uncommitted on this branch).** A
      `kind='fund'` category could be CREATED and its monthly contribution
      never WRITTEN, so fund progress was structurally pinned at $0.00 and
      the two pages pointed at each other.
      **What shipped:** the FUNDS band on `/budget/[year]/[month]` moved
      INSIDE the `<MonthEditor>` client island and became editable — a fifth
      peer column set (`Category │ Planned │ Planned to date │ Left to target
      │ Allocate`) reusing the existing `AllocationCell`, `CategoryMenu` and
      `NewCategoryRow`. **Zero server-side change to the write path**, which
      is the whole point of the finding: `upsertAllocation` already accepted a
      fund. `FundRow` gained `hasAllocation`, the real rollover triple (fund
      leaves join `rolloverCategoryIds`, so a carried balance no longer pops
      in after the first unrelated keystroke), `targetCents` and
      `plannedToDateCents`. `/goals` leads with `totalContributedCents` rather
      than `progressCents` so both pages show the SAME quantity under the word
      "planned", with withdrawals on their own line instead of silently folded
      in; it also gained "Fund this month →". A shared `<BandColumns>` colgroup
      plus `table-fixed` makes column geometry a property of the page. The
      noun is `Funds` everywhere (Spine, `/goals` h1, band, create form);
      `/goals` remains the route. Documented in `DESIGN.md`'s new
      `/budget` section — that file had no entry for this page at all.
      **PLAN.md gate #2 is no longer blocked, and is now closable by USE**:
      fund one goal for one month, then name which quantity is "progress".
      Original finding, kept because the reasoning is still the argument
      against reverting it:
      `/budget/[year]/[month]`'s `FundsTable` renders every cell as a
      `<Link href="/goals">` and `_help-panel.tsx` tells the user to "manage
      targets and contributions on the Goals page"; `src/app/goals/actions.ts`
      exports exactly two actions, `createGoalAction` (name, target,
      carryover) and `updateGoalTargetAction` (target), and **neither writes
      `budget_periods`**. `loadGoals`' `progressCents` is
      `allocated − withdrawn` where `allocated` reads
      `budget_periods.allocated_cents`, so it can only ever be `0 − withdrawn`.
      This is why `PLAN.md`'s 1.0.0 gate #2 ("what a *fund's* progress means,
      which is unanswerable until a fund exists") cannot be closed by creating
      a fund — it is unanswerable because a fund cannot ACCUMULATE, not because
      none exists. `TODOS.md`'s PR3 fund-behavior-unification entry covers this
      area but frames it as behavior polish; it is a user-facing dead end.
      **The server half already works and needs no change:** `upsertAllocation`
      has NO `kind` restriction (it checks existence, `archived_at`, and
      parent-header only) and `loadMonthView`'s `fundRows.plannedCents` already
      reads the same `allocatedByCategoryId` map the expense band does. What is
      missing is a control. Note this reverses design decision **DS19**
      ("read-only FUNDS section", amended by A6) if the control goes on
      `/budget` rather than on `/goals` — DS19's intent was that contributions
      live on Goals, and the gap is that Goals never got the form. Blocked by:
      nothing. **D3=C chose `/budget`, and the reason is not preference:**
      `leftToBudgetCents` is `plannedIncome − allocated − plannedFund`, so the
      contribution is a Left-to-Budget decision and setting it on a page with
      no month and no headline means doing the zero-based math blind. DS19 is
      reversed, deliberately, and `DESIGN.md` records that rather than leaving
      it to be rediscovered. (`src/app/budget/[year]/[month]/page.tsx`,
      `src/app/budget/[year]/[month]/_help-panel.tsx`,
      `src/app/goals/page.tsx`, `src/app/goals/actions.ts`,
      `src/lib/budget/upsertAllocation.ts`, `src/lib/goals/loadGoals.ts`)

- [x] **P2 — DONE (2026-09-08, uncommitted on this branch).** The usage pass
      this triage scheduled was production data entry with a 10-second undo and
      no bulk repair behind it. `applyToPast` only touches
      `category_id IS NULL` rows (`bulkCategorize.ts`,
      `categorizeTransaction.ts`), so a merchant group filed to the wrong
      category was repairable only row by row once the Sonner toast expired.
      Raised by Codex as the strongest argument against a usage-first sequence,
      deliberately deferred at D1, then built anyway when the fund branch was
      finished and the categorize sitting was the next thing due.
      **The structural fact that decided the design, and that neither the
      triage nor Codex had:** `/categorize` cannot host the repair. Filing a
      group is what makes it VANISH from that page — `loadMerchantGroups`
      selects on `category_id IS NULL`, so a fully-filed group is no longer
      listed there at all. The mis-filing is never visible on the page where it
      happened. The repair therefore lives on the exact-merchant drilldown,
      `/transactions?merchant=…`, which is not NULL-scoped, still lists every
      row, and is already where `/categorize`'s own "See all N transactions →"
      link lands.
      **What shipped:** `bulkRetarget` + `undoBulkRetarget` (plus their input
      and snapshot validators and `bulkRetargetErrors`), and a `RetargetForm`
      disclosure under the merchant header reading
      "Move [49 rows filed as Gas] to [category] [ ] Remember [Move 49]".
      Row set is `(merchant, fromCategoryId)` and non-transfer, derived
      server-side from the key — never from the page's live filters, so the
      control is labelled from `summarizeByCategory(db, { merchant })` rather
      than from the header's list-scoped breakdown. Snapshot stays as simple as
      `bulkCategorize`'s because the row set is DEFINED by one source category,
      so undo restores to a constant. Invalidates BOTH rollover chains, which
      is the one thing `bulkCategorize` does not have to do (its rows came from
      NULL). Refuses an empty row set and a same-category move rather than
      no-op'ing, because `applyRuleWrite` keys off the merchant and not off the
      rows — a zero-row "move" would otherwise be a live path to retraining or
      DELETING a rule with nothing to show for it.
      **It also closes the P2 at the top of this file** (a rule with a lot of
      history behind it is removed when one row is retargeted): `excludeTxnIds`
      is the whole moved set, so the verdict reads the ledger the action leaves
      behind. Move all 50 `K → Shopping` rows to Groceries with Remember ticked
      and the rule FOLLOWS them instead of being deleted — the "two-step the
      user could actually complete" that entry describes.
      **Two things came out of it that were not planned.**
      `assertAssignableCategory` — the four-check destination guard
      (`CategoryNotFoundError` / `SavingsGoalCategoryError` /
      `CategoryArchivedError` / `ParentAllocationError`, in that order) was a
      hand-maintained copy in `bulkCategorize` and `categorizeTransaction` and
      would have become a third. Every one of those checks only fires on input
      the picker cannot produce, which is exactly the class that must not be
      allowed to drift between callers. And `_transaction-row.tsx` seeded its
      badge and picker from `row` once at mount and never resynced, so after a
      bulk move the header read "49 filed as Groceries" directly above 49 rows
      each badged GAS — verified in the browser, then fixed with the same
      "adjust state during render" pattern `_month-editor.tsx` uses, resyncing
      the picker only while it is untouched so an unrelated revalidation cannot
      discard a pick in progress.
      (`src/lib/categorize/bulkRetarget.ts`,
      `src/lib/categorize/undoBulkRetarget.ts`,
      `src/lib/categorize/assertAssignableCategory.ts`,
      `src/app/transactions/_retarget-form.tsx`,
      `src/app/transactions/_transaction-row.tsx`,
      `src/app/transactions/actions.ts`, `src/app/transactions/page.tsx`)

## Follow-ups from the `/ship` pre-landing review + specialist army + Red Team (2026-09-08, funds-band + bulkRetarget)

Six specialists plus a Red Team pass over the D3=C branch (funds band + `bulkRetarget`), 40 findings. Fifteen were auto-fixed on the branch and are not listed here; what follows is what was deliberately deferred, with the reasoning, so the next reader is not re-deriving it.

The Red Team found a class the six per-file specialists structurally could not: **every one of the four `revalidatePath` gaps was invisible to a reviewer looking at one file.** The write is in `budget/actions.ts`, the stale read is in `loadGoals.ts`, and neither file is wrong on its own. Auto-fixed, but worth recording as a review-shape lesson: a freshness bug lives in the *edge* between two files, so a per-file lens cannot see it by construction.

### P1 — behavior newly reachable because the FUNDS band became editable

- [x] **DONE (round-5, 2026-09-08 — D2=A: fixed the UI, did NOT relax the rule; `assignableKinds` in `categoryKindLock.ts` is now the ONE spelling of rule 8 + X1, read by both `setCategoryKind` and `loadMonthView`, and `liveAssignableKinds` closes the window where the client's copy is stale).** A `$0` allocation permanently locks a fund's `kind`, and the row's own menu still offers to change it.**
      `setCategoryKind`'s `const isUsed = txnStats.count > 0 || periodCount > 0`
      (`src/lib/budget/setCategoryKind.ts`) treats a single `budget_periods` row as
      "used", and rule 8's X1 exception is `expense → income` only, so it never
      applies to a fund. Before D3=C a fund could not acquire a `budget_periods`
      row from anywhere; now typing any value into the new `AllocationCell` —
      **including `$0`** — or one click of "Copy previous month" (`copyMonth` has no
      kind filter) locks the category's kind forever. `CategoryMenu` on a fund row
      still renders "Set kind: expense", which from that moment always refuses:
      exactly the "discovered only after a refused submit" failure DS32 names.
      Decide which it is — either a `budget_periods` row genuinely IS usage (then
      hide/annotate the menu item on a fund that has one), or a zero-transaction
      fund with only planned rows is safely reclassifiable (then relax `isUsed`
      for that direction the way X1 relaxes expense→income).
      (`src/lib/budget/setCategoryKind.ts`, `src/app/budget/[year]/[month]/_month-editor.tsx`)

- [x] **DONE (round-5, 2026-09-08 — excluded outright rather than marked; every affordance the page offers an archived fund is a dead end).** `loadGoals` has no `archivedAt` filter, so an archived fund advertises a link to a page that will not show it.**
      `loadGoals` filters on `eq(categories.kind, "fund")` alone
      (`src/lib/goals/loadGoals.ts:59`), so an archived fund still renders a card —
      and D3=C gave every card a "Fund this month →" link into `#funds-band`.
      `notHiddenByArchive` (`loadMonthView`) drops an archived fund from a month
      where it has neither a nonzero allocation nor spend, so the destination row
      does not exist; if it was the only fund the whole band is absent, because
      `<MonthEditor>` gates the section on `fundRows.length > 0`. Even if the row
      rendered, `upsertAllocation` throws `CategoryArchivedError` on commit. Three
      ways to land nowhere. Either exclude archived funds from `loadGoals`, or mark
      them on the card and suppress the link.
      (`src/lib/goals/loadGoals.ts`, `src/app/goals/page.tsx`)

- [x] **ALREADY DONE in v0.23.0 (verified round-5: `loadMonthView.ts` bounds the SUM at the viewed month as a (year, month) pair). Never struck here.** "Planned to date" has no upper time bound, so a future month's allocation inflates this month's figure.**
      `loadFundPlannedToDate` sums `budget_periods.allocated_cents` with
      `inArray(categoryId, fundIds)` and no `(year, month) <=` clause. Its docstring
      defends unboundedness backwards — "since the fund existed" — but
      `/budget/[year]/[month]` is navigable and editable for future months and
      nothing gates commit on `phase`, so allocating next month's contribution
      immediately raises *this* month's "Planned to date" and shrinks "Left to
      target". The column label and the number disagree. Bound the SUM, or rename
      the column to admit it includes scheduled contributions.
      (`src/lib/budget/loadMonthView.ts`)

### P1 — a semantic disagreement this branch created

- [x] **DONE (round-5, 2026-09-08 — `loadGoals` wins, per rule 1 and `rules.ts`'s existing "poisons that category" guard. Fund-scoped, in SQL, with 3 tests incl. one proving an expense envelope's refund still carries forward).** A positive row filed to a fund inflates that fund's rollover; `loadGoals` deliberately refuses the same move.**
      D3=C put fund leaves into `rolloverCategoryIds` for the first time, so
      `rollover = max(0, prevEffective - spent)` now runs for funds — and `spent` is
      `0 - SUM(amount_cents)` with no `kind` filter in
      `loadRolloverEffectiveByCategory`. A positive unpaired row filed to a fund
      (interest credit, an unmatched savings deposit) therefore *raises* the carried
      balance above anything ever allocated. CLAUDE.md rule 1 records the opposite
      stance three paragraphs from here, and records it as deliberate: `loadGoals`
      stays outflows-only precisely so a deposit cannot increase progress on top of
      the allocation already counting the same intention. Two subsystems, one
      question, two answers. Pick one and pin it — the rollover half is currently
      unpinned either way, because every new fund-rollover test seeds allocations
      with zero transactions.
      (`src/lib/budget/loadMonthView.ts`, `src/lib/goals/loadGoals.ts`, CLAUDE.md rule 1)

### P2 — correctness-adjacent

- [x] **ALREADY DONE in v0.23.0 (verified round-5: `chosenIsGone` disables submit and names the problem). Never struck here.** `RetargetForm` silently substitutes a different source group when the chosen one disappears.**
      `const from = filed.find((f) => String(f.categoryId) === fromChoice) ?? filed[0]`
      is "derived, not synced" — so when an unrelated revalidation changes `filed`
      (categorizing a row on the same page, a second tab, an Undo landing) and the
      user's chosen source drops out, `from` falls back to `filed[0]`: a category
      they never selected. The hidden `fromCategoryId` input, the button label
      (`Move ${from.count}`) and the prose all follow it, and `canSubmit` only
      guards the case where the fallback happens to equal the destination. One
      click then moves a different, possibly much larger group. Disable submit and
      say "that group no longer exists — pick again" instead of substituting.
      (`src/app/transactions/_retarget-form.tsx`)

- [x] **ALREADY DONE in v0.23.0 (verified round-5: `runBulkRetarget`/`runUndoBulkRetarget` return outcomes as STATE). Never struck here.** Thrown Server Action messages are dev-only, so `bulkRetargetErrors`' carefully-worded refusals never reach a user.**
      `bulkRetargetErrors.ts`'s docstring says each error "carries the facts a
      person needs instead of a generic failure", but both are thrown out of a
      Server Action and rendered via `err.message`; Next.js replaces uncaught
      Server Action error messages with a generic string plus a digest in
      production builds, which is how this app ships (`output: "standalone"`).
      Same pattern as the pre-existing `categorizeTransactionAction`. Either return
      the refusal as action state — the shape `/sync`'s actions already use — or
      say in the docstring that these strings are dev diagnostics.
      (`src/lib/categorize/bulkRetargetErrors.ts`, `src/app/transactions/_retarget-form.tsx`)

- [ ] **No parity test between the count the retarget control promises and the rows `bulkRetarget` actually moves.**
      The control is labelled from `summarizeByCategory(db, { merchant })` while the
      rows moved come from `bulkRetarget`'s own WHERE — two independently written
      predicates, the same drift `loadMerchantGroups.totalRowCount` already has a
      parity test for. They agree today only because `buildPredicates` defaults
      `includeTransfers` false, and they **already diverge for the empty key**:
      `buildPredicates` skips the merchant predicate entirely when
      `filter.merchant === ""`, so the promised count would be ledger-wide while
      `bulkRetarget` moves only empty-key rows.
      (`src/lib/categorize/bulkRetarget.ts`, `src/lib/categorize/loadTransactions.ts`)

- [x] **ALREADY DONE in v0.23.0 (verified round-5: `livePlannedToDateCents`). Never struck here — and the same staleness class recurred one column right, in `assignableKinds`; see the round-5 section.** `/budget`'s "Planned to date" and "Left to target" read the server prop while the cell beside them reads optimistic state.**
      `formatCents(fund.plannedToDateCents)` and `fundTargetGap(fund)` come from the
      RSC prop; the `AllocationCell` one cell to the left reads `getAllocation()`.
      Since `plannedToDateCents` includes the current month, committing $200 into an
      empty fund leaves the row reading "Planned $200.00 · Planned to date $0.00 ·
      Left to target «unchanged»" until the island loses focus. This is the same
      "money materializing after an unrelated keystroke" hazard the
      `rolloverCategoryIds` comment was written to eliminate, reappearing two
      columns to the right.
      (`src/app/budget/[year]/[month]/_month-editor.tsx`)

### P3 — product / design judgment

- [ ] **With zero funds the FUNDS band does not render, so "+ Add a line" for a fund is unreachable from `/budget`.**
      `{fundRows.length > 0 ? <BandSection heading="Funds"> … }` gates the whole
      band including its `NewCategoryRow`. A6 says "no band at all when no fund
      exists", and that is deliberate — but it means the create affordance lives
      inside the thing it would create, so on the live ledger (0 funds, measured)
      the band never renders and `/goals` stays the only entry point. Either render
      a header-plus-create-row in the empty state, or accept `/goals` as the
      bootstrap and say so in DESIGN.md.
      (`src/app/budget/[year]/[month]/_month-editor.tsx`)

- [ ] **"Planned to date" cannot wrap, and `scroll-mt-6` is too small to clear the sticky mobile hero.**
      `BandColumns` pins column 3 to `w-[15%]` under `table-fixed` while shadcn's
      `TableHead` carries `whitespace-nowrap`, so the header cannot wrap the way
      DESIGN.md's own diagram draws it (`│ Planned │` over `│ to date │`); at the
      narrowest width DESIGN.md records as measured, column 3 has ~67px of text room
      for a ~100px label. Separately, `BandSection`'s `scroll-mt-6` (24px) is the
      offset the new `#funds-band` deep link scrolls to, but the hero it must clear
      is a `p-5` sticky card well over 120px tall on a phone — the only viewport
      where it is sticky — so the link lands the heading underneath it. 24px is also
      off DESIGN.md's stated 4/8/12/16/20/28/40/56 cadence.
      (`src/app/budget/[year]/[month]/_month-editor.tsx`, `src/app/budget/[year]/[month]/_band-section.tsx`)

### P3 — advisory (simplification lens; ~120 lines removable, none applied)

- [ ] **Three verbatim copies each of `priorRuleSchema` and the rule-reversal block.**
      `priorRuleSchema` is now byte-identical in `validateBulkRetargetSnapshot.ts`,
      `validateBulkCategorizeSnapshot.ts` and `validateCategorizeTransactionSnapshot.ts`
      — all three guarding the same crafted-Undo hole (`{matchType: "regex",
      matchValue: ".*"}` as a catch-all rule), so a branch drifting out of one copy
      is silent. Export one from `priorRuleSnapshot.ts`, which already owns
      `PriorRuleSnapshot` and the narrowed `matchType`. Likewise the
      `ruleTouched → deleted/already-gone/restored` block is a third transcription
      across `undoBulkRetarget`, `undoBulkCategorize` and `undoCategorizeTransaction`;
      extract `revertRuleWrite` beside `restorePriorRule`. Rule 6 records that the
      equivalent *write*-side triplication had already drifted before `applyRuleWrite`
      consolidated it — this is the same shape, at the same count.
      (~84 lines)

- [ ] **`fundAllocation` duplicates `leafRows`' inline allocation block; `FundRow.hasAllocation` has no consumer.**
      `fundAllocation`'s own comment says it is "identical to `leafRows`' allocation
      block above" while `leafRows` still carries the inlined original, so the
      rollover triple has two spellings that must move together — hoist it and call
      it from both. And `FundRow.hasAllocation` is exactly `allocation !== null`
      (both written from the same `hasPeriodRow.has(leaf.id)`) with no production
      reader: the fund rows go through `getAllocation()`. `IncomeLeafRow.hasAllocation`
      is genuinely load-bearing and should stay.
      (~17 lines)

- [ ] **The zod-issue-to-throw block appears six times; the 10s undo duration is hardcoded at three call sites.**
      `parsed.error.issues.map(...).join("; ")` + throw is copied verbatim across
      `src/app/transactions/actions.ts` (×4) and `src/app/categorize/actions.ts` (×2),
      varying only in a label. Separately `duration: 10_000` is repeated at three undo
      surfaces while a dozen comments and CLAUDE.md call "the 10s Undo window" a
      contract — and `/subscriptions` has already drifted to `15_000`.
      (~18 lines)

- [ ] **`/goals` hand-rolls a total the read model should own.**
      `plannedCents={view.goals.reduce((sum, g) => sum + g.totalContributedCents, 0)}`
      computes an aggregate in the view layer while `GoalsView.totalProgressCents`
      is left with zero production consumers (referenced only from `loadGoals.test.ts`).
      Add `totalContributedCents` to `GoalsView` and consume it, the way
      `totalTargetCents` already is one line below.

## Follow-ups from the `/plan-eng-review` "what next" pass (2026-09-08, round 5)

Fifth triage. It set out to answer "what next" against `TODOS.md` and `PLAN.md`
and found two things worth more than any individual item in either file.

**First: the list is not trustworthy as a count.** Five of the twelve entries in
the newest section were already fixed during v0.23.0's own ship review and never
struck. Open items read 63 → 100 → 125 across six releases while product facts
stayed flat, and part of that growth is bookkeeping, not debt. Verify before
scheduling.

**Second: the one measured fact that moved in six releases moved by USE.** The
backlog went 437 → 236 because someone sat and clicked. v0.23.0 shipped the
FUNDS band specifically so a fund could be funded, and funds was still 0 when
this pass started. So this release is a narrow script with a before/after
measurement, not a feature. Codex (gpt-5.4) ran as the outside voice and made
the sequencing call sharper on every point; decisions **D1=A** (narrow script),
**D2=A** (fix the UI lie, do NOT relax rule 8), **D3=A** (close gate #2 by
documenting the model the code already implements).

**Codex's decisive correction, which reversed this pass's own recommendation:
gate #2 was never closable by use.** `progressCents` (`allocated − withdrawn`)
and `totalContributedCents` can only diverge if a fund has transaction rows, and
nothing can file one — `assertAssignableCategory` throws
`SavingsGoalCategoryError` on `kind='fund'` for all three categorize paths,
`CategoryCombobox` filters funds out of the picker, and `rules.ts` refuses a
positive row into a fund at import. The two numbers are identical on any ledger
this app can produce. There was no experiment to run, only a decision to write
down. This is the second round running that a gate's stated blocker turned out
to be misdiagnosed; both times the outside voice found it.

Measured before → after, live ledger inside the container:
funds **0 → 1**; fund `budget_periods` rows **0 → 2**; categories on
`carryover_policy='rollover'` **0 → 1**; budgeted months **1 → 2** (2026-09 and
2026-10, 24 rows each). Rollover executed for the first time in the app's
history and rendered `+$250.00 rollover → $500.00` at first paint on a cold load.
1,804 tests passed **as measured on 2026-09-08** (1,891 across 117 files on
2026-09-09; the number moves every release, so treat it as a timestamp rather
than a fact). Backlog unchanged at 236; manual rows still 0.

**PLAN.md's 1.0.0 gate is now fully open to closing:** #1 was already closed, #2
is documented in `DESIGN.md` ("What a fund's progress means"), and #3's two
conditions are both met by the measurements above.

### Corrected in `PLAN.md` rather than carried as a TODO

- [x] **Gate #3 cited evidence that was not evidence.** It read "every
      `budget_periods` row has `effective_allocation_cents = NULL`" as proof the
      rollover subsystem had never run. TS1 deleted `getEffectiveAllocation`'s
      `persist` option, so the ONLY non-NULL writer left is
      `src/lib/test/primeCache.ts` — a test helper. All-NULL is the designed
      steady state. Nor is the invalidation contract "fired from four call
      sites" idle: `invalidateForwardRollover`/`Many` runs from **13 sites
      across 11 files** on every categorize, allocate, retarget, undo,
      copy-month, kind change and carryover-policy change — it executes constantly and does
      nothing. `src/lib/budget.ts`'s own docstring says so and names fund work
      as its removal trigger.

### Still open

- [x] **P2 — DONE (2026-09-08, migration `0021_drop_rollover_cache`).** Deleted:
      the column, the unreachable cache-read branch in `getEffectiveAllocation`,
      both `invalidateForwardRollover` functions, all 13 call sites, the two
      orphaned `earliestPeriod` SELECTs and six dead `parseIsoMonth` locals they
      fed, `src/lib/test/primeCache.ts`, and 36 tests. Verified against a copy
      of the real ledger first (both indexes survive, `integrity_check` ok,
      `foreign_key_check` clean, unique constraint still enforced, all rows
      preserved) — note the rehearsal copy was the pre-usage-pass export, so it
      held 23 `budget_periods` rows where the live ledger by then held 48 across
      two months; the migration is a bare `DROP COLUMN` and is row-count
      independent, but the rehearsal was not against the identical state. Then
      applied to the live volume through the container entrypoint's pre-migrate
      snapshot, which verified 48 rows and 1,562 transactions intact afterwards. `/budget/2026/10` renders
      `+$250.00 rollover → $500.00` byte-identically before and after, which is
      the proof the cache was doing nothing. Original entry:
      **Delete the dead `effective_allocation_cents` cache, or give it
      a real writer.** 13 call sites across 11 files maintain an invalidation
      contract for a column no production code ever writes non-NULL; every new
      write path has to remember to call it (`bulkRetarget` added two more in
      v0.23.0) and CLAUDE.md documents it as a contract. Its docstring defers on
      "PR3's fund work may legitimately want a real cache" — that trigger has now
      arrived and the answer, from this pass, is that it does not: `loadMonthView`
      recomputes from `allocated_cents` and transaction sums and the fund band
      showed no measurable cost at 1,562 rows. **Deliberately sequenced AFTER
      this release, not before:** touching 13 write-path call sites in the same
      change that runs rollover for the first time is backwards. Now that it has
      run, this is safe to do. (`src/lib/budget.ts`, plus the 11 callers)

- [ ] **P3** — **`liveAssignableKinds` is module-private in a `"use client"`
      file and unreachable from a test.** (Merged 2026-09-09: filed twice, here
      and again in the 2026-09-09 `/ship` section.) It carries a real precision
      the pure half cannot: its `kindsImplyUsed(serverKinds)` guard narrows ONLY
      the all-three case, because X1 turns on TRANSACTIONS (which an allocation
      commit cannot create) and a blanket narrowing would silently withdraw
      rule 8's one repair path. Same shape as the existing entry about
      `resolveActiveCategoryName` in `page.tsx`, and the same reason it is not
      tested: the V1 exclusion list rules out UI-component tests. The pure rule
      underneath IS covered (`categoryKindLock.test.ts`, `kindsImplyUsed.ts`).
      **What makes it worth more than its size:** the simplification that breaks
      it — `if (live !== null) return [currentKind]` — reads as obviously
      equivalent, and would remove the X1 menu item after any allocation commit
      with the whole suite green. It has no React dependency, so it can move
      beside `assignableKinds` in `categoryKindLock.ts` and have its three
      branches pinned. If those module-private helpers ever get extracted, this
      one goes with them. Found by the Testing specialist during `/ship`
      2026-09-09.
      (`src/app/budget/[year]/[month]/_month-editor.tsx`,
      `src/lib/budget/categoryKindLock.ts`)

- [ ] **P3** — **A stale server prop feeding a client menu is now a known
      recurring shape, and nothing catches it.** v0.23.0 fixed it for
      "Planned to date" (`livePlannedToDateCents`); this pass reintroduced it one
      column right with `assignableKinds` and only caught it by clicking the menu
      in a browser against the real ledger — the full suite was green with the
      bug present. The cause is structural: `commitAllocationAction` deliberately
      does not revalidate and `revalidateBudgetSurfacesAction` fires only when
      focus leaves the WHOLE island, so ANY server prop describing a row's state
      is stale between a commit and a blur. Worth a rule rather than a third
      one-off fix: a prop consumed inside `<MonthEditor>` that a commit can
      change needs a `live*` reader beside it.
      (`src/app/budget/[year]/[month]/_month-editor.tsx`)

- [ ] **P3** — **Freeze broad triage (Codex #5).** The remaining ~118 items are
      mostly review exhaust. The recommendation carried out of this pass is to
      keep only what blocks the next narrow script or can corrupt money, and
      treat the rest as parking lot rather than as a queue. Named explicitly so
      the next reader does not mistake the file's length for a plan.

## Follow-ups from deleting the dead rollover cache (2026-09-08, migration 0021)

- [ ] **P3** — **`earliestDate` is now produced, validated and round-tripped, but
      READ BY NOTHING.** Every consumer was an `invalidateForwardRollover` call.
      `bulkRetarget` still returns it, `runBulkRetarget` still passes it to the
      client, both snapshot validators still enforce it (`z.iso.date()`,
      non-nullable on the retarget side), and `undoBulkRetarget`/
      `undoBulkCategorize` now ignore it. Same for `earliestApplyToPastDate` on
      the single-row path.
      **Deliberately NOT removed in the same change, and the reason is not
      timidity:** it is carried in the Undo snapshot, so dropping it changes the
      undo WIRE FORMAT while a 10-second toast may be holding a payload that
      still has it. That is a different class of risk from deleting a cache, and
      bundling the two would have made one PR do two things — the same mistake
      this deletion was split out of the fund work to avoid. The validators keep
      it because a field the client can hand back is part of the schema's
      contract whether or not today's code reads it, and a schema that accepts
      `2026-13-01` for a field it carries is a trap for the next reader.
      Removing it means: drop it from `BulkRetargetResult`/`BulkCategorizeResult`,
      both snapshot schemas and their tests, and confirm the parse is tolerant of
      an in-flight payload that still carries it.
      (`src/lib/categorize/bulkRetarget.ts`, `bulkCategorize.ts`,
      `validateBulkRetargetSnapshot.ts`, `validateBulkCategorizeSnapshot.ts`,
      `runBulkRetarget.ts`)

- [ ] **P3** — **The 36 deleted tests exercised a mechanism against a state only a
      test helper could produce, and six were vacuous outright.** Stated carefully,
      because the first draft of this entry got it backwards and claimed all 36
      "asserted NULL was NULL": most of them PRIMED a non-NULL value through
      `primeCache` (a `src/lib/test/` helper — the only non-NULL writer that ever
      existed) and then asserted the transition back to NULL. That does exercise
      the clearing. What it cannot exercise is the CACHE, because no production
      state could reach the starting condition.
      The genuinely vacuous six are the ones worth remembering — the sole assertion
      in `it("does not persist effective_allocation_cents")` was
      `rows.every((r) => r.effectiveAllocationCents === null)` with nothing primed,
      which no code change could ever have falsified. Several sweeping
      `every(... === null)` checks also ranged over months that were never primed,
      so they were already passing for rows that could not have held a value.
      Dropping the COLUMN is what surfaced all of it: TypeScript flagged every
      reference. Had the machinery been deleted while leaving the column, the six
      would have kept passing as pure noise.
      **Two rules worth applying beyond this cache.** An assertion that a thing is
      absent is only coverage if something in the codebase can make it present —
      grep for the writer before trusting an `expect(...).toBeNull()`. And a test
      whose setup can only be reached through a test-only helper is testing the
      helper's premise as much as the code.
      (`src/lib/budget.test.ts`, `src/lib/budget/loadMonthView.test.ts`,
      `src/app/budget/actions.test.ts`)

## Follow-ups from the `/plan-eng-review` "what next" pass (2026-09-08, round 6)

Sixth triage. `PLAN.md`'s three 1.0.0 gates were all closed going in, so this
pass had no gate to measure and went looking for what should follow one.
Codex (gpt-5.4) ran as the outside voice. Decisions **D1=A** (ship the two
safety items as one release), **D2=A** (correct the liability entry, defer the
pass), **D3=B** (hold 1.0.0 behind a written post-gate criterion).

**Both reviewers independently ranked the same two items above every feature
candidate, and neither was on the slate this pass assembled** — one came from
Codex, one from both of us at once. Both shipped in this release.

Measured against the live ledger inside the container, 2026-09-09: 1,562
transactions; uncategorized non-transfer backlog **236 → 188**, still moving
purely by clicking; `import_source='manual'` rows **still 0**; credit card and
mortgage **still 0 rows each**; funds 1; budgeted months 2; rollover categories
1; 177 rules. `integrity_check` ok, `foreign_key_check` clean, 0 rows in the
residual-duplication class, 0 legacy orphans. Tests went 1,802 → 1,836 across
110 → 113 files during that pass. **Re-measured 2026-09-09 on the
`close-revalidation-class-and-card-repair` branch: 1,891 tests across 117
files** — the figure above is a snapshot of one release, not a current count,
and the same is true of every other test count in this file. Re-run
`pnpm test` rather than quoting one.

**The backlog residue is harder than what has been cleared, and the number
alone hides it.** Of the remaining 188, `ONLINE` (19) and `MOBILE` (15) are
`LOSSY_MERCHANT_KEYS` that rule 6 refuses to train, and `COSTCO WHSE` (10) and
`AMAZON` (9) are the known-unresolvable multi-category pair. That is 53 rows /
28% in groups where no exact rule can ever be right. The 437 → 188 clearing
took the tractable 57% first, which is correct, but it means the remaining
per-row cost is not the same as the cleared per-row cost. Do not project the
burn-down rate forward.

### Shipped in this release

- [x] **P1 — `/sync` re-verifies the account link inside the write
      transaction.** Found by Codex; the four-section review missed it. The
      linked-account set is read at `sync.ts` before `await fetchAccounts` and
      the insert happens after it, so `account.id` and `feedId` are a
      precondition carried across an await — and `setAccountLink` can commit in
      that window, from a second tab, with both controls on the same `/sync`
      page. Feed A's rows would land on an account now pointed at feed B,
      carrying feed A provenance: invisible to the id pass (wrong feed),
      invisible to content dedup (`eq(accountId, …)`-scoped), and unprotected
      by the partial unique index. That is the misfiling class migration `0020`
      exists to prevent, reintroduced as a race rather than as a schema
      mistake. `verifyStagedLinks` drops the moved account's rows rather than
      failing the sync, since every other account was staged against a link
      that did not move; nothing is written for a dropped account, so the next
      sync re-stages it. `insertedCount` and `import_batches.transaction_count`
      now report what was WRITTEN, not what was staged, which means a `synced`
      outcome can carry `insertedCount: 0`. Four of the five tests added to `sync.test.ts`
      fail without the guard; the fifth is the ordinary-case control. (The
      branch grew to 34 new tests across three further files — see the
      /ship section below.)
      **The idiom already existed and had not been applied here:**
      `undoSyncBatch` re-checks its own precondition inside its transaction
      rather than trusting the page's check (rule 5) — reasoning that applies
      with more force to the write that moves rows onto an account.
      (`src/lib/simplefin/sync.ts`)

- [x] **P1 — the budget row menu confirms before an irreversible kind
      change.** Found by this review and by Codex independently.
      `_category-menu.tsx` called `setCategoryKindAction` straight from a
      dropdown click, while `_reclassify-income.tsx` has always gated the same
      write behind a dialog that says it cannot be undone — and v0.24.0's
      `assignableKinds` work made the menu item appear exactly when the server
      WILL accept it, so the unguarded path became the MORE discoverable of the
      two. X1 is one-way: rule 8 refuses income → expense on a used category,
      and being used is X1's own precondition. The gate keys off
      `assignableKinds.length < 3`, which is exact rather than heuristic —
      `assignableKinds` returns all three kinds iff the category is unused, so
      fewer than three means used, and on a used category the only change the
      menu can offer IS X1. Unused categories still apply immediately; a modal
      on reversible setup is friction that teaches people to click through
      modals. Verified in a browser across all four branches.
      (`src/app/budget/[year]/[month]/_category-menu.tsx`)

### Corrected rather than carried

- [x] **The liability usage-pass entry had three false premises and would have
      cost something.** See the CORRECTED AGAIN block on that entry above. The
      utilization claim was already stale (the limit is $3,200, the bar
      renders), `paidDownCents` is month-bounded so the four pre-September
      payments cannot move September, and the mirror rows would trip
      `hasAnyTransactionRows` and permanently disable the card's automatic feed
      balance. Re-sequenced to run alongside (a) rather than before it.

### Still open

- [x] **P2 → CLOSED (2026-09-16, verified by re-reading the code and git
      history — no new fix needed, both halves were already shipped).**
      `revalidateBudgetSurfacesAction` was two bugs; this entry's own text
      correctly flagged half one as unverified rather than claiming it was
      still broken, and that re-check is what this closure records.
      **Half one — it can fire before the write it is flushing has landed —
      was CLOSED in v1.2.2 (`18d1109`, 2026-09-15), three days before this
      entry's own "half two" verification pass, which never circled back to
      update half one's status.** `_month-editor.tsx` gained
      `pendingCommitsRef` (a `Set<Promise<unknown>>`) in that commit: `commit`
      registers its `commitAllocationAction` promise into the set BEFORE its
      own `await`, in the same synchronous bubbling `blur`/`focusout`
      dispatch `dirtyRef` already relied on, and `revalidate()` now does
      `await Promise.allSettled(inFlight)` — snapshotting the set — BEFORE
      calling `revalidateBudgetSurfacesAction()`, not just checking the
      `dirtyRef` counter as this entry originally described. That closes the
      exact gap named above: the revalidation call can no longer race ahead
      of the write it is flushing. `CHANGELOG.md`'s 1.2.2 entry documents the
      user-visible fix ("Now it waits for every change on the page to finish
      first"). No new component test exists for it — this app's own
      exclusions rule out UI-component tests (categorization logic only), so
      this was verified live per that release's own process, not by a test
      this pass could re-run; the closure here rests on reading the current
      `_month-editor.tsx` mechanism directly, which is sufficient to confirm
      the race the original text describes is gone.
      **Half two — no budget write revalidates `/` at all — FIXED.** Verified
      2026-09-15 directly against the code, not just this file's prose:
      `upsertBudgetAllocationAction`, `revalidateBudgetSurfacesAction`,
      `copyPreviousMonthAction`, and the shared `revalidateCategorySurfaces`
      (archive/unarchive/create/create-group/rename, set-carryover-policy —
      a wider set of writers than this entry originally named) all now call
      `revalidatePath("/")` alongside their existing paths, so `/`'s "This
      month" summary and "Closest to limit" tile pick up an edit made on
      `/budget` on the next load. **`moveCategoryAction` is the one
      exception** — it never called `revalidateCategorySurfaces` (it has its
      own narrower `guardRefresh`, untouched here) and still does not
      revalidate `/`, correctly: reordering changes neither the category set
      nor any name/kind/allocation `loadMonthView` reads. Pinned by ten
      tests in `actions.wiring.test.ts` ("every budget-surface write
      revalidates '/', not just /budget") — one per real caller of
      `revalidateCategorySurfaces` (create, create-group, rename, archive,
      unarchive, set-carryover-policy) plus the three direct callers and one
      asserting the `moveCategoryAction` non-call. 2054 tests pass,
      `tsc --noEmit` clean.
      (`src/app/budget/actions.ts`, `src/app/budget/actions.wiring.test.ts`)

- [x] **P2 → PARTIALLY CLOSED (2026-09-17). The "spends a slot on every
      restart" and "degraded snapshot proceeds after only a console.error"
      halves are fixed; the crash-loop half is explicitly NOT — see below.**
      `docker/entrypoint.src.mjs` gained `hasPendingMigrations(dbPath,
      migrationsFolder)`, which mirrors drizzle's own migrator comparison
      (`SQLiteSyncDialect#migrate`: a migration runs iff its `folderMillis`
      exceeds the newest applied one in `__drizzle_migrations`) rather than
      the cruder "row count vs journal length" heuristic this entry
      suggested — so it can't drift from what `migrate()` itself decides.
      `main()` now takes the pre-migrate snapshot and calls `pruneSnapshots`
      only when `hasPendingMigrations` is true, so an ordinary
      `restart: unless-stopped` reboot with nothing to apply neither writes a
      snapshot nor spends a retention slot pruning one. That also makes the
      degraded-snapshot check meaningful in the one case where it matters: a
      `!snapshot.consistent` result now REFUSES to boot (`fail(...)`) rather
      than logging a `console.error` and proceeding, because by construction
      it can only fire when a migration is actually about to run — exactly
      the case this entry named ("0020 and 0021 have no down migration...
      refuse on `!snapshot.consistent` when there ARE pending migrations").
      **Not fixed, and not claimed fixed: the crash-loop half.** This entry's
      own text is explicit that the pending-migrations check does not rescue
      it — if a migration FAILS against the live volume, migrations stay
      pending on every `restart: unless-stopped` retry, so a crash loop still
      takes an unbounded full-ledger `VACUUM INTO` on every restart (the
      pending check now correctly identifies EVERY one of those restarts as
      "migration pending," which is true, just not sufficient on its own to
      bound the count). The documented mitigation stands: run the migration
      once via `docker compose run --rm` before bringing the restarting
      service up. 12 new tests in `docker/entrypoint.test.mjs` pin
      `hasPendingMigrations` against the real migration folder (no db yet,
      fully caught up, a newer migration added after catch-up, an empty
      folder); 2238 tests pass, `tsc --noEmit` clean, lint clean.
      (`docker/entrypoint.src.mjs`, `docker/entrypoint.test.mjs`)
      Original entry:
      **The container spends a snapshot retention slot on every
      restart, not on every migration.** (Merged 2026-09-09: this was filed
      FOUR times — twice verbatim, plus the degraded-snapshot and crash-loop
      halves as separate entries. All four are one boot-path decision.)
      `docker/entrypoint.src.mjs` takes a
      full `VACUUM INTO` and calls `pruneSnapshots(…, 10, PRE_MIGRATE_PREFIX)`
      on every successful boot regardless of whether `migrate()` applied
      anything — `runMigrations` does not report it, so the entrypoint cannot
      tell the difference. Under `compose.yaml`'s `restart: unless-stopped`,
      ten boots after a destructive migration lands, that migration's last
      pre-migrate snapshot is evicted. This repo already made exactly this
      argument for the merchant backfill — `snapshot.ts` gives it its own
      `BACKFILL_PREFIX` because "a shared pool would have evicted it silently"
      — and `0021` is the first `DROP COLUMN` in the chain with the same
      property. Measured on the live volume: 10 snapshots, 8 of them
      predating migration `0021` (verified by opening each and checking for the
      dropped column), accumulated in ~2 days; two are 3 minutes apart with
      identical schema and identical row counts.
      Detection is trivial and already testable — `__drizzle_migrations` holds
      22, `drizzle/meta/_journal.json` holds 22, and `entrypoint.test.mjs`
      already drives `runMigrations` against a temp DB. The other candidate fix
      is to give a migration that DROPS anything its own prefix.
      **The degraded-snapshot half.** `docker/entrypoint.src.mjs` proceeds with
      a migration on a `consistent: false` snapshot after only a
      `console.error`. Rule 5 records that a degraded snapshot came from a plain
      file copy with a reader pinned, and that such a file has been measured
      failing to open at all (`SQLITE_CORRUPT`). For a reversible schema change,
      proceeding is the right trade; `0020` and `0021` have no down migration,
      so for an irreversible one it means running with no usable rollback point.
      Snapshotting only when migrations are pending is what makes the fix here
      cheap: refuse on `!snapshot.consistent` when there ARE pending migrations,
      since a degraded snapshot only matters when there is a migration to roll
      back. Workaround until then: take a verified snapshot by hand first with
      `pnpm db:export`, which refuses to copy out a degraded one.
      **The crash-loop half, which the pending-migrations check does NOT fix
      (Codex's correction).** If a migration FAILS against the live volume,
      `restart: unless-stopped` crash-loops the container, migrations stay
      pending on every restart, and each restart writes a fresh full-ledger
      `VACUUM INTO` with no bound — `pruneSnapshots` is only reached on the
      success path, which is correct per rule 5, so the ordering is not the bug;
      the unattended retry is. `0020` was the first migration here whose failure
      mode depends on ledger *content* (a UNIQUE index built over existing rows)
      rather than on schema alone. Mitigation today: run the migration once via
      `docker compose run --rm` before bringing the restarting service up.
      **And it does not rescue `0021`** — the surviving pre-0021 snapshots hold
      23 `budget_periods` rows where the live ledger now holds 48, so that
      rollback is already lossy. This is hardening for the NEXT destructive
      migration, not recovery of the last one. Do not schedule it as urgent on
      the strength of the countdown; the thing expiring has no rollback value
      left. Found by the Data-Migration specialist, confirmed by the Red Team
      and corrected by Codex across the `/ship` passes of 2026-09-08/09.
      (`docker/entrypoint.src.mjs`, `src/lib/snapshot.ts`)

- [ ] **P3** — **The composite index on `transactions(category_id,
      amount_cents)` is real and premature.** (Merged 2026-09-09: this was
      filed twice, at P2 in the 2026-09-09 `/ship` section and at P3 here. P3
      wins — it is the one carrying the downgrade reasoning.) Premise verified:
      `loadCategoryKindUsage` (query #7, new in v0.24.0) is unconditional per
      `/budget/[year]/[month]` render, and its `negativeCount` term forces a row
      fetch for every transaction in every rendered leaf category —
      date-unbounded and whole-ledger, on a synchronous driver in a Server
      Component render path, growing linearly with total ledger size forever.
      The whole-ledger scope is not avoidable because rule 8's `isUsed` is a
      whole-ledger fact, so an index is the only available fix; measured by the
      Performance specialist at 1.702ms → 0.517ms, with the plan changing from
      `SEARCH transactions USING INDEX transactions_category_idx` to
      `USING COVERING INDEX`.
      **But that measurement is on a 10,800-row synthetic** (25 categories, 72
      months) and this ledger holds 1,562 rows. Downgraded from P2 to P3 on that
      gap alone — it is correct work at the wrong time, and it is a migration.
      A second reason not to bundle it: v0.24.0/v0.25.0 already carry migration
      0021 against the real ledger, and a second migration in the same release
      doubles what a bad boot has to be diagnosed against, for a latency nobody
      has felt. Do it standalone, and revisit when the ledger is large enough
      for the number to mean something. Related and unmeasured: the entrypoint's
      boot-time `VACUUM INTO` is a full ledger copy that also grows linearly
      forever.
      (`src/db/schema.ts`, `src/lib/budget/categoryKindLock.ts`)

## Follow-ups from the `/pr-review-toolkit:review-pr` pass (2026-09-09, sync-relink-guard branch)

Five analyzers (code, tests, comments, silent failures, types) over the branch
that shipped `verifyStagedLinks`. Four CRITICAL and ten important findings; all
were fixed on the branch rather than deferred, so this section is the record of
WHAT was wrong rather than a queue. The three that are worth remembering:

- **A guard that closes half a class reads as closing the class.** Six
  independent reviewers, across two separate passes, found that
  `refreshLiabilityBalances` carried the identical read-before-await
  precondition on a bigger write — and the first pass's own docstring said
  "this write is the one that moves money onto an account", which was the
  comparative superlative that stopped anyone looking. An anchor is the whole
  balance (rule 1) with one undo slot (rule 9); a misfiled row is deletable.
  The bigger one was the unguarded one.
- **A warning is only non-silent if it survives the tab.** The drop warnings
  were the entire mechanism making a withheld import visible and lived only in
  `useActionState`. Rule 5 had already settled this exact question for the
  snapshot warning and the reasoning was not carried across.
- **An exported const in a `"use server"` module breaks every export in it.**
  Turbopack reports "the module has no exports at all"; `tsc` is silent and no
  unit test imports a route module. Only loading the page finds it.

### Still open

- [x] **P3 → CLOSED (`sync-dedup-race-fixes` branch).** **The CONTENT dedup pass is still read before the write transaction, so a concurrent CSV `commitImport` produces a genuine duplicate row.** `existingByContent` is read in `syncSimpleFin`'s staging loop and trusted after it. Unlike the id pass it has no unique index behind it, so a `commitImport` landing in the staging → transaction window does not abort the batch — it silently leaves a second copy of a row the feed and the CSV both carry. Quieter than the id-pass failure, and worse. Not fixed by widening the id query: the content budget is a multiset COUNT (rule 3, so two identical same-day coffees both survive), and re-deriving that inside the transaction is a different and larger change than re-checking a unique key. Rule 11's general instruction applies — this is the value `syncSimpleFin` still carries across an `await` without re-verifying.
      **The ID half is DONE (v0.26.0), and is recorded here because it is the half that makes the remaining one legible.** The id pass now re-runs inside the write transaction, so a second sync committing between staging and the write has its rows dropped as the duplicates they are instead of colliding on the partial unique index and aborting the whole batch with a raw `SqliteError` (verified: removing the re-check reproduces exactly that error in the regression test). Note the window is NOT the fetch — the id pass reads in the staging loop — it is staging → transaction, which spans `createSnapshot`'s `VACUUM INTO`; the test races at that seam because that is where the seam is. This entry carried an `[x]` from the day the id half landed until the 2026-09-09 audit, which meant the open half was invisible to every "what is still open" grep — the worst failure mode this file has.
      **The CONTENT half is now done too.** `recheckContentDedup` (`src/lib/simplefin/sync.ts`) re-verifies inside the write transaction — and on the `NothingVerifiedError` rollback path — mirroring the id pass: a fresh per-signature tally is diffed against `originalContentBudget` (a frozen pre-consumption snapshot carried on each `Staged` entry), and only the per-signature DELTA since staging is treated as a race-loss, so an already-correct staging-time match is never re-litigated. Two regression tests confirmed to fail against the pre-fix code and pass with it (`sync.test.ts`, "content dedup is re-verified inside the write transaction" describe block). A dedicated adversarial review found and closed three follow-on gaps in the fix itself: the drops weren't pruned from `expectedCardExternalIds`, producing a false D8.4 "doesn't appear in the ledger" alarm on a card; the rollback path didn't chain the content recheck's output into the cutover recheck, so a row that was both content-raced and genuinely pre-cutover got two contradictory warnings; and per-account `AccountSyncCounts` went stale on a raced account. All fixed via a shared `applyDedupPruning` (merged with the cutover side's own pruning helper) and rollback-path chaining.
      (`src/lib/simplefin/sync.ts`, `src/lib/simplefin/sync.test.ts`)

- [ ] **P3** — **`verifyStagedLinks` proves *a* transaction, not *the* one.**
      `SyncTx` makes passing `db` a build error (pinned by `_DB_IS_NOT_A_TX`),
      but `db.transaction((tx) => verifyStagedLinks(staged, tx))` followed by a
      SEPARATE `db.transaction` for the insert compiles, passes every test, and
      fully reinstates the race — and it is the more likely refactor, since
      someone wanting the verify step testable in isolation would write exactly
      that. A branded `WriteTx` minted by one cast at the single write site
      would close it; judged not worth one cast for one property while the
      function is module-private and has one caller.
      (`src/lib/simplefin/sync.ts`)

- [x] **P4 — DONE.** **`feedId` was a bare `string` in a codebase that spent a
      release on the distinction.** Rule 3 makes "which feed produced this row" a
      different fact from "which account holds it", and migration `0020` exists
      because `account_id` was a wrong proxy for it. `verifyStagedLinks(staged
      .map(s => ({...s, feedId: s.rows[0].externalId})), tx)` typechecks —
      `externalId` is the TRANSACTION id, unique only within the feed — and so
      does `feedId: ""`, which drops every account with a plausible warning. A
      branded `FeedAccountId` minted once off `account.simplefinAccountId` and
      once off `response.accounts[].id` would make both a type error.
      Done: `src/lib/simplefin/feedAccountId.ts` brands it, `asFeedAccountId`
      is the one mint and rejects `""`, and substituting a transaction id at the
      staging site is now a build error.

- [x] **P4 — DONE.** **~140 lines of duplicated test harness.**
      `syncRelinkGuard.test.ts` re-declares the `syncSimpleFin` harness
      `sync.test.ts` owns — the `vi.hoisted` mock trio, all three `vi.mock`
      factories, the date constants, and a 21st hand-copy of `seedAccount` —
      and the branch grew two spellings of the same mid-fetch mutation idiom
      (`relinkDuringFetch` and `respondAfter`). CLAUDE.md already tracks the
      `seedAccount`/`seedBatch`/`seedCategory`/`seedTxn` duplication as a known
      item — see **"`seedAccount`/`seedBatch`/`seedCategory`/`seedTxn` are
      duplicated across 31 files"** above, which this fix reduces by one rather
      than closing; the whole-repo move is still open.
      Done: `src/lib/simplefin/test/syncFixtures.ts` owns the constants,
      `seedAccount`, `feedTxn`, `feedAccount` and the outcome narrowers. The
      `vi.mock` block stays per-file — `vi.mock` is hoisted per-FILE, so a
      shared module cannot register mocks for a caller — and the reason is
      recorded in the new file.

- [ ] **P4** — **`verifyStagedLinks` returns three parallel collections.**
      `{ verified, warnings, droppedAccountIds }` leaves the caller correlating
      a `number[]` against `counts[].accountId` through a Set, and throws away
      the drop REASON that the reconciliation would like in order to explain a
      zeroed record. A 1:1 `LinkCheck[]` (`{ outcome: "verified" | "dropped",
      staged, reason, warning }`) built with `.map` would make the partition
      structural and carry the warning with its account. Worth doing if that
      function grows a fourth branch.
      (`src/lib/simplefin/sync.ts`)

## Follow-ups from the card-repair branch + backlog audit (2026-09-09)

Found while building `removeCardActivity` and the shared `/accounts` status
line, and while auditing this file. None is a correctness defect; all three are
shapes that will drift if nobody names them. Measured on this branch: 1,891
tests across 117 files.

- [ ] **P3** — **There is no EDIT path for a hand-entered card charge; delete
      and re-add is the whole repair story.** `removeCardActivity` landed on
      this branch, so a mistyped charge is no longer raw-SQL-only — but the
      repair is delete-then-re-enter, not an in-place edit, so correcting a
      single digit in an amount means retyping the date, the memo and the
      category too. That is acceptable today and the entry exists to record
      WHY, and what would make it stop being acceptable.
      **Two things change under a delete/re-add that an edit would not.** The
      row gets a NEW `transactions.id`, and it gets a NEW `import_batches` row
      — E21 gives every manual operation its own batch, and
      `removeCardActivity` deletes the old batch along with the row it existed
      to carry. Both are fine right now **because nothing references a manual
      row's id**: it carries no `transfer_pair_id` unless it is a payment
      mirror (and `unmarkCardPayment`, not this path, owns that case), no
      `import_batch_categorizations` row (import-time categorization only fires
      on the CSV and feed paths), and no `/import/success/[batchId]` link
      anywhere in the UI. **That is the thing to re-check before relying on
      it.** The moment anything durable points at a transaction id — split
      transactions, a receipt attachment, a reconciliation marker, a
      `balance_snapshots` table, or an undo payload held across a toast — a
      delete/re-add silently breaks the reference where an edit would not, and
      the failure is a dangling pointer rather than an error. Grep for readers
      of `transactions.id` and of `import_batches.id` before treating this as
      still-closed.
      Deliberately not built now: an edit path needs its own validation surface
      (the same D12 before-anchor refusal, the same card-only guard, the same
      `owedDollarsToSignedCents` sign discipline), and duplicating those into a
      second write path is exactly the drift `assertAssignableCategory` and
      `applyRuleWrite` were extracted to stop. Do it as a real second entry
      point sharing `manualTransaction`'s guards, or not at all. Blocked by:
      nothing. (`src/lib/accounts/manualTransaction.ts`,
      `src/app/accounts/_charge-dialog.tsx`, `src/app/transactions/_row-menu.tsx`)

- [x] **P3 — SUPERSEDED 2026-09-09 by the `/pr-review-toolkit` pass. The
      diagnosis below is WRONG and the fix it prescribes does not work.**
      It blames an INFERRED return type. Verified with a scratch `tsc --strict`:
      the cause is OPTIONALITY, not inference. `warning?: string` makes omitting
      the field legal on a DECLARED union exactly as much as on an inferred one,
      so declaring the type — the fix below — changes nothing. The inventory is
      also wrong: `/goals` and `/subscriptions` both declare theirs. The blast
      radius is ~14 unions, not 4, and the one-character fix is
      `warning: string | undefined`. See the P2 entry in the
      `/pr-review-toolkit` section at the end of this file. Kept rather than
      deleted because "we thought it was inference" is the useful part.

- [x] **P2 — SUPERSEDED same day (2026-09-09) by v0.27.0's `action-status.tsx`
      consolidation, verified against the current code during the 2026-09-15
      `/plan-eng-review` triage.** `src/app/accounts/_status.tsx` (named below)
      no longer exists — it was replaced by the shared
      `src/components/ledger/action-status.tsx`, whose own docblock names
      `_charge-dialog.tsx` explicitly and states the split this entry called a
      problem is the DESIGNED exception: "`_charge-dialog.tsx` does not render
      it [`<ActionStatus>`] at all: it CLOSES on success, so it imports
      `statusRole`/`warningOf` and sends the warning to a toast." That is
      exactly the second of the two ways out this entry proposed — export the
      message/role primitives so the dialog cannot re-derive them differently
      — already taken. The dialog's own markup still exists (it needs DS56's
      "Reconcile instead →" action button inline with the refusal, which
      `<ActionStatus>` does not support), but it is built from the SAME
      `statusRole`/`warningOf` functions the shared component uses internally,
      not a second derivation of the rule. Left as history rather than
      deleted, per this file's own header: this is exactly the class of entry
      the 2026-09-09 audit warns can flatter the backlog by staying open after
      the code has already moved past it.
- [x] **P2 — SUPERSEDED, historical text below.** `src/app/accounts/_status.tsx` was
      extracted on this branch precisely because `_balance-forms.tsx` and
      `_card-terms-form.tsx` carried byte-identical private copies, and its
      docblock argues the rules at length: `role="alert"` for a refusal AND for
      a warning, `role="status"` only for a plain success; one element rather
      than two, because two live regions announcing one click race each other.
      `_charge-dialog.tsx` reuses `statusTone`/`statusRole` but spells its own
      markup, because it also has to decide whether to CLOSE — a refresh
      warning keeps the dialog open (the row behind it is stale, which is what
      the warning says) while a clean success dismisses it.
      That coupling is real, so this is not a mechanical de-duplication: the
      dialog needs the close decision and the shared component does not know
      about it. But the current split means the one surface with the MOST
      reason to get `role` right — a modal, where an unannounced message is
      invisible rather than merely quiet — is the one surface not covered by
      the component that owns the rule. Two ways out: give `Status` an optional
      `className`/`as` so the dialog can render it in place and keep the close
      decision in its own `useEffect`, or export the message-composition half
      (`message` + `warning` concatenation) so the dialog cannot re-derive it
      differently. Filed at P2 rather than P3 because the failure mode is
      silent: a divergence here does not look wrong on screen, it just stops
      being announced. Blocked by: nothing.
      (`src/app/accounts/_status.tsx`, `src/app/accounts/_charge-dialog.tsx`)

## Follow-ups from the `/ship` review of the card-repair branch (2026-09-09)

Four review cycles plus two adversarial passes (Claude + Codex). Everything
found was fixed except the four below, each deliberately left with its reason.

- [ ] **P3** — **`removeCardActivity` assumes a manual `import_batches` row owns
      exactly one transaction, and the schema does not enforce it.** It deletes
      the transaction then unconditionally deletes the batch, while
      `transactions.import_batch_id` is `ON DELETE RESTRICT`. E21 gives every
      manual operation its own single-row batch, so the invariant holds for
      anything this app writes — but a recovery path is exactly the code that
      should survive inconsistent local state, and here a legacy or hand-edited
      ledger with two manual rows sharing a batch turns the repair into a
      rollback and an opaque refusal. Not a corruption risk (the transaction
      aborts; nothing partial lands), which is why it is P3 rather than P2.
      Fix: scope the batch delete to "no rows remain on it", or count first.
      Found by Codex adversarial. (`src/lib/accounts/manualTransaction.ts`)

- [ ] **P3** — **No EDIT path for a hand-entered card charge.** Delete +
      re-add covers correction, and that is the whole reason it was acceptable
      to ship without one. What to re-check before relying on that: the round
      trip changes the transaction id and mints a NEW `import_batches` row
      (E21). Nothing references a manual row's id today — `grep` for
      `transactionId` consumers before that stops being true.

- [ ] **P3** — **"Add a charge" disappears silently on a card anchored today.**
      `chargeableDateExists` (`_account-row.tsx`) hides the affordance when no
      legal charge date exists, which is the pattern rule 8 established
      (`assignableKinds`: offer only what the server will accept). The trade
      is real but one-sided: the user gets no explanation, and on a feed-linked
      card there is no Reconcile to fall back to either, so the honest answer
      is "wait until the feed's balance-date is no longer today". Worth a line
      of copy on the row rather than an absence. Found by Claude adversarial,
      classified INVESTIGATE.

- [x] **P4 — DONE** — **The single-toast idiom is hand-copied in three client
      files.** `_transaction-row.tsx`, `_merchant-row.tsx` and
      `_retarget-form.tsx` each carried the same `notes` array → `notify` →
      one-toast block and the matching undo idiom beside it. Now
      `notifyWrite` / `notifyUndo` in `src/components/ledger/write-toast.ts`,
      the toast twin of `action-status.tsx`. `/subscriptions` is deliberately
      NOT a fourth caller: it has no Undo, so its plain-success toast takes
      Sonner's default duration rather than the 10s Undo window, and folding
      that in would have made the shared helper carry a conditional about a
      window it does not have. `onUndo` is required for the same reason.

## Follow-ups from the `/pr-review-toolkit` pass on PR #52 (2026-09-09)

Five reviewers (comments, tests, silent-failure, types, code) over the v0.27.0
branch. The five critical findings were fixed in-branch; these seven were
deferred deliberately, each with the reason.

- [x] **P2 → CLOSED (2026-09-15), in v1.2.2.** `warning?: string` changed to
      `warning: string | undefined` on all ~14 result unions, following
      `GoalsActionState`'s v0.27.0 precedent — one real omission surfaced and
      got fixed (`updateLiabilityBalanceAction`'s "is unchanged" early return).
      (`src/app/*/action-state.ts`, `src/app/*/actions.ts`)

- [x] **P2 → CLOSED (2026-09-15), in v1.2.2.** `describeRuleRefusal` is no
      longer exported — every real caller sits after a committed write, so a
      fourth caller skipping the guard is now a compile error rather than a
      convention it could quietly bypass. (`src/lib/categorize/refusalNotice.ts`)

- [x] **P2 → CLOSED (2026-09-14), as PR2's T7.** `resolveCardAffordances({type,
      startingBalanceDate, simplefinAccountId}, balanceAction, today) →
      {canAddCharge, canEditTerms, showReconcile}` now lives in
      `src/lib/accounts/resolveCardAffordances.ts`, beside `resolveBalanceAction`
      and `resolveUtilizationDisplay`. `_account-row.tsx` calls it once and
      relays its three fields into `CardControls`, replacing the three
      separately-computed inline expressions this entry was about. The same
      module also carries D4.1's `pairingWarnsOnCategorized` and D5.2's
      `isSyntheticCardPaymentMirror`/`isAppCreatedCardPaymentPair` — built once
      for all four, per this entry's own note — with a test file
      (`resolveCardAffordances.test.ts`) covering each. `unmarkCardPayment`'s
      inline `isSynthetic` check was refactored to call the shared predicate
      rather than keep its own copy, closing the exact write/read drift risk
      D5.2 (below) names.

- [x] **P2 → CLOSED (2026-09-15), in v1.2.2.** `readPositiveIntField`'s full
      rejection table (absent field, `"0"`, `"-1"`, `"0x10"`, `"1e3"`, unsafe
      integer, whitespace) is now pinned in `actions.wiring.test.ts` for
      `markAsCardPaymentAction`, `unmarkCardPaymentAction` and
      `linkCardPaymentAction`, and mirrored for `refreshLiabilityBalanceAction`
      in a follow-up commit the same day. (`src/app/accounts/actions.ts`)

- [x] **P2 → CLOSED (2026-09-15), in v1.2.2.** `refreshLiabilityBalanceAction`
      gained 18 action-level tests covering every branch of the v0.27.0
      restructure, including the "two warning channels in one message" case.
      (`src/app/accounts/actions.balance-refresh.test.ts`)

- [ ] **P3** — **`/accounts`' `toMessage` renders raw driver text as a designed
      refusal.** All eight actions end in `catch (err) { return fail(toMessage(err)) }`,
      and because the catch is INSIDE the action, Next's production digest
      substitution never applies — so `SQLITE_BUSY: database is locked` reaches
      the browser in `text-redbrown`, styled identically to the hand-written
      DS61 sentences beside it. Worst on `removeCardActivityAction`, where a
      `FOREIGN KEY constraint failed` appears under a dialog that just said "This
      cannot be undone", leaving the user unable to tell whether the row is gone.
      A catch that separates "a refusal we wrote" from "an operational failure"
      fixes all eight; `SetKindDialog`'s "may or may not have been saved" is the
      house phrasing for the second. (`src/app/accounts/actions.ts`)

- [ ] **P3** — **`undoImportCategorizationAction`'s refresh failure is invisible
      AND it redirects onto the page that proves it.** The action revalidates
      `/import/success/[batchId]` precisely because Next would otherwise serve
      the stale pre-undo payload to the URL it then redirects to. When
      `guardRefresh` swallows that throw, the undo has committed, the redirect
      lands on that page, and it renders the pre-undo count with the Undo form
      still armed — with no warning anywhere, because the action is
      `Promise<void>`. Unlike `confirmImportAction`, there is no durable record
      (rule 5's `snapshot_warning` covers the import, not this). It is a plain
      `<form action>` in a server component; converting it to `useActionState` is
      the change `createAccountAction` already made in this branch.
      (`src/app/import/actions.ts`)

## Follow-ups from the card-transaction-import plan (2026-09-09)

Surfaced while implementing `docs/plans/card-transaction-import.md` (PR1: the
feed imports card transactions). Four entries — none block PR1, all recorded
per the plan's own "residuals" section.

- [ ] **P3** — **Citi's staleness label goes amber and stays amber (D-STALE).**
      After the D9.1 hand reconcile at cutover, the card is
      `balance_source='manual'` with `balance_as_of=NULL`, so
      `resolveStalenessDisplay` reads `starting_balance_date` and paints amber
      past 35 days — permanently, on an account whose computed balance is
      current precisely BECAUSE imports are maintaining it. This is D4.3's
      own objection ("a permanent warning is one people learn to skip")
      reappearing on `/accounts` instead of `/sync`. Deliberately not fixed
      in PR1: `resolveStalenessDisplay` is read by every account row, and
      changing it to special-case an importing card is the exact "shared
      classifier changed to fix a card-specific gap" trade that killed D7.2=A
      in the eng review that produced this plan. A real fix likely means
      reading the card's newest IMPORTED row's date instead of
      `balance_as_of`/`starting_balance_date` when `importsTransactions` is
      true — worth doing once there is a second importing card to generalize
      from, not for one. Blocked by: nothing; deliberately deferred.
      (`src/lib/accounts/resolveStalenessDisplay.ts`)

- [ ] **P3** — **Historical Citi attribution was cut, not deferred, and D8.1
      is the record of why.** Card charges dated on or before the anchor are
      permanently excluded from import — June through August (relative to the
      2026-09-09 cutover) never gets per-merchant Citi attribution, on
      purpose, because retroactively importing them would double-bill the
      Phase-A-filed checking payments covering those same months and rewrite
      budget history the app is otherwise careful never to touch (D8.1=A over
      D8.1=B in the eng review). If this is ever revisited, it needs a
      reconciliation step that RETARGETS the Phase-A payment rows for the
      backfilled months onto `transfer_pair_id`-linked pairs against the
      newly-imported historical charges, not a raw historical import — the
      double-count is the whole reason B lost. Blocked by: no plan exists for
      the reconciliation step; this is a placeholder for the decision, not a
      sized task. (`src/lib/simplefin/sync.ts`)

- [ ] **P3** — **The automatic card-payment matcher was deferred to a manual
      entry point (D8.2), which shipped 2026-09-14 as PR2 (T9:
      `linkCardPayment` / `linkCardPaymentAction`, a picker on the
      `/transactions` row menu calling the ALREADY-EXISTING
      `linkTransferPairManually`).** Measured offsets between a Citi payment's
      card leg and its checking leg were 1, 3, 1 and 1 days — zero of four
      would auto-pair on `matchTransfers`' `(date, |amount|)` bucket key. A
      fuzzy ±N-day matcher was designed (D4.2/D6.2) and then explicitly
      superseded (D8.2=A, Codex's outside-voice pass) once
      `linkTransferPairManually` was shown to already accept cross-date
      cross-account pairs — the missing piece was an entry point, not an
      engine, which is exactly what PR2 built. If Citi's payment volume ever
      grows past "a few clicks a month", or a second card is linked, revisit
      whether the manual entry point still scales; the fuzzy matcher's
      rejected design is recorded in the eng-review transcript this plan was
      built from, not here, so it is not silently rediscovered as new work.
      This entry now tracks ONLY that follow-on scaling question — PR2 itself
      is done, T7/T9/D4.1/D5.2 all landed together.
      (`src/lib/simplefin/matchTransfers.ts`, `src/lib/simplefin/sync.ts`)

- [ ] **P3** — **`refreshLiabilityBalances`' credit-card sign-guard arm
      (rule 9) is now unreachable from both its callers.** `partitionLinkedAccounts`
      routes every LINKED account into either `importAccounts`
      (`importsTransactions` true) or `balanceOnlyAccounts` (false), and for a
      linked account `importsTransactions` is false only for a loan — so no
      card ever reaches `refreshLiabilityBalances` any more, and the "a card
      genuinely can carry a positive credit balance, write it and say so"
      branch cannot fire through `syncSimpleFin` or
      `refreshLiabilityBalancesOnly`. Kept rather than deleted: the function
      takes an arbitrary account list and a future caller (or a widened
      `balanceOnlyAccounts`) could reintroduce a card, at which point deleting
      the guard would leave a positive card balance from the feed UNGUARDED —
      rule 9's whole failure mode (net worth wrong by twice the number, no
      error, a plausible-looking figure). Five lines of dead-in-practice
      defense is cheap; five lines of missing defense is not. If a future
      change makes the arm reachable again, delete this entry rather than
      re-adding a comment. Blocked by: nothing; this is a note, not a task.
      (`src/lib/simplefin/sync.ts`)

- [x] **P2 — TIME-SENSITIVE. Snapshot the mortgage's origination principal
      before the first payment posts, or the data point is lost forever.**
      Correction to the card-transaction-import plan's original D1, recorded
      2026-09-09 (see `docs/plans/card-transaction-import.md`). The mortgage
      currently sits at exactly its origination balance
      (`starting_balance_cents = -40890000`, unmoved since account creation —
      `prior_starting_balance_cents` equals `starting_balance_cents`), because
      the loan was originated 1-2 weeks ago and has had no payments post.
      That is not evidence the feed can never return mortgage transactions
      (the original, wrong reading); it is a closing window. Rule 9:
      `accounts.prior_starting_balance_cents` holds exactly ONE prior anchor,
      not a series, and the sync balance pass overwrites it on every run. Once
      the first payment posts and the anchor moves, there is no transaction
      row to reconstruct the origination figure from (D3=A keeps the mortgage
      at zero rows), so this is the only moment the true starting principal
      can ever be captured for a future debt trend line. Take a one-time,
      even manual, snapshot of `(starting_balance_cents, starting_balance_date)`
      now — before the next `/sync` — and hold it somewhere durable (a note,
      a row in a scratch table, anything outside the single mutable slot).
      This does not require building the `balance_snapshots` table the P3
      entry above asks for; it only requires not losing the one number that
      table would need as its first row. Blocked by: nothing — do this before
      the next sync moves the anchor. (`src/db/schema.ts`, `src/lib/simplefin/sync.ts`)

      **Captured 2026-09-14, from the live container (`my_money_manager-app-1`,
      volume `my_money_manager_mm_data`), account id 3, "Fixed Rate 1st
      Mortgage (#173)":** `starting_balance_cents = -40890000`,
      `prior_starting_balance_cents = -40890000` — both still the origination
      figure, confirming no payment has posted yet. The window was already
      closing faster than the note above assumed: `starting_balance_date` had
      already moved to `2026-09-13` and `balance_as_of` to
      `2026-09-13T21:47:58Z` (Unix `1789343278`) — a sync ran and re-stamped
      the DATE against an unchanged balance, which this TODO's "unmoved since
      account creation" no longer describes precisely. The AMOUNT is what
      matters for a future debt trend line and it is still exact. **This
      note is now that durable snapshot; do not delete it when closing this
      item.**

## Follow-ups from the /ship pre-landing + adversarial review (2026-09-09, card-transaction-import PR1)

- [x] **P3 → CLOSED (`sync-dedup-race-fixes` branch).** **An anchor moving BACKWARD mid-sync-fetch can permanently strand a
      row (Codex adversarial finding).** The staging loop's `cutoverAnchor`
      is read from the PRE-fetch account row, and `recheckCutoverAnchor`
      (rule 11) re-verifies it inside the write transaction — but that
      re-check only ever NARROWS which staged rows survive; it cannot ADD a
      row the staging loop already excluded. If a hand `revertLiabilityBalanceAction`
      ("Undo") fires DURING a sync's fetch window and moves a card's anchor
      EARLIER (not later), a row between the new, earlier anchor and the old
      one was never staged in the first place — it fell out at the
      pre-fetch check, before the race-check ever runs. The NEXT sync's own
      `resolveStartDate` window may then start AFTER that row's date (it
      advances from `MAX(date)` of already-imported rows), so the row is
      never even requested from the feed again — silently missing,
      permanently, with no warning either run. Requires the same two-tab
      timing rule 11's other guards already accept as a real, narrow
      window — an Undo click landing inside one sync's fetch, on one card.
      **Fixed exactly the way this entry predicted was necessary**: the
      staging loop no longer applies the cutover filter at all — every
      non-pending row is staged and dedup'd normally regardless of the
      account's anchor, and `recheckCutoverAnchor` (unchanged in its own
      logic — it already re-read the anchor fresh) is now the sole place the
      cutover is decided, fed the full candidate set instead of a
      pre-filtered one. Verified this doesn't reintroduce the "routine drop
      warns every run" noise the widening risked (a real regression a
      red-team pass caught mid-branch, fixed same session: `recheckCutoverAnchor`
      now only warns when the freshly-read anchor differs from the one
      staging observed, not merely because a row was dropped). A regression
      test proves the exact stranding scenario this entry describes no
      longer happens (`sync.test.ts`, "imports a row the STALE pre-fetch
      anchor would have excluded... rule 11" in the D8.1 cutover describe
      block) — confirmed to fail against the pre-fix code and pass with it.
      (`src/lib/simplefin/sync.ts`, `src/lib/simplefin/sync.test.ts`)

- [ ] **P4 — a single sync response with 32,766+ new rows for one card would
      abort the whole write transaction on SQLite's bind-parameter limit
      (Codex adversarial finding).** Both `checkCardCompleteness` and the
      in-transaction id-race re-check build one `inArray(...)` SQL `IN`
      clause per account per run, sized to that account's row count for the
      window. SQLite's `SQLITE_MAX_VARIABLE_NUMBER` (commonly ~32,766) would
      reject a query that large; the whole transaction would roll back, not
      just that account. Measured as a real limit, but not a realistic one
      for this app: SimpleFIN caps history at 90 days (this app fetches at
      most 45), the ledger has exactly one importing card today, and its
      measured volume is ~1.7 transactions a MONTH. Reaching the limit needs
      four orders of magnitude more card volume than anything measured.
      Chunking both queries below the bind limit is the fix if this ever
      stops being true (a second high-volume card, say). Not done now —
      solving a problem four orders of magnitude away from the real data
      would be exactly the kind of unrequested robustness this repo's own
      reuse-ladder discipline argues against. (`src/lib/simplefin/sync.ts`)

- [x] **P2 → CLOSED (2026-09-16). The Reconcile form can now represent a
      POSITIVE credit-card balance.** (Codex structured review.) Was:
      pre-existing, not newly introduced by D9.2 — an unlinked card with a
      genuine credit balance (rule 9: "a card genuinely can carry a credit
      balance after an overpayment... `summarizeBalances` treats that as
      real") already had only Reconcile as its control, and
      `updateLiabilityBalanceAction` refused a negative `balanceOwed` input
      then unconditionally negated whatever WAS typed — there was never a
      way to submit a positive stored value through this form, even though
      the feed's own `refreshLiabilityBalances` sign guard could already
      WRITE one (rule 9). D9.2 made this reachable at the one moment D9.1
      requires a manual reconcile (T6): a card in a credit-balance state at
      first linking would have its correct sign silently discarded.
      **Fix taken: option 2 from the two named here — a two-button toggle
      ("You owe" / "You're owed") defaulting from the account's CURRENT
      balance sign, next to the existing magnitude field.** The user still
      never types a minus sign (DS64 unchanged). `owedDollarsToSignedCents`
      gained an optional `direction: "owe" | "owed" = "owe"` parameter
      (default preserves every pre-existing caller — account creation never
      offers "owed") rather than a sibling function, keeping rule 9's
      "round first, flip sign second, in ONE place" property intact.
      `updateLiabilityBalanceAction` now requires a `balanceDirection` field
      and refuses rather than guesses when it's missing or invalid — the
      same discipline rule 4's `intent` field uses, since absence must never
      be the affirmative signal for which sign a write takes.
      **A real, verified regression surfaced and was fixed in the same
      session, from a different mechanism than the bug this entry names:**
      a native HTML `<input type="radio">` pair (`checked`/`onChange`)
      LOOKED controlled but wasn't reset-safe. React 19's `form.reset()`
      after a function-action submit (documented earlier in this same file
      for the `balanceOwed`/`asOf` fields) reverts every radio to its
      ATTRIBUTE-level `defaultChecked` — baked in at first server render, so
      always "owe" for a card that started in debt — and React's reconciler
      skipped reasserting `checked` on the next render because its own
      state value hadn't changed, even though the DOM's `.checked` property
      had just been mutated out from under it by the native reset.
      Reproduced live in a browser against a scratch `pnpm db:seed-dev`
      ledger: save once as "You're owed", then Save again with nothing
      touched — the second save silently wrote a NEGATIVE balance, the
      exact sign-flip class this whole entry exists to close, one layer
      up. Fixed by not using a native radio group at all: two plain
      `type="button"` toggles driving one `<input type="hidden"
      name="balanceDirection">`, the same controlled-`value` pattern
      already proven reset-safe for the magnitude and date fields. Verified
      interactively (toggle survives repeated saves in both directions, the
      no-op guard still fires correctly for an unchanged owed-direction
      balance, Undo restores the prior anchor, and a fresh page load
      re-defaults the toggle from the account's current sign). 2196 tests
      pass (10 new), `tsc --noEmit` clean, lint clean.
      (`src/lib/import/accountAnchorFields.ts`, `src/app/accounts/actions.ts`,
      `src/app/accounts/_balance-forms.tsx`,
      `src/lib/import/accountAnchorFields.test.ts`,
      `src/app/accounts/actions.test.ts`, `src/app/accounts/actions.wiring.test.ts`,
      `src/app/accounts/actions.balance-refresh.test.ts`)
      **Three more real bugs surfaced by `/ship`'s own pre-landing + adversarial
      review, all fixed before this branch ever merged.** (1) The toggle had no
      guard against a LOAN: `updateLiabilityBalanceAction` checked only
      `accountClass(...) !== "liability"`, true for both a card and a loan, so
      "You're owed" could be hand-set on a mortgage — the exact state
      `refreshLiabilityBalances` (`sync.ts`) already refuses for a feed-reported
      balance, for the same rule-9 reason. Fixed by adding the missing
      `isLongTermLiability` check server-side, and by threading a new
      `allowsPositiveBalance` boolean through `resolveCardAffordances` (T7's
      existing per-row-gate unification, not a fourth hand-derived boolean) so
      the toggle isn't rendered at all for a loan — rule 8's "don't offer a
      control that can only ever refuse." (2) Re-clicking the ALREADY-selected
      direction called `setTouched(true)` unconditionally, permanently
      disabling the sibling resync-on-external-balance-change effect for the
      rest of the form's mount — reproduced live (open Reconcile, click the
      active toggle, add a charge via "Add a charge" while the form stays
      open: the amount field stayed frozen at the pre-charge figure instead of
      picking up the new balance). Fixed by only touching state on an actual
      direction change. (3) The amount field's `aria-label` had "owed
      by"/"owed to" backwards relative to what the toggle means, confirmed by
      Codex structured review as `[P2]`. A related, doubly-confirmed a11y gap
      (a missing/invalid `balanceDirection` refusal shared `field: "balance"`
      with the amount input, so the wrong control lit up) also closed: the
      refusal now carries its own `"direction"` field value.
      (`src/lib/accounts/resolveCardAffordances.ts`, `src/app/accounts/_account-row.tsx`)

- [x] **P1 — DONE (2026-09-15), CORRECTED same day by `/ship`'s own
      adversarial review before this branch ever merged.** The design
      decision named below was made (refuse-to-stage, matching D8.3's own
      posture, over warn-and-acknowledge — no new UI surface, reuses the
      existing per-account `/sync` warning channel every other
      withheld-account case already renders through). The FIRST version of
      this fix scoped `hasPreExistingManualCardHistory` to manual rows dated
      strictly after the account's anchor, and its remedy text offered
      Reconcile as an alternative to deleting the row. Both were wrong, and
      Codex's adversarial pass reproduced why against production functions:
      Star One's `posted` date is a SETTLEMENT date, routinely a day or more
      after a hand-typed purchase date, so reconciling the anchor to "the day
      after the manual entry's date" does not stop the bank's own duplicate
      from posting even LATER — after the new anchor, past both the D8.1
      cutover and content dedup (different memo) — landing a real,
      warning-free double-count. The same review found the anchor read was
      also rule 11's exact "read before await, used after" shape: taken
      before `await fetchAccounts(...)` and never re-verified, so an Undo
      landing mid-fetch could move the TRUE anchor while the stale one still
      gated the check.
      **The fix for both: the guard is not anchor-relative at all.**
      `hasPreExistingManualCardHistory(accountId, db)` now checks for ANY
      manual row on the account, full stop — the only remedy that actually
      closes the hole is removing the row (`removeCardActivity`), which is
      also now the ONLY remedy the warning names. Dropping the anchor
      comparison closes the race too: there is no anchor value left to read,
      so nothing can go stale across the fetch. `finaliseBalances` also no
      longer receives a real `reportedBalanceCents`/`availableBalanceCents`/
      `balanceDate` for a blocked card (a Claude adversarial finding in the
      same pass) — left in place, they would have manufactured a non-null
      `driftCents` for an account this run deliberately left unverified,
      matching the exact fabricated-signal class rule 1 already names for
      every OTHER withheld-account case in this file. 12 tests in
      `sync.test.ts`'s guard block (the anchor-relative "does NOT block
      ON/BEFORE the anchor" case is now INVERTED — it blocks there too — plus
      new regression tests reproducing both Codex findings directly: manual
      history on/before the anchor still blocks, and reconciling forward does
      NOT lift the block) and 6 in the new module's own unit test (anchor
      dropped from every case), 2108 total pass, `tsc --noEmit` clean.
      (`src/lib/simplefin/sync.ts`,
      `src/lib/accounts/hasPreExistingManualCardHistory.ts`)
- [x] **P1 — HISTORICAL TEXT BELOW, kept per this file's own practice of not
      deleting a closed entry's reasoning.** a card's PRE-EXISTING manual history (before it was ever linked
      to SimpleFIN) is not reconciled or guarded at the moment it starts
      importing, and would double-count silently if any exists (found
      independently by three adversarial review passes: a Claude subagent,
      Codex exec, and Codex's structured review — cross-model agreement,
      user decision 2026-09-09: document and ship, not fix now).** D8.3
      refuses a NEW hand-entered charge or payment mirror once
      `importsTransactions(card)` is true — but it has nothing to say about
      rows that were written BEFORE the card was ever linked. Concretely: a
      user hand-enters an $80 "Costco" charge on an unlinked card (fully
      legal), later links that card to SimpleFIN, then syncs without first
      reconciling the anchor past that charge's date (D9.1's manual step,
      T6, documents doing this but nothing enforces it). The bank's real
      $80 "COSTCO WHSE #..." row for the same event arrives on the next
      sync; content dedup cannot collapse it against the hand-typed row
      (different memo, likely a different date too) — the exact
      double-count D8.3 exists to prevent, reached from the opposite
      direction. Reproduced independently against an in-memory DB by two
      separate review passes.
      **Does NOT affect this ship**: Citi's actual live `import_source='manual'`
      row count is 0 (verified via the SimpleFIN probe this whole plan was
      built from), so the account this PR is actually for cannot hit this.
      The risk is entirely in a FUTURE card link (or Citi, if manual entries
      are made before the real link+sync happens).
      **The fix is a real design decision, not a patch**: at minimum, before
      staging a card's transactions for the very first time, check for
      existing `import_source='manual'` rows dated after the account's
      current anchor; if any exist, either refuse to stage (matching D8.3's
      own "make it unrepresentable" posture) or warn loudly and require an
      explicit acknowledgment before the first import proceeds. Either
      needs its own UX pass — what the refusal/warning says, whether it
      blocks the WHOLE sync or just that account, how a user actually
      clears the condition (delete the old manual rows? reconcile past
      them?). Do this as PR2 or PR3 scope, reviewed with the same rigor as
      D8.1's own cutover design, not bolted onto PR1 under ship pressure.
      Blocked by: nothing technical — this is a design-then-build item.
      (`src/lib/simplefin/sync.ts`, `src/lib/accounts/manualTransaction.ts`,
      `docs/plans/card-transaction-import.md`)

## Follow-ups from the `/pr-review-toolkit:review-pr` pass (2026-09-09, card-transaction-import PR1, second pass)

A fresh 4-agent review of the shipped PR1 diff, independently corroborated by hand-tracing the code. Four real issues fixed same-day; one residual recorded here rather than fixed.

- [x] **P1 — D8.4's "card completeness" check was structurally incapable of ever reporting a real gap.** Traced every path that can add an id to `expectedCardExternalIds`: an id only enters the set when it is already stored under this feed's tag, about to be written by this run's own insert (and not subsequently pruned — every pruning path removes its ids from the set too), or landed by a concurrent writer the raced-id check found already stored. All three are provably in the database by the time the check runs, so under correct code it could never find a gap — while the one genuine silent-loss mode (a false content-dedup match) is, by the check's own design, excluded from the expected set entirely. Fixed by correcting the docstring to state this precisely rather than claiming the check substitutes for `classifyBalanceFreshness`'s blind spot on every loss mode: it is a regression guard on the insert pipeline (it WILL catch a future change that silently drops a row the run intended to write), not a monitor for a bad content match. That gap is recorded as its own residual below, matching rule 3's already-accepted precedent for the equivalent risk elsewhere in this file. (`src/lib/simplefin/sync.ts`)
- [x] **P1 — the post-commit D8.4 check ran unguarded; a throw there turned a fully committed import into a reported failure.** `checkCardCompleteness`'s DB read (an `inArray(...)` the same TODOS entry above already flags as capable of hitting SQLite's bind-parameter limit under enough volume) ran with no try/catch after the write transaction had already committed, at all three call sites. A throw there propagated out of `syncSimpleFin`, was caught by `syncNowAction`, and reported `fail(...)` — "sync failed" — for hundreds of already-landed rows, exactly the failure class CLAUDE.md's sync doctrine says was "got wrong twice" for `revalidatePath`. Fixed: `safeCheckCardCompleteness` wraps the check in the same best-effort try/catch idiom as the `unlinkSync` cleanup a few lines above it — logs and degrades to no warning rather than letting the write's own success get reported as a failure. (`src/lib/simplefin/sync.ts`)
- [x] **P2 — the `NothingVerifiedError` rollback path could double-warn the same dropped rows under the wrong cause.** It called `recheckCutoverAnchor` over the raw, unfiltered pre-transaction `staged` array rather than a link-verified subset, so a card that was both unlinked mid-run AND had rows spanning the cutover boundary got the correct "was unlinked" warning plus a second, misleading "landed on or before its balance date" warning for the identical rows — wrong cause, and (per the next fix) no remedy either. Fixed: the rollback path now filters `staged` down to accounts the link check did not already drop before calling `recheckCutoverAnchor`. The comment that had asserted "`NothingVerifiedError` means every staged account's rows were already dropped by the LINK check above, by construction" was itself wrong — a cutover-only or raced-id-only drop across every staged account reaches the same branch — and is corrected in place. (`src/lib/simplefin/sync.ts`)
- [x] **P2 — the cutover-race warning named no account and offered no remedy, while the obvious manual fix is refused elsewhere.** `recheckCutoverAnchor` emitted one aggregate count across every staged account ("N transactions landed on or before an account's balance..."), unlike every sibling warning in this file. Worse, the remedy a user would guess — re-type the dropped charge — is exactly what D8.3's `createCardActivity` guard refuses on an importing card, so the warning pointed nowhere. Fixed: `recheckCutoverAnchor` now returns one warning PER account, naming it and pointing at the actual remedy ("Undo" on `/accounts`, i.e. `revertLiabilityBalanceAction`, then sync again). (`src/lib/simplefin/sync.ts`)
- [x] **P3 — `isAfterAnchor` took two same-typed, order-sensitive positional strings, the exact failure class it exists to end.** Its own docstring already names a prior incident where the comparison drifted (`<=` to `<`) undetected by `tsc` or a test; a same-typed positional pair (`date`, `anchor`) hands a future call site the identical failure one level up — a transposed call type-checks and silently inverts the answer. Converted to a `{ date, anchor }` named-parameter object at all four call sites (`sync.ts` ×2, `manualTransaction.ts`, `_account-row.tsx`); a new test pins non-symmetry under transposition. (`src/lib/accounts/isAfterAnchor.ts` and callers)
- [x] **P3 — `ChargeDialog`'s `endsFeedRefresh` prop and its amber consequence box were dead code.** `canAddCharge` (`_account-row.tsx`) requires `!importsTransactions(account)`; for a non-long-term (card) account that is only ever true when the card is UNLINKED, and `resolveBalanceAction` always returns `"reconcile"` for an unlinked account regardless of row count. So whenever `ChargeDialog` can mount, `showReconcile` is provably always `true`, making `endsFeedRefresh={!showReconcile}` provably always `false` — the box describing "this charge ends the feed refresh" could never render again, a dead branch a future reader had to re-derive rather than one that stated its own unreachability. Removed the prop, its box, and the pass-through in `_card-controls.tsx`. (`src/app/accounts/_charge-dialog.tsx`, `src/app/accounts/_card-controls.tsx`)
- [x] **P3 — no test exercised a CARD going through a mid-sync relink alongside the D8.4 completeness check.** The `dropped.has(entry.account.id)` guard in `checkCardCompleteness`, meant to suppress a spurious completeness warning for a link-dropped account, had only checking/savings fixtures exercising the surrounding relink-race tests — the exact composition the P2 double-warning bug above lived in was untested. Added a card variant asserting both the correct link warning AND the absence of a spurious D8.4 warning for the same dropped rows. (`src/lib/simplefin/sync.test.ts`)

- [ ] **P3 — accepted residual, restated precisely rather than left for a reader to re-derive by tracing the code: D8.4 cannot detect a false content-dedup match on a card.** If a card's feed row is wrongly matched against a differently-provenanced existing row by date/amount/memo (rule 3's content-signature dedup) when it is actually a distinct real charge, the row is silently dropped and nothing — not `classifyBalanceFreshness`, not D8.4 — can see it, by the same construction that makes D8.4's expected-set check exhaustive over every OTHER drop path. This is not a new risk: rule 3 already accepts the equivalent gap for content dedup generally, for the same "the content budget is a multiset count and building a monitor for it is a different and larger change" reasoning. Not fixed here for the same reason CSV content-dedup collisions aren't specially monitored elsewhere in this app — building detection for an already-accepted-elsewhere residual would be inconsistent with how the rest of the codebase treats this exact class of risk. (`src/lib/simplefin/sync.ts`)

## Follow-ups from the `/ship` pre-landing + adversarial review (2026-09-14, card-payment-linking-pr2)

Six specialists, a red-team pass, and both a Claude adversarial subagent and Codex (adversarial + structured review) each independently reviewed T9's `linkCardPayment`/candidate-picker addition. Fixed same-session, across three rounds: a dead-end row menu once "Not a card payment" was gated; a missing aria-label and sub-44px touch target on the new picker `<select>`; no wiring-test coverage for `linkCardPaymentAction`; an overloaded refusal reason; a source-leg account-class/sign guard on `linkCardPayment` (mirroring `markAsCardPayment`'s existing one, plus the matching UI-side gate so the menu never offers a control that would always refuse); `loadCardPaymentCandidates` excluding `import_source = 'manual'` and pending rows (found independently by BOTH Codex and the Claude adversarial subagent — a manual candidate could otherwise be linked with no UI undo on either side); and a server-side re-check of the target row's `import_source` inside `linkCardPayment` itself, matching D8.3's "never trust the picker alone" precedent (Codex structured review). Two were deliberately deferred:

- [ ] **P4 — hand-rolled `seedAccount`/`seedRow` test helpers duplicated across `linkCardPayment.test.ts` and `loadCardPaymentCandidates.test.ts` rather than a shared fixture.** Real DRY observation (maintainability specialist), but not novel to this diff — every other `lib/accounts/*.test.ts` file (`manualTransaction.test.ts`, `listAccounts.test.ts`) already hand-rolls its own copy, the same pattern CLAUDE.md's `lib/simplefin/test/syncFixtures` entry documents happening 13+ times before that module was extracted. Worth doing once, for all of `lib/accounts/`, not as a one-off inside this branch. Blocked by: nothing — a `src/lib/accounts/test/` fixtures module, parameterized the same way `syncFixtures.ts` is, whenever someone next touches three or more of these files in one sitting. (`src/lib/accounts/*.test.ts`)
- [ ] **P3 — `loadCardPaymentCandidates` has no date bound, so a very old unpaired candidate could produce a T9 link outside `/sync`'s 240-day "linked pairs" review window, with no UI path back. Upgraded from P4: independently confirmed by BOTH the red-team pass and Codex's adversarial challenge.** At this account's measured real volume (~1.7 card transactions/month) an unpaired candidate old enough to matter is unlikely, and the row menu's own "No actions for this pair" state is honest about there being nothing to click — the gap is discoverability of the *existing* `/sync` undo, not a missing capability or a money-safety bug. If a second importing card or a much older backlog ever makes this bite, either bound the picker to the same window `REVIEW_WINDOW_DAYS` names (`src/app/sync/page.tsx`) or note in that constant's docstring that T9 pairs share it. (`src/lib/accounts/loadCardPaymentCandidates.ts`, `src/app/sync/page.tsx`)
- [ ] **P4 — `linkCardPayment` reads (source row, source account, card leg, card account) OUTSIDE the transaction that performs the write, deviating from this codebase's own "read, guard, write in ONE transaction" doctrine (rule 11).** Claude adversarial finding, marked INVESTIGATE rather than FIXABLE: not exploitable today — the function is fully synchronous, better-sqlite3 is synchronous, and there is no `await` anywhere in the call chain, so nothing can interleave between the pre-checks and `linkTransferPairManually`'s own separate transaction (the same reasoning `markAsCardPayment` and friends already rely on for their own bare-select-then-transaction shape). Worth folding into one `db.transaction()` before, not after, `docs/plans/dockerize-postgres.md`'s staged SQLite→Postgres migration lands — a genuinely async driver would reopen exactly the TOCTOU window rule 11 exists to close, on a function this diff added knowing that plan was already on the roadmap. Blocked by: nothing urgent; revisit alongside that migration, or sooner if `linkTransferPairManually` itself ever needs to accept an existing transaction handle. (`src/lib/accounts/linkCardPayment.ts`)
- [ ] **P4 — a post-commit balance-read failure in `linkCardPayment` (and its three siblings) reports a durable, committed write as a full ERROR rather than a warning.** Codex structured-review finding: `linkCardPayment.ts` calls `loadAccountBalances(db)` AFTER `linkTransferPairManually` commits, with no try/catch of its own; if that read throws, the exception propagates out to `linkCardPaymentAction`'s catch block and reports `{status:"error"}` for a pairing that already landed. **Not novel to this diff** — `createCardActivity`, `markAsCardPayment` and `removeCardActivity` all call the equivalent `currentBalanceCents` helper the same way, unguarded, after their own transactions commit, and their callers in `actions.ts` wrap the whole body in one `try`/`catch` exactly as `linkCardPaymentAction` does. Fixing only the new function would leave three existing ones with the identical latent gap while looking resolved. This is CLAUDE.md's own "Automated sync" doctrine (a committed write must never be reported as a failure) applied one layer deeper than `guardRefresh` reaches — that machinery only guards the Next.js *revalidation* step, not a plain DB read after commit. Realistic trigger is narrow (DB corruption, disk full — the kind of failure that would also break the write itself), which is why this was deferred rather than fixed under ship pressure for one function only. Blocked by: a decision on whether to harden all four post-commit reads uniformly (e.g. a shared `readBalanceAfterCommit` helper that degrades to a warning rather than an error) — a real design pass, not a one-line patch. (`src/lib/accounts/linkCardPayment.ts`, `src/lib/accounts/manualTransaction.ts`, `src/app/accounts/actions.ts`)

## Follow-ups from the `/ship` pre-landing + adversarial review (2026-09-15, transactions-remember-client-disable, round 2)

A second adversarial round (Claude subagent + Codex, both adversarial and structured, cross-model) over the branch after round 1's three fixes (self-exclusion, stale-consent-on-revalidation, the `describeRuleAction`/"Remove conflicting rule" repair path). Four real findings, three fixed same-session: consent surviving a `train`↔`remove-conflicting` transition (both surfaces — `handlePick` now clears `remember` whenever the ACTION KIND changes, not only when it becomes `"none"`); `MerchantRow` missing the revalidation-based consent reset `TransactionRowForm` already had (added the same `prevGroup !== group` pattern); the Save button on `/transactions` refusing to submit a pure rule-removal with no category change (a lossy key removes its rule unconditionally, so "Remove conflicting rule" can be the only pending action — the button's guard now has an escape hatch for `remember && ruleActionEnabled`); and two message-accuracy fixes (a lossy-key removal blamed on "this pick contradicts" when the coincidental case has no contradiction at all — the real reason is the key's own shape — and a docstring overclaiming `pendingCategoryId === null` "always" returns `"none"` when a vacuously-trainable verdict returns `"train"` first). One was deliberately NOT fixed:

- [ ] **P3 — a stale tab's "Remove conflicting rule" can delete or retrain a DIFFERENT rule than the one it displayed, if another tab writes to the same merchant in between (Codex adversarial, second pass).** `describeRuleAction` computes its verdict from the props React last gave this component; `applyRuleWrite` independently re-reads `existing` fresh inside its own write transaction (rule 11 doctrine, correctly applied) and acts on THAT — so if a second tab retargets the merchant's evidence or rule between this tab's last render and its submit, the two can disagree. Reproduced two ways: the stale tab's "remove Groceries" submit can silently RETRAIN the rule to whatever the other tab most recently set instead of deleting anything (if the fresh state happens to be trainable), or it can DELETE a rule the OTHER tab just created for a DIFFERENT category than the one the stale tab displayed. Both are real, but bounded by three things at once: (1) this is a single-user, local, unauthenticated app — the only way to trigger it is the SAME person running the SAME merchant through TWO OPEN TABS within the narrow window before either one's next revalidation-driven prop refresh (round 1 and round 2 between them close that window to "since the last prop refresh," not "since page load," for both surfaces); (2) the server's own write is always internally consistent with the FRESH state it reads — nothing is corrupted, only the client's displayed explanation can be stale; (3) every rule write in this app already snapshots into `priorRule` and is undoable via the existing 10-second toast (`restorePriorRule`), so even the worst case — the wrong rule silently deleted — has a durable, already-shipped recovery path the user already knows how to reach. A complete fix needs the same shape this codebase already uses elsewhere for exactly this class of problem (rule 4's `intent` field, rule 11's re-verify-inside-the-transaction doctrine): the form would need to submit an explicit expected operation AND the existing rule's identity, and `applyRuleWrite` would need to REFUSE (not silently do something else) when either no longer matches fresh state — which means a new refusal category distinct from `TrainabilityRefusal`'s `"lossy-key"|"multi-category"` (that type is `classifyKeyTrainability`'s own output and this staleness check is orthogonal to it), a non-transaction-aborting way to report it (the category UPDATE must still commit even when the rule action is refused — rule 6's "refusal withholds the RULE ONLY" applies here too), and both callers updated to pass and check it. That is a real design pass, not a one-line patch, and disproportionate to bolt on under ship pressure for a risk this narrow and this recoverable. Blocked by: a decision on whether optimistic-concurrency guarding is worth adding to the Remember-guard's write path at all, given the existing Undo already closes the durable-harm case. (`src/lib/categorize/applyRuleWrite.ts`, `src/lib/categorize/keyTrainability.ts`, `src/app/categorize/_merchant-row.tsx`, `src/app/transactions/_transaction-row.tsx`)

## Follow-ups from the `/pr-review-toolkit:review-pr` pass on PR #58 (2026-09-15)

Four specialists (code-reviewer, pr-test-analyzer, comment-analyzer, type-design-analyzer) against the pushed PR, run after both `/ship` adversarial rounds above had already landed. Real, verified findings fixed same-session: a checkbox LABEL bug where a lossy-key removal (which the `message` right below it carefully avoids blaming on "this pick") still read "Remove conflicting rule" from the `kind` discriminant alone — `RuleAction` gained a `reason: "lossy-key" | "contradicted"` field and a shared `ruleActionLabel()` so the label agrees with its own explanation; `RuleAction` also gained `message` on every non-`"train"` branch, deleting a hand-duplicated 5-line ternary from both row components; `describeRuleAction` didn't filter a non-real `pendingCategoryId` the way `classifyKeyTrainability` already does, so a corrupted parked pick (`NaN`, from `_pending-pick.ts`) rendered an enabled "Remove conflicting rule" with no real pick behind it; the Save-button escape hatch (round 2's own fix) could submit a category id the picker can no longer render as selected — a row filed under a category later archived keeps that id as `pickerValue`, `leafCategories` excludes archived by default, and the escape hatch didn't check the pick was still choosable before allowing submission; `resolveKeyTrainability.test.ts`'s own "conservative, never permissive" test had a DEAD `if` block (the line above it already asserted the condition the `if` was guarding, so the body never ran — mutation-tested: dropping the entire `count === 1` self-exclusion filter left every test green); `loadTransactions.test.ts`'s self-exclusion tests never exercised the `count >= 2` branch either — added a dedicated test plus an unconditional (non-dead) invariant check; and several stale round-1→round-2 doc references (a docstring naming `loadFiledCategoryIdsByMerchant` as a direct caller of `filedCategoryEvidenceWhere` when it only reaches the predicate through `loadFiledCategoryCountsByMerchant`; a test describe-block asserting "the two cannot drift" when round 2 deliberately made `/transactions`' self-excluding figure diverge from `/categorize`'s group figure by design; `_retarget-form.tsx`'s docstring claiming parity with "the row form on this same page" that round 2 made false; CLAUDE.md's own "shared by three readers" overcount of the same predicate).

Deferred, all recorded rather than fixed under continued review pressure:

- [x] **P2 → CLOSED (2026-09-16). `_retarget-form.tsx`'s "Remember" checkbox is
      now the same guard as the other two surfaces, not a silent third copy.**
      `page.tsx` now loads `loadFiledCategoryIds(db, merchant)` (the
      `filedCategoryEvidenceWhere`-based read, archived categories and
      transfer-paired rows already excluded) and
      `loadExactRulesByMerchant(db, [merchant])` for the retarget merchant,
      and passes both down as new `filedCategoryIds`/`existingRule` props —
      deliberately NOT derived from the existing `filed` prop, which comes
      from `summarizeByCategory` and does not skip an archived category, the
      exact over-strictness this entry originally flagged as a reason NOT to
      reuse it. `RetargetForm` derives its verdict from `filedCategoryIds`
      with the FROM category's id dropped (every one of that category's
      non-transfer rows for this merchant is the moved set — verified
      against `bulkRetarget`'s own `matchingRows` query, which selects
      exactly `(merchant, categoryId = fromCategoryId, transferPairId IS
      NULL)` — so dropping the id is mathematically identical to passing the
      whole moved set as `excludeTxnIds`, without needing the row ids
      client-side) and `toId` as `pendingCategoryId`, through the same
      `resolveRememberUi`/`useRememberConsent` pair `TransactionRowForm`
      already uses. The checkbox now disables and relabels
      ("Remove unusable rule" / "Remove conflicting rule") exactly like its
      sibling below it. No escape-hatch was needed here (unlike the row
      form's Save button): `canSubmit` already requires an actual move to a
      different category, so there is no same-category "removal-only"
      submission to unblock.
      **`/ship`'s coverage audit (2026-09-16) flagged the one genuinely new
      line of logic — dropping the FROM category's id out of
      `filedCategoryIds` — as verified only by hand against `bulkRetarget`'s
      query, with no automated pin.** Extracted into
      `filedCategoryIdsAfterMove` (`keyTrainability.ts`) and proved against
      the real DB-backed exclusion in a new
      `"filedCategoryIdsAfterMove — parity with resolveKeyTrainability's
      excludeTxnIds"` block in `resolveKeyTrainability.test.ts` (both the
      still-split-after-the-move and made-unanimous-by-the-move cases,
      asserting the client verdict computed from the filtered category list
      equals `resolveKeyTrainability`'s own DB-backed
      `excludeTxnIds`-computed verdict) plus 4 pure unit tests in
      `keyTrainability.test.ts`.
      **`/ship`'s pre-landing review (Codex outside design voice) also found
      two real bugs in the render, both fixed:** the "Ticking Remember
      retrains the merchant's rule" sentence used to render unconditionally,
      contradicting the checkbox's own label when the actual action was
      "Remove conflicting rule"/"Remove unusable rule" — now shown only when
      `rememberUi.action.kind === "train"`; and the reason `<p id={reasonId}>`
      only rendered outside the `chosenIsGone` branch while the checkbox's
      `aria-describedby` pointed at `reasonId` independent of `chosenIsGone`,
      so a stale-source-category state could leave a dangling ARIA
      reference — the reason paragraph now renders unconditionally whenever
      `rememberUi.message` is defined.
      **The maintainability specialist also caught the new checkbox render
      becoming a THIRD verbatim-structure copy of the exact same block in
      `_merchant-row.tsx` and `_transaction-row.tsx` — the render half of a
      consolidation `resolveRememberUi`/`useRememberConsent` already did for
      the logic half.** Extracted a shared `RememberCheckbox` component
      (`src/components/ledger/remember-checkbox.tsx`, taking `{rememberUi,
      checked, onChange, reasonId, minTouchTarget?}`) and updated all three
      call sites. The reason `<p>` stays un-extracted on purpose — its layout
      genuinely differs per caller (a flex-wrap sibling needing `basis-full`
      on two surfaces, a plain block on the third), which is real per-context
      difference, not drift. Verified interactively in a browser on both
      `/categorize` and `/transactions?merchant=…` (checkbox ticks, disables,
      and relabels identically to before the extraction; no console errors).
      2186 tests pass (2179 + 7 new), `tsc --noEmit` clean, lint clean.
      (`src/app/transactions/_retarget-form.tsx`,
      `src/app/transactions/page.tsx`,
      `src/app/categorize/_merchant-row.tsx`,
      `src/app/transactions/_transaction-row.tsx`,
      `src/components/ledger/remember-checkbox.tsx`,
      `src/lib/categorize/keyTrainability.ts`,
      `src/lib/categorize/keyTrainability.test.ts`,
      `src/lib/categorize/resolveKeyTrainability.test.ts`)

- [x] **P2 → CLOSED (2026-09-15).** **The per-component decision logic (`pendingCategoryId`, `trainability`, `ruleAction`, `ruleActionEnabled`, the `handlePick` consent-reset lookahead, the `<p id={reasonId}>` reason block) was hand-duplicated across `_merchant-row.tsx` and `_transaction-row.tsx`.** Both proposed shapes landed, with one refinement to (b): `resolveRememberUi(normalizedMerchant, filedCategoryIds, existingRule, pendingCategoryId) → {action, enabled, message, label}` (`keyTrainability.ts`) folds `classifyKeyTrainability` + `describeRuleAction` + the enabled/message/label derivation into one call, so `describeRuleAction` can no longer be handed a verdict computed from a different key than its own argument. For (b), a plain `consentedKind === action.kind` mask (as this entry originally specced) turned out to be insufficient and was verified so BEFORE shipping: `kind` alone cannot tell `remove-conflicting` (pointing at Gas) apart from `remove-conflicting` (pointing at Dining) after a sibling row's write repoints the existing rule with the pick never moving — exactly the bug the four hand-written clearing call sites existed to prevent. `ruleActionSignature(action)` folds `message` in for that reason (`"train"` stays a bare, uncomposed signature, since it has no target to name), and a new mutation-tested regression case in `keyTrainability.test.ts` proves a kind-only signature fails it (confirmed by hand, then reverted). Both render sites now store a `consentedSignature: string | null` and mask `checked` against it, which is what let ALL FOUR clearing call sites (two `handlePick`s, two `prevRow`/`prevGroup` prop-reset blocks) — and, in `_merchant-row.tsx`, the entire `prevGroup` tracking state, which existed for no other purpose — be deleted rather than merely consolidated. 2171 tests pass (was 2163), `tsc --noEmit` clean, lint clean. (`src/lib/categorize/keyTrainability.ts`, `src/app/categorize/_merchant-row.tsx`, `src/app/transactions/_transaction-row.tsx`, `src/lib/categorize/keyTrainability.test.ts`)

- [ ] **P3 — `describeRuleAction` and `applyRuleWrite`'s `shouldDelete` are two independent derivations of one decision, held together by a comment and a hand-mirrored test rather than a shared spelling (type-design-analyzer, code-reviewer, pr-test-analyzer all flagged this independently).** `filedCategoryEvidenceWhere` is this codebase's own precedent for the fix: extract a pure `shouldRemoveExistingRule(reason, existingCategoryId, pendingCategoryId): boolean` into `keyTrainability.ts` (zero-import already, `applyRuleWrite.ts` already imports from that module's sibling `resolveKeyTrainability.ts`), have `applyRuleWrite`'s `shouldDelete` become `allowRuleRemoval === true && existing !== undefined && shouldRemoveExistingRule(verdict.reason, existing.categoryId, categoryId)`, and have `describeRuleAction` call the identical function. The practical failure mode without it: `shouldDelete` changes, `applyRuleWrite.test.ts` goes red, someone fixes THAT test, and the client mirror silently diverges with everything else green — pr-test-analyzer's finding 4 notes this is a real gap in what's tested today: there is no test that runs an actual `categorizeTransaction`/`bulkCategorize` call end-to-end and asserts its DB outcome (rule deleted or not) matches what `describeRuleAction` predicted for the identical inputs; the existing coverage hand-writes both sides. Blocked by: nothing urgent — a same-session fix once someone is touching either function again for an unrelated reason. (`src/lib/categorize/keyTrainability.ts`, `src/lib/categorize/applyRuleWrite.ts`, `src/lib/categorize/keyTrainability.test.ts`)

- [ ] **P3 — an already-categorized row whose merchant key is lossy or spans 2+ categories now shows its "Remove conflicting rule" reason line AT REST, with no interaction required, un-dimming the row's D17 "already filed" contrast (code-reviewer, finding 4).** `trainability`/`ruleAction` are computed from the row's OWN initial `pickerValue` (its current stored category), so a merchant like `ONLINE` (39 real rows, all lossy-key) showing several already-categorized rows on one page under `?merchant=ONLINE` would render the identical reason sentence N times, at full contrast, before the user has touched anything — a different visual claim than D17's dimming was designed to make ("filed and unremarkable" vs "filed and here's a repair available"). Not incorrect — arguably more informative — but a design judgment call this pass didn't have the room to make well (de-duplicate per merchant within a page? only surface the reason after the row is focused/changed? keep dimming and drop the exemption?), so it wasn't changed. Blocked by: a design pass, not a mechanical fix. (`src/app/transactions/_transaction-row.tsx`)

- [ ] **P4 — three small test-coverage gaps noted by pr-test-analyzer, none blocking.** (1) `describeRuleAction`'s `pendingCategoryId === null` branch returning `"train"` (a vacuously-trainable verdict with no pick yet) has no direct test — the existing null-pick test uses a lossy key, which exercises the OTHER branch of the same guard. (2) The `filedCategoryIds`/self-exclusion tests all seed every row on one page (`pageSize: 50`); the field's own docstring claims evidence is counted "elsewhere on the page or off it," and that second half is unexercised — a `pageSize: 1` probe with the filed sibling row pushed off-page would close it. (3) `loadExactRulesByMerchant` doesn't filter archived categories (correctly — it mirrors `readExactRule`, which `applyRuleWrite` also reads unfiltered, so client and server still agree), but nothing pins that this is intentional and matches `readExactRule`'s own behavior, unlike `filedCategoryEvidenceWhere`'s evidence predicate, which DOES filter archived — a future "make these consistent" cleanup could silently break the parity without a test noticing. (`src/lib/categorize/keyTrainability.test.ts`, `src/lib/categorize/loadTransactions.test.ts`, `src/lib/rules.test.ts`)

## Follow-ups from the second `/pr-review-toolkit:review-pr` pass on PR #58 (2026-09-15, verification re-run)

Same four specialists, re-dispatched against the fix commit (`2055282`) plus the TODOS-only doc commit, specifically to verify the round above's claimed fixes and catch anything the fix commit itself introduced. All 9 claimed fixes (5 code-reviewer, 4 comment-analyzer) were independently CONFIRMED correct by fresh reads and — where the claim was testable — by mutation testing, not by trusting the commit message. Four more real, verified issues turned up and were fixed in this same session rather than deferred:

- **`ruleActionLabel()` was untested and non-exhaustive** (type-design-analyzer + pr-test-analyzer, independently, both via mutation: collapsing the whole function body to a single hardcoded return left all 2138 tests green). Fixed two ways: the two-level `switch` now ends every branch in a `const unreachable: never = …` guard, matching the six existing sites in this codebase that use the same idiom (`accountClass.ts`, `isCreditCard.ts`, `isLongTermLiability.ts`, `importsTransactions.ts`, `manualTransaction.ts`, `batchLabel.ts`) — a future 4th `RuleAction.kind` or 3rd `reason` now fails `tsc` instead of silently rendering "Remember"; and a new `describe("ruleActionLabel", …)` block pins all three label outcomes plus the exact coincidental-match case ("lossy-key" reads "Remove unusable rule", never "conflicting") that motivated extracting the function in the first place.
- **The `filedCategoryIds` self-exclusion filter over-excluded for a transfer-paired categorized row** (pr-test-analyzer, reproduced empirically with a scratch probe): a paired row never contributes to `loadFiledCategoryCountsByMerchant`'s counts (`filedCategoryEvidenceWhere` excludes it), so when a *different*, genuinely sole contributor supplied a category, the paired row's own `count === 1` test still fired on the wrong row's data and excised evidence it never owned — a client verdict strictly more permissive than the server's, the exact class of bug this whole PR exists to close. The field's docstring had argued this was inert because `TransferRowItem` renders paired rows with no Remember checkbox at all — true today, but a prose-defended property in a `.tsx` file (rule 11's own warning) rather than a structural one, and unpinnable by any test since UI-component tests are out of V1. Fixed structurally instead: the filter now also requires `row.transferPairId === null`, with a dedicated regression test (mutation-confirmed: reverting the guard alone fails it) that seeds a paired row and a separate non-paired sole contributor under the same category and asserts the paired row still sees the sibling's evidence.
- **CLAUDE.md and `keyTrainability.ts`'s own module docstring both still described `RuleAction`'s pre-fix single-label shape and `/categorize`-only client-graph framing** (comment-analyzer, findings I1–I3) — both corrected to name `reason`/`ruleActionLabel()` and both routes.
- **`loadMerchantGroups.ts`'s `filedCategoryIds` field docstring carried the exact "these two figures must never diverge" claim the fix commit had already corrected in two OTHER files** (comment-analyzer, finding I4) — round 2 made the `/categorize` and `/transactions` figures deliberately diverge (self-exclusion has no group-level equivalent), and this was the one remaining copy still asserting the opposite, sitting on the producer of the `/categorize` figure. Corrected to describe the predicate/projection distinction precisely, with a pointer to the parity test.

Also fixed as drive-by comment/test-name accuracy (comment-analyzer S2, S3): two `keyTrainability.test.ts` test names claiming "even with a contradicted existing rule" for inputs that make a contradiction structurally impossible (a non-real `pendingCategoryId` can't contradict anything) — renamed to "even with an existing rule pointing elsewhere"; a `_merchant-row.tsx` comment quoting `checked={remember && ruleAction.kind !== "none"}`, a literal that no longer appears anywhere in the file since round 2 introduced `ruleActionEnabled` — requoted to match the actual render site.

Deferred, all Suggestion-tier and explicitly assessed as low-risk by the reviewing specialist:

- [ ] **P4 — `loadFiledCategoryCountsByMerchant` and `loadExactRulesByMerchant` have no test exercising the empty-string merchant key.** (pr-test-analyzer, finding 3.) Rule 6 is explicit that `""` is a real stored key with no `.min(1)` guard anywhere, and a blank Memo cell genuinely normalizes to it — so a `/transactions` page can legitimately put `""` into both new batched `inArray` lists. The reviewer's own assessment: "almost certainly fine," one seeded row in each describe block would pin it. (`src/lib/categorize/resolveKeyTrainability.test.ts`, `src/lib/rules.test.ts`)
- [ ] **P4 — no test exercises a full `MAX_PAGE_SIZE` (500-row) page binding 500 parameters into the two new batched `inArray` queries.** (pr-test-analyzer, finding 4.) better-sqlite3's SQLite build caps bound variables at 32766, so this is safe today by a wide margin — nothing records that the bound was considered, and both the page-size constant and the driver are things that move over the project's lifetime. Informational; no test proposed as urgent.

## Follow-ups from the `/ship` pre-landing review (2026-09-16, RememberCheckbox extraction)

- [ ] **P4 — Neither `_transaction-row.tsx`'s nor `_retarget-form.tsx`'s "Remember" checkbox meets DS66's 44px touch floor; only `/categorize`'s does.** Red-team review, verified directly: `_merchant-row.tsx` gives its checkbox's wrapping `<label>` a `min-h-11` no other call site has — `_transaction-row.tsx`'s checkbox sits in a plain `flex flex-col` next to a 20px `applyToPast` checkbox, and `_retarget-form.tsx`'s sits among only h-8 (32px) controls (the `<details>` summary above it has its own `py-2.5 -my-2.5` DS66 fix, which does not extend to this row). Pre-existing on `/transactions`' row form; newly true of `_retarget-form.tsx` since it did not have a Remember checkbox before this pass. Not fixed here — the shared `RememberCheckbox` component (`src/components/ledger/remember-checkbox.tsx`) now takes a `minTouchTarget` prop for exactly this, so closing the gap on the other two surfaces is a one-line change per call site whenever someone picks it up; deliberately not bundled into a "third checkbox copy" consolidation PR under ship pressure. (`src/app/transactions/_transaction-row.tsx`, `src/app/transactions/_retarget-form.tsx`, `src/components/ledger/remember-checkbox.tsx`)

## Follow-ups from the `/ship` adversarial review (2026-09-16, RememberCheckbox extraction)

Claude adversarial subagent, Codex adversarial challenge, and Codex structured review (`codex review --base main`) all ran clean — no actionable production regressions, no P1/P2/P3 findings. The client-side Remember verdict in `RetargetForm` was confirmed provably non-authoritative: `bulkRetarget` → `applyRuleWrite` independently re-queries the real moved-row set and re-derives the train/remove-conflicting decision transactionally, so a wrong client guess can mis-render the checkbox but cannot mis-file or wrongly delete a rule. Two low-severity INVESTIGATE findings recorded rather than fixed under review pressure:

- [ ] **P4 — When the previously-picked source category has vanished (`chosenIsGone`) AND the remaining filed-category evidence still yields a Remember-guard message, `RetargetForm` shows BOTH the "category you picked no longer has rows…" banner and the Remember-guard reason sentence in the same render.** Claude adversarial finding: the two `<p>` blocks are siblings, not mutually exclusive — the accessibility fix (rendering the reason `<p>` unconditionally, closing the dangling `aria-describedby`) removed the `chosenIsGone` guard that used to suppress it, but didn't account for the two messages now being able to co-render. Not reachable as a money-safety issue: `canSubmit` requires `effective !== undefined`, so the Move button stays disabled in this state regardless of what the checkbox shows. Pure display-quality overlap — narrow (needs both `chosenIsGone` AND a multi-category/lossy verdict on the *remaining* filed evidence at once). (`src/app/transactions/_retarget-form.tsx`)
- [x] **P4 → CLOSED (2026-09-17, `docs/plans/cache-components-migration.md`, Stage 3c).** Activity-based route preservation (cache-components-migration) widened this beyond the searchParam-only case this entry originally scoped: leaving `/transactions` for a DIFFERENT route entirely and coming back now also preserves the instance, not just a merchant-only search-param change. `<RetargetForm key={merchant}>` closes both paths in the same fix rather than leaving this deferred a second time. (`src/app/transactions/_retarget-form.tsx`, `src/app/transactions/page.tsx`)

## Follow-ups from the `/ship` pre-landing + adversarial review (2026-09-17, categorize-month-scope)

Design review (Codex outside voice), five specialists (testing, maintainability, security, performance, simplification) and a Red Team pass all ran against the month-scoped `/categorize` branch. Fixed same-session: `_categorize-ui.tsx`'s `count`/`done` state going stale across a `ScopeNav` navigation (the component stays mounted across a scope change, so a `useState` initializer never re-runs — now reset on a `scopeKey` change, mirroring the file's existing `renderedGroups` pattern); a 4th `monthLabel` duplicate the original extraction missed (`src/app/page.tsx`); three near-identical month-date-predicate implementations (`loadUncategorizedBacklog.ts`, `loadMerchantGroups.ts`, `bulkCategorize.ts`) consolidated into `src/lib/transactions/monthDatePredicates.ts`; `bulkCategorize`'s missing defense-in-depth against a caller constructing a partial `{scopeYear}`-only input by hand (bypassing the schema's `.refine()`) — now throws, with tests at both the pure-function and Server Action layers; `scopeYear`'s missing bound (asymmetric with its sibling `scopeMonth` and with the read-side `scopeParams.ts` schema) — now shares `SCOPE_YEAR_MIN`/`MAX` constants with three callers; `ScopeNav`'s unbounded prev/next arrows, which could generate a URL past `scopeParams.ts`'s own year bound and silently jump to all-time data with no explanation (Red Team) — now withheld at the boundary rather than offered; and a stale `loadUncategorizedBacklog` docstring claiming `/categorize` stays unscoped, which this branch made false. One Red Team finding deferred:

- [ ] **P3 — `/categorize`'s `<AllCaughtUp>` empty state reads identically for "every merchant in this scope is filed" and "this scoped month has zero transactions at all" (e.g. a future month, or one before the ledger's earliest row).** Red Team finding: `initialGroups.length === 0` renders "All caught up. No uncategorized transactions left." in both cases, but the second case never had any uncategorized work to begin with — the message affirmatively claims completed work where there was none, the same class of conflated fact rule 6/8's doctrine elsewhere keeps distinct ("a no-op is never reported as a completed action"). Only reachable by navigating `ScopeNav`'s prev/next arrows to a month with zero transactions of ANY kind, which the app's own real ledger data makes narrow (`/sync`'s ~45-day feed window plus CSV history bounds the populated range). The honest fix needs a second fact `loadMerchantGroups`/the page doesn't currently compute — whether ANY transaction (not just uncategorized ones) falls in the scoped month — and two different empty-state messages, which is a design pass rather than a mechanical one. Blocked by: nothing urgent. (`src/app/categorize/_categorize-ui.tsx`)
- [ ] **P4 — `ScopeNav`'s prev/this-month/next/all-time links don't meet DS66's 44px touch floor.** Codex design review: inherited verbatim from `/budget`'s own `MonthNav`, which this component deliberately mirrors rather than inventing a second pattern — so this is not a new gap this branch introduces, it's an existing one this branch's new surface also carries. Same class already tracked above for the Remember checkbox on `/transactions` and `_retarget-form.tsx`; worth a single pass over every bare-link nav control in the app (`MonthNav`, `ScopeNav`) rather than fixing one copy and leaving its sibling. (`src/app/categorize/_scope-nav.tsx`, `src/app/budget/[year]/[month]/page.tsx`)

## Follow-ups from the `/ship` adversarial review (2026-09-17, categorize-month-scope, cross-model)

A Claude adversarial subagent and Codex (adversarial challenge, then structured review, re-run twice more after fixes) independently converged on the same real bug class, then Codex's own re-run found a follow-up gap in the first fix. All three rounds fixed same-session:

- **Round 1 (Claude subagent + Codex adversarial, independently).** `CategorizeUi` staying mounted across a `ScopeNav` navigation — the fix for the stale-counter bug earlier in this same TODOS section — opened a second, subtler gap: `MerchantRow`'s submit/undo is an in-flight `startTransition` promise, and if the user navigates to a different scope before it resolves, the callback (`onOptimisticSubmit`/`onUndo`/`onDismissedChange`) still fires once it does, against whatever scope is CURRENTLY mounted rather than the scope it was issued under. Worst case (Claude adversarial): a merchant recurring in both scopes gets marked `done` in the NEWLY-viewed month from a submit that actually happened in the OLD one, hiding a row with real uncategorized backlog with no error — reachable via ordinary use (submit, then click a `ScopeNav` arrow before the write settles), not a crafted input. Fixed: each callback now carries the scope key it was issued under (`MerchantRow` computes it fresh every render, so the closure captures the render-time value); `CategorizeUi` compares it against a `useRef`-held current scope key (updated via `useEffect`, never mutated during render — the direct-mutation version failed `react-hooks/refs`) and no-ops the callback on a mismatch. Codex separately found a companion gap in the same review round: `prunePendingPicks`' "not in the list = finished business" invariant only holds all-time — a scoped `initialGroups` is a subset, so pruning against it deletes a still-relevant parked pick for any merchant with backlog outside the viewed month. Fixed by skipping the prune entirely when `scope` is set, rather than reworking what it decides.
- **Round 2 (Codex structured review, first re-run).** The Round 1 guard used strict scope-key equality, which is wrong in the other direction: two different scope keys are not necessarily disjoint — "all-time" contains every month. Categorize two September rows, switch to all-time, click the still-visible toast's Undo: the DB write is correct, but the strict-equality guard discarded the counter update entirely, permanently undercounting the all-time header relative to its own row list (no revalidation path corrected it, since the reset was gated on `scopeKey` changing, which it hadn't). Fixed: a `scopeKeysCanOverlap(a, b)` helper (`a === b || a === "all-time" || b === "all-time"`) replaces the strict check — only two DIFFERENT specific months are provably disjoint (a transaction cannot be dated in both), so only that case skips.
- **Round 3 (Codex structured review, second re-run).** Applying the update in the genuinely-overlapping case (Round 2's fix) still used the WRONG magnitude: restoring 25 all-time rows while viewing September added the full 25 to September's counter, not the 2 that were actually September's. Root cause, once traced: `count`'s resync was gated on `scopeKey` changing, so a fresh, authoritative `initialBacklog` arriving from the SAME server action's own `revalidatePath` (for the currently-viewed, unchanged scope) was being silently discarded — the exact number that would have corrected the optimistic guess never got the chance to. Fixed: `count` now resyncs to `initialBacklog.count` whenever the `initialBacklog` object reference changes (an `renderedBacklog`-tracked adjust-state-during-render, mirroring the file's existing `renderedGroups`/`hidden` pattern), independent of whether `scopeKey` also changed — the optimistic delta still gives instant feedback, but the next authoritative payload (arriving moments later either way) now always wins.
- **Verification.** A fourth Codex structured-review pass, run to confirm Round 3's fix, hung for 47+ minutes (well past its own 9-minute timeout — `gtimeout 540` did not terminate it) with no output ever written; killed and recorded as missing coverage per this project's own timeout doctrine ("a timed-out pass is missing coverage, not a clean bill"), not treated as a clean pass. The two PRIOR structured-review passes (Rounds 2 and 3) both completed normally and both found real, since-fixed issues — that is the adversarial coverage this branch actually has. tsc/lint clean, 2231/2231 tests pass throughout (this fix touches only `_categorize-ui.tsx`/`_merchant-row.tsx`, both UI components excluded from this project's automated test coverage per CLAUDE.md — verified instead via live browser: normal same-scope submit and Undo both confirmed still correct after each round's fix). (`src/app/categorize/_categorize-ui.tsx`, `src/app/categorize/_merchant-row.tsx`, `src/app/categorize/_pending-pick.ts`)

## Follow-ups from the `/ship` pre-landing + adversarial review (2026-09-17, docker-snapshot-retention)

Five specialists (testing, maintainability, security, performance, simplification) plus a Red Team pass ran against the fix for "the container spends a snapshot retention slot on every restart" (closed above). Security/performance/simplification: NO FINDINGS. Fixed same-session from testing + maintainability: a duplicated `"/app/drizzle"` literal (extracted to `MIGRATIONS_FOLDER`); a redundant `dbExists &&` term in `tookPreMigrateSnapshot` (removed — the variable itself was later deleted in favor of using `migrationsPending` directly at both call sites); missing test coverage for a db-file-with-no-`__drizzle_migrations`-table, a table that exists with zero rows, and a corrupt db file (three new tests); `hasPendingMigrations()`'s call site had no try/catch, unlike every other guard in this file, so a corrupt/locked `money.db` would have thrown unhandled instead of failing with a readable message (now wrapped, matching the file's existing idiom); and the degraded-snapshot boot-refusal itself had zero test coverage since `main()` isn't unit-testable (`process.exit`, dynamic import of `/app/server.js`) — extracted into `checkPreMigrateSnapshot(snapshot) → {ok, message}`, the same `{ok, message}` shape `checkTz`/`checkCwd` already use, and unit tested directly on a plain object literal rather than needing to reproduce rule 5's documented reader-pinned-VACUUM race for real.

Then a cross-model adversarial round (Claude subagent + Codex adversarial challenge, independently; then Codex structured review) found a genuinely serious issue neither the specialists nor Red Team caught, plus three smaller ones, all fixed same-session:

- **[Found by BOTH Claude and Codex independently] The degraded-snapshot hard-refusal can poison the very retention pool this whole fix exists to protect.** `createSnapshot`'s `copyFileSync` fallback WRITES the degraded snapshot file to disk before ever reporting `consistent: false` back to the caller, and `pruneSnapshots` is never reached when `checkPreMigrateSnapshot` refuses the boot (the refusal exits first). Under `restart: unless-stopped`, that refusal RETRIES the identical failure on every restart, and each retry leaves ANOTHER degraded file in the same `PRE_MIGRATE_PREFIX` pool real historical snapshots share — `pruneSnapshots` has no way to tell a degraded file from a good one (it only sees filenames and mtimes). Once more than 10 restarts accumulate junk, the eventual successful migration's prune call keeps only the 10 most recent files, which by then are all crash-loop garbage, silently deleting every real rollback point — the exact failure class ("a restart-happy container evicts real snapshots") this whole PR was written to close, reintroduced through a different door. Fixed: `quarantineDegradedSnapshot(snapshotPath)` renames the file out of the `PRE_MIGRATE_PREFIX` prefix match (not deleted — rule 5 says even a degraded copy beats no snapshot at all) before `fail()` runs, so it can never compete for a retention slot.
- **[Claude adversarial] The `readMigrationFiles` accuracy fix (splitting "image build problem" from "database problem" error messages) was gated inside `if (dbExists)`, so it never ran on the FIRST-EVER boot** — the most likely moment to discover a broken image build (no `drizzle/` folder bundled, or a migration `.sql` referenced by the journal missing). On that path the identical error still surfaced, but through `runMigrations`'s own internal `migrate()` call, mislabeled as "Migration failed — refusing to boot on a half-applied schema" — precisely the confusion this diagnostic was written to eliminate, just on a code path the guard didn't cover. Fixed: moved the `readMigrationFiles` pre-check outside the `dbExists` guard so it runs unconditionally.
- **[Codex adversarial] The refusal message suggested `pnpm db:export` as a recovery step, which runs `docker compose exec` against a RUNNING container — the one thing that does not exist at the exact moment this message fires** (the container just refused to boot). Fixed: points at `pnpm db:import` instead, which starts from a stopped container by design.
- **[Codex adversarial] The same message inlined `sudo chmod 777 ./backups` as the permissions remedy — CLAUDE.md's own already-documented, CI-validated fix for this exact EACCES hazard, but now duplicated in a second location that could drift from it.** Fixed: references CLAUDE.md's Docker section by name instead of repeating the command.
- **[Codex structured review, P3] Once quarantining moved the file, the failure message still cited the OLD (now-nonexistent) snapshot path** — an operator inspecting the preserved copy for manual recovery would get a filename from the logs that no longer exists. Fixed: the message now names the quarantined path when the rename succeeds.

One INVESTIGATE finding recorded rather than fixed, self-assessed unreproduced by its own source:

- [ ] **P4 — Codex (unreproduced, "I did not reproduce it here"): `hasPendingMigrations()`'s new READONLY connection could fail on a database with a hot rollback journal where a WRITABLE connection would have auto-recovered.** SQLite returns `SQLITE_READONLY_ROLLBACK` when opened read-only against a file needing rollback-journal recovery, which a writable open resolves automatically. Before this branch, the boot sequence's FIRST database open was `runMigrations`'s writable connection; this branch inserts a new READONLY open ahead of it. This app sets `journal_mode = WAL` immediately on every write connection (`runMigrations`, and per CLAUDE.md the app's own runtime singleton), so a database that has ever been touched by this app's own code should never be sitting on a hot ROLLBACK journal — the precondition would need a snapshot restored via `pnpm db:import` that was itself taken via `createSnapshot`'s `copyFileSync` fallback (not `VACUUM INTO`, which always produces a clean, checkpointed file) of a source database with a genuinely in-flight, uncommitted rollback-mode transaction at the exact moment of copy — a state this app's WAL-everywhere design shouldn't produce during ordinary operation. Not fixed blind against an unverified, narrow precondition; if it ever manifests, the accurate symptom would be `hasPendingMigrations` throwing `SQLITE_READONLY_ROLLBACK` at boot, now failing loudly via the try/catch this same branch added rather than silently. (`docker/entrypoint.src.mjs`)

20 new/changed tests in `docker/entrypoint.test.mjs` (2223 → 2243), `tsc --noEmit` clean, lint clean, `pnpm build:docker-artifacts` bundles cleanly with the new `drizzle-orm/migrator` import. (`docker/entrypoint.src.mjs`, `docker/entrypoint.test.mjs`)

## Follow-ups from `/ship`'s pre-landing + adversarial review (2026-09-17, card-paydown-target)

Beyond the concurrency bugs already fixed and re-verified in `docs/plans/card-paydown-target.md` (stale-tab overwrite, Cancel-during-pending, stale `useActionState` across reopen, the presence-guard regression, and the values/snapshot canonicalization drift — four fix cycles, each independently red-teamed by at least one of a Claude subagent or Codex before being called done), the review explicitly decided NOT to change two things, and left one low-confidence residual on record rather than silently dropping it:

- **Not a bug, deliberately unchanged: two tabs genuinely editing the SAME field to different values resolves last-write-wins.** Flagged by Codex adversarial. This is standard, unavoidable last-write-wins behavior that already existed for `creditLimit`/`minimumPayment` before this branch — the snapshot-diffing fix targets a DIFFERENT problem (an untouched field getting silently reverted by an unrelated field's save), not full optimistic concurrency control for a genuinely conflicting edit. Building real OCC (checking the live DB row at write time, not just the client's own snapshot) is out of proportion for a single-user local app's recurring goal field.
- **Not a bug, deliberately unchanged: a stale tab whose untouched field happens to match what's currently displayed skips the write rather than reasserting it.** Flagged by Codex structured review (P2) as "Save no longer persists the value shown in the form" — but the click sequence that produces this (open, don't touch that field, click Save) is indistinguishable from "I have no opinion on this field," and choosing NOT to overwrite is the safer default that preserves a more recent edit from elsewhere. This is the fix working as intended, not a regression.
- [ ] **P4 — accepted residual: `paydown_target_cents` has no DB-level CHECK constraint against negative values.** The `>= 0` guarantee lives entirely in `optionalPositiveDollarsSchema`, which only runs inside `updateCardTermsAction` — a direct `pnpm db:studio` edit (a normal, documented workflow for this single-user app) could write a negative value outside that path. `_account-row.tsx`'s display already neutralizes it defensively (`paydownTargetCents > 0 ? … : null` treats negative the same as unset, same guard as the $0-goal case), so the blast radius is display-only, not a corruption risk. Confidence too low (4/10, single-user/no-auth threat model, no adversarial pass reproduced an actual trigger) to act on now; worth a CHECK constraint if this table ever gains a second writer. (`src/db/schema.ts`, `src/app/accounts/_account-row.tsx`)

## Follow-ups from `/ship`'s pre-landing review (2026-09-17, cache-components-migration)

Six specialists plus a red-team pass ran against the branch after its own staged implementation (`docs/plans/cache-components-migration.md`) was already live-browser-verified across all 4 stages. Security, performance, and API contract found nothing. Testing (1), maintainability (7, one multi-specialist-confirmed with simplification's own advisory finding), and simplification (1, merged above) found real, mechanical issues — all fixed same-session (see the plan doc and the updated Cache Components TODOS entry above for the full list). Red team then found what the file-by-file plan audit had missed: one **CRITICAL** and one adjacent real gap in the same class, both fixed; two informational findings recorded rather than fixed, for different reasons:

- **[FIXED] CRITICAL — `/sync`'s `ActionFeedbackProvider` (`_action-feedback.tsx`) had no reset-on-hide.** Its own docstring documents it was deliberately built to survive a resolved row leaving the list — the exact property that, under Activity, also makes it survive leaving `/sync` and coming back. The plan's Stage 3b verification tested "navigate away mid-pending-sync" but not "resolve something, leave, return" — a stale "Linked as reversal."/undo/unlink banner would have kept showing from a previous visit. Fixed with the same `useStatusResetOnHide` hook used elsewhere in this migration.
- **[FIXED] — `src/app/budget/[year]/[month]/_create-category.tsx`'s three inline forms (`NewCategoryRow`, `NewGroupRow`, `FirstLeafForm`) had unreset refusal-string state**, the same class already fixed for `/goals` and `/import` but missed because this file wasn't named in the plan's own route inventory. Fixed with `useStatusResetOnHide` on all three.
- **[FIXED] — `/sync`'s own `SyncButton.tsx` had the identical unreset-`useActionState` gap as the CRITICAL `_action-feedback.tsx` finding above, on a sibling component the red-team pass didn't separately name.** Self-found while live-verifying the `_action-feedback.tsx` fix: triggering "Sync now" to get an "Already up to date" (or warning) message, leaving `/sync`, and returning showed the previous run's message as if it were current, with no way to tell it apart from a fresh result. Same fix, same hook (`useStatusResetOnHide`), re-verified with the same navigate-away/navigate-back sequence plus the full test/lint/build suite.
- [ ] **P4 — accepted, dev-only: `useCloseOnHide`'s cleanup fires once, spuriously, on Strict Mode's dev-only mount double-invoke, closing a disclosure that opened via `startOpen={true}` (`ReconcileDisclosure` via `_card-controls.tsx`'s `startOpen={handoff > 0}` DS56 handoff).** Confirmed real: this repo's `next.config.ts` sets no `reactStrictMode` (defaults on for App Router per `node_modules/next/dist/build/define-env.js`), and the `startOpen` case is genuinely reachable. Production has no double-invoke and is unaffected. A "skip the first cleanup" fix was considered and rejected — the only signal available inside the effect can't tell Strict Mode's synchronous fake cleanup apart from a real one without also skipping the ONE cleanup production ever fires, which would be wrong in the build that matters. Documented in the hook's own docstring rather than patched with a fragile detection hack. Blocked by: no correct fix identified, not effort. (`src/components/ledger/use-close-on-hide.ts`, `src/app/accounts/_card-controls.tsx`)
- [ ] **P4 — accepted, unmeasured: `Spine`'s Suspense fallback could be visible sitewide for longer than "not expected to be perceptible" during a concurrent `VACUUM INTO` snapshot or migration rebuild.** Spine renders on every route via the root layout, and its query path reads through the same underlying SQLite file (WAL mode) that rule 5's snapshot writes and rule 7's migration rebuilds also open their own, separate connections against — several of them in separate node processes entirely, not the same connection object (corrected in post-merge review; the original entry here said "shares its better-sqlite3 connection," which overstated the mechanism). A reader delayed behind one of those writers would show the empty-peek fallback on every page, not just the one that triggered the write. Not reproduced live (no snapshot/backfill was run concurrently with a page load during this review). Docstring softened to record the exposure rather than assert safety without evidence. Worth a live repro (hold a `VACUUM INTO` open, load any page, time the fallback) if this is ever suspected in practice. (`src/components/ledger/spine.tsx`)

2241 tests pass (the health-route regression-guard is a new assertion inside an existing test, not a new one), `tsc --noEmit` clean, lint clean, `pnpm build` clean, plus a live browser re-verification of the Spine refactor (including `/_not-found`, pixel-identical to pre-fix).

## Follow-ups from a post-merge PR review (2026-09-17, PR #72, cache-components-migration)

Four parallel `pr-review-toolkit` agents (code-reviewer, silent-failure-hunter, pr-test-analyzer, comment-analyzer) reviewed the already-pushed, already-PR'd diff. Test coverage: no blocking issues, one non-blocking note (the `route.test.ts` `connection()` regression guard proves "called somewhere," not "called synchronously first" — not tightened, low value for the risk). Comment accuracy: one Important precision fix and one Moderate rewrite, both applied (see below); every factual claim in the new docstrings was independently verified against the actual runtime behavior (including an empirical `pnpm build` reproduction of the `dynamic`-export-incompatibility error) and held up. Code-reviewer and silent-failure-hunter INDEPENDENTLY found the same CRITICAL gap — corroboration across two agents that never saw each other's output:

- **[FIXED] CRITICAL — `/sync`'s shared `ActionForm.tsx` (the wrapper behind essentially every mutating form on the page) had the identical unreset-`useActionState` gap as the two instances already fixed in this same PR.** `_action-feedback.tsx`'s own docstring asserted "every OTHER form's `useActionState` result resets for free because leaving `/sync` used to unmount the whole tree" — true before this PR, false after it, and the false assertion is very likely why the gap survived the original red-team pass: the one component actually holding the vulnerable state was reasoned away by a claim about a *different* component. Concretely reachable on the account-link form (no `announceSuccess`, so inline copy is the ONLY place its outcome ever renders — "Account linked…" or "Account unlinked…" stays showing indefinitely across a nav-away/back), the review-queue forms (a multi-candidate reversal bucket survives a resolve with the same `bucketKey`, so a stale "Linked as reversal."/"Not a reversal recorded." sits on a byte-identical card — per rule 4, the next click on that card pairs the rows and removes real money from every spend surface), and the undo form on a refusal path. Fixed with `useStatusResetOnHide` inside `ActionForm` itself, covering every caller at once; `_action-feedback.tsx`'s docstring corrected to stop asserting the now-false blanket claim and instead name `ActionForm`'s own parallel fix.
- **[FIXED] CRITICAL — `/accounts`' `RefreshButton` and `RevertBalanceButton` (`_balance-forms.tsx`) had the identical gap, unconditionally rendered in the account row, not behind any disclosure.** Same shape as the already-fixed `SyncButton.tsx`, in a file this PR already touches. `RevertBalanceButton` is rule 9's single-undo-slot toggle — a stale "Balance put back to `<date>`." greeting the user on return sits next to a control whose second press undoes the undo. Fixed with `useStatusResetOnHide` on both; live-verified (Refresh's error message and Undo's confirmation message both correctly clear on navigate-away/navigate-back).
- **[FIXED] HIGH — `useCloseOnHide`'s forced close on route-hide bypassed the in-flight-save guard `CardTermsForm`'s own Cancel button exists to enforce (`disabled={pending}`), reopening the exact clobbering race through routing instead of a button click.** Closing (unmounting) a form mid-Save lets the next mount reseed `values`/`snapshot` from pre-write props, so a save of some OTHER field in the reopen window can repost this field's stale value and clobber the in-flight write once it lands. `ReconcileForm` has NO Cancel button at all — `useCloseOnHide` was its ONLY close path, making this the sole way it could ever unmount mid-write. Fixed: the hook now takes an optional `pending` param (read via a ref updated in a plain `useEffect`, since `react-hooks/refs` forbids reading/writing a ref during render, and the layout effect's own `useCallback`-free `[]` deps — required for synchronous hide timing — can't include it directly) and skips the forced close while a submit is in flight, leaving the disclosure open-but-hidden until it resolves. `CardTermsDisclosure` and `ReconcileDisclosure` both lift their inner form's `pending` up via a new `onPendingChange` callback prop. Live-verified: `ReconcileForm` still opens/closes normally on a non-pending hide (no regression to the ordinary case).
- **[FIXED, docs-only] `Spine`'s Suspense-fallback docstring (and its TODOS.md mirror above) overstated the WAL-contention mechanism as "shares the same better-sqlite3 connection" — corrected to "reads through the same underlying SQLite file," since rule 5's snapshots and rule 7's migrations each open their own, separate connections (several in separate node processes entirely).** The risk conclusion (an unmeasured, honestly-flagged exposure) is unchanged; only the mechanism description was imprecise enough that a future reader could mistake it for a same-JS-object lock rather than cross-connection file contention.
- **[FIXED, docs-only] `SyncButton.tsx`'s comment leaned on discovery-process narrative ("found live while verifying the red-team fix on `_action-feedback.tsx`") rather than a durable code property — the weakest candidate in this PR for surviving a rename/refactor of the file it points at.** Reworded to anchor on the code's own shape (no toggle, renders unconditionally) and a stable symbol reference (`ActionFeedbackProvider`'s own docstring) instead of the PR's review-process history, per CLAUDE.md's "references... belong in the PR description... rot as the codebase evolves."
- **[FIXED, docs-only] The two new hooks (`use-close-on-hide.ts`, `use-status-reset-on-hide.ts`) were missing from `docs/agent-notes/module-notes.md`'s `components/ledger/` inventory**, despite smaller-footprint siblings (`remember-checkbox.tsx`, `use-remember-consent.ts`) being documented there — added, including the pending-guard fix above and the list of components found needing the reset (with why each was missed on an earlier pass), so a future "did every component that needs this get it" audit has an inventory to check against instead of re-deriving it from scratch.
- **[FIXED, docs-only] Both new hook files were missing `"use client"`** (their existing sibling `use-remember-consent.ts` carries it). Worked today because every importer is already a client component; added so a future server-component import fails with a clear directive error instead of a confusing one.
- **[FIXED, docs-only] `PLAN.md`'s v0.18.0 entry still described the now-deleted `_pending-pick.ts` in the present tense**, including "see the P2 entry in TODOS.md before extending it" — that P2 is closed and the file is gone. Reworded to past tense with a pointer to this PR's plan doc instead.
- [ ] **P3 — deferred, not independently audited: three more dialog-open booleans on `_category-menu.tsx` (`activeDialog`, plus per-dialog `error` state in `SetKindDialog`/`RenameDialog`/`ArchiveDialog`) may have the same Activity-preserved-dialog-state shape as `_charge-dialog.tsx`, which this migration deliberately exempted (a persisted unsubmitted draft is what Next's own preserving-UI-state guide recommends keeping).** Unlike `_charge-dialog.tsx`, there's no comment anywhere indicating anyone looked at these three specifically and decided the same reasoning applies — reads as an audit gap rather than a considered exemption. `_category-menu.tsx`'s `wasOpen` pattern already resets `error` on a re-open transition, which may already close most of the gap; not confirmed against Activity's hide/show timing specifically.
- [ ] **P4 — deferred, low blast radius: `_row-menu.tsx`'s `confirmOpen` (the "Remove this charge" irreversible-delete confirmation, rule 8's `confirmedIrreversible` gate) has no reset-on-hide.** Results go through ephemeral toasts rather than persistent inline text, and a second explicit click is still required either way, so the practical risk is a dialog silently reopening on nav-away/back rather than a stale claim being believed — but it does match Next's own named "resetting stale status" regression pattern.

`pnpm exec tsc --noEmit` clean, `pnpm lint` clean, `pnpm test` — 2241/2241 passing, `pnpm build` clean (Cache Components enabled, all routes render). All three CRITICAL/HIGH fixes live-verified in a scratch `DATA_DIR` (never the real ledger): `RefreshButton`'s error and `RevertBalanceButton`'s confirmation both correctly clear on navigate-away/navigate-back on `/accounts`; the account-link `ActionForm`'s "Account unlinked" message correctly clears on navigate-away/navigate-back on `/sync`; `ReconcileForm` still opens and closes normally with the `pending`-gated `useCloseOnHide` change.

## Follow-ups from the `/ship` pre-landing + adversarial review (2026-09-18, sync-dedup-race-fixes)

Closes the two open P3s above (content-dedup race, anchor-backward race — see
their entries for the fix). A pre-existing adversarial review (before this
`/ship` run) found 3 more real bugs IN the fix itself — a false D8.4
completeness alarm, a double-warning on a row that was both content-raced and
genuinely pre-cutover, and stale per-account counts — all fixed via a shared
`applyDedupPruning`. `/ship`'s own pre-landing review (5 specialists + a
cross-model-equivalent red team, two fix-and-reverify cycles) then found one
CRITICAL regression the branch itself introduced (fixed same session) plus
several DRY/documentation findings (also fixed) and one accepted residual:

- [x] **P1 → FIXED same session (red-team finding, confidence 9/10, empirically reproduced).** **Widening the staging loop to fix the anchor-backward race broke `recheckCutoverAnchor`'s "routine drop = no warning" invariant** — every ordinary D8.1 cutover exclusion (not just a genuine anchor-moved-during-fetch race) started firing the "landed on or before its balance date... use Undo on /accounts... then sync again" warning, directly contradicting this file's own documented intent a few hundred lines below ("the drop is routine, so announcing it every run would be the noise D4.3 exists to remove"). Reproduced live: a newly-linked card's feed lookback routinely spans weeks of pre-anchor history before its first post-cutover activity (R1's own comment), so this would have fired the scary, actionable-sounding false alarm on every single ordinary sync in that window. **Fix:** `recheckCutoverAnchor` now compares the freshly-read anchor against `entry.account.startingBalanceDate` — the value staging itself observed, carried on the same account object — and only warns when they differ; a row is still dropped and counted either way, only the WARNING is gated on a genuine race. Two regression tests added directly to existing no-race tests (asserting `outcome.warnings` carries nothing matching "balance date"), both confirmed to fail against the pre-fix code and pass with it. A second, independent adversarial pass verified the fix has no false-negative case (if the anchor is unchanged, the dropped row set is provably identical to what the old pre-filter would have produced) and found one negligible (3/10) residual: the gate is per-ACCOUNT, not per-row-cause, so a genuinely raced account's warning could in principle fire for a row whose own eligibility didn't actually depend on the moved anchor — narrower than the bug this fixes, not acted on. (`src/lib/simplefin/sync.ts`)
- [ ] **P4 — accepted residual, not fixed: the `totalToInsert === 0` early-return no longer takes the cheap path for a routine pre-cutover-only card sync (red-team finding, confidence 8/10).** Because pre-cutover rows now always enter `toInsert` at staging (the fix above removes the early skip), a card whose feed sends only routine, pre-anchor history with nothing new past the anchor no longer takes the cheap "up-to-date" early return — it now unconditionally takes the full write path (`createSnapshot`'s real `VACUUM INTO`, opens a `db.transaction`, inserts nothing, hits `verifiedTotal === 0`, throws `NothingVerifiedError`, deletes the snapshot it just took) on every such sync. No correctness impact — `NothingVerifiedError`'s existing handling already deletes the snapshot rather than let it evict a real one from the retention pool, and no batch is minted — only unnecessary disk I/O and an open-then-rollback transaction, on a manual "Sync now" button (not a cron), for one card, during the "weeks" window R1's own comment names before a newly-linked card's first post-cutover activity. Fix direction, if this is ever worth doing: have the early-return check "would any row plausibly survive the cutover" for card accounts rather than raw `toInsert.length`, without reopening the same read-before-await staleness rule 11 exists to close. Blocked by: nothing urgent — deferred rather than fixed under `/ship` review pressure for a non-correctness, low-frequency cost. (`src/lib/simplefin/sync.ts`)

- [x] **P2 → FIXED same session (Codex adversarial finding, `/ship` Step 11).** **`verifyStagedLinksReadOnly` (the `NothingVerifiedError` rollback path's link re-check) never flushed a SURVIVING account's own `accountWarnings`** — unlike the success-path `verifyStagedLinks`, which always does (`warnings.push(...entry.accountWarnings)` once an entry passes its link check). Pre-existing on `main`, NOT introduced by this branch — but this branch's own P4 residual immediately above (a routine pre-cutover-only card sync no longer takes the cheap early return) makes the rollback path reachable more often in practice, since `NothingVerifiedError` fires whenever EVERY staged account nets zero rows, not only when every one is individually link-dropped. Concretely: a checking account with a genuinely broken connection ("the connection may need re-authorising", staged as `accountWarnings` but contributing 0 rows either way) synced alongside a card whose own sync is a routine pre-cutover no-op — the whole run nets zero rows, `NothingVerifiedError` fires, and the checking account's broken-connection warning was silently swallowed. The user sees a plain "up to date" while a real connection problem goes unreported — exactly the "warning must survive the tab" class rule 5/rule 11 already established for a different mechanism. **Fixed**: added the missing `else { warnings.push(...entry.accountWarnings); }` branch, mirroring `verifyStagedLinks` exactly. Regression test confirmed to fail against the pre-fix code and pass with it (`sync.test.ts`, "NothingVerifiedError rollback path flushes SURVIVING accounts' own warnings"). (`src/lib/simplefin/sync.ts`, `src/lib/simplefin/sync.test.ts`)

- [ ] **P2 — accepted residual, NOT fixed: a genuinely duplicate `external_id` spanning the D8.1 cutover boundary in one feed response can now cause the ELIGIBLE occurrence to be silently, permanently lost (Codex adversarial finding, `/ship` Step 11, empirically confirmed via a scratch reproduction — not merely reasoned).** This IS introduced by this branch's own widening, unlike the two entries above. Before the widening, a pre-cutover occurrence was filtered out of the staging loop BEFORE it ever reached the `seenExternalIds` within-response-duplicate check, so it could never "claim" the id ahead of a later, eligible occurrence. Now every non-pending row (regardless of cutover eligibility) flows through id-dedup uniformly, so if SimpleFIN sends the SAME external id twice in one response — a real, if rare, anomaly this codebase already has tests for elsewhere ("stays QUIET when the SAME external id appears TWICE in one feed response... a real feed sending a repeated transaction id is not something anything validates against upstream of this loop") — and one occurrence is dated on-or-before the anchor while the other is genuinely after it, the pre-anchor occurrence (processed first, in array order) wins the id slot via `seenExternalIds.add()`, and the post-anchor, eligible occurrence is dropped as `duplicateByExternalId` before it ever reaches the cutover recheck. Both occurrences are then lost: the pre-anchor one correctly (cutover), the post-anchor one incorrectly. Reproduced empirically with a scratch test (anchor `2026-08-20`, one occurrence dated `2026-08-15`, one dated `2026-09-01`, same external id): `ROWS: []` — neither lands, confirmed against BOTH occurrences of the same id producing zero inserted rows where the post-anchor one should have survived. **Why not fixed here**: a correct fix needs the staging loop to prefer the occurrence that will actually survive cutover when picking which of several same-id occurrences "wins" the slot — but the fresh anchor isn't known until inside the write transaction (the whole reason this branch exists), so a same-session fix risks exactly the kind of rushed, under-verified change this branch's own history (three prior review rounds, each finding real regressions in the previous round's fix) argues against. A heuristic using the STALE pre-fetch anchor as a tie-break (prefer an occurrence dated after it, when one exists, over blind array order) would handle the common case without reopening rule 11's read-before-await trap, but is not implemented. **Narrowness, for calibration**: requires BOTH a genuinely duplicate external id in one response (already rare/anomalous) AND that duplicate specifically straddling one card's cutover anchor (i.e., the first sync after the anchor is set) — a compound, low-frequency intersection, but the consequence (a real transaction silently, permanently lost, with no distinct warning naming this specific cause) meets this repo's own bar for what a defect must clear regardless of frequency. Blocked by: a real design pass on the within-response duplicate-id tie-break rule, not a same-session patch. (`src/lib/simplefin/sync.ts`)

- [ ] **P2 — PRE-EXISTING on `main`, unrelated to this branch, found incidentally while verifying a Codex adversarial claim (`/ship` Step 11) and confirmed empirically, not just by reasoning.** **A posted feed row racing against a genuinely PENDING existing row with a matching content signature is silently dropped by content dedup — permanently, since the pending row is never promoted to posted and the transaction stays excluded from the balance sum forever (rule 1's `SUM(... AND NOT is_pending)`).** Reproduced with NO race involved at all (pure, ordinary staging-time flow — `createSnapshotMock` untouched): a pending CSV row and a matching posted feed row, same date/amount/memo, produce `duplicateByContent: 1, insertedCount: 0`, the pending row stays `isPending: true` forever, and `driftCents: 487` (a phantom missing $4.87) is reported on every future sync. `loadContentBudget`'s candidacy query (`existingByContent`, unchanged by this branch beyond the byte-identical extraction into a shared function) has no `is_pending` filter, so a pending existing row competes for a content-dedup budget slot exactly like a posted one — but unlike CSV import's `commitImport`, which has dedicated logic to UPDATE a matched pending row in place when its posted counterpart arrives (rule 3: "A content match against an existing pending row is not just dropped... commitImport updates that row in place"), `syncSimpleFin`'s own content dedup has no equivalent promotion path — it just drops the posted row as a duplicate and leaves the pending one exactly as it was. Genuinely out of scope for this branch: this is a pre-existing gap in the ORIGINAL staging-time content-dedup design (present on `main` before this branch's changes), not something the race-condition fixes here introduced or worsened — my new `recheckContentDedup` never even runs differently for this case; the row is already gone by staging time, before the new recheck ever sees it. How often a bank-fed pending CSV row and a later-posted SimpleFIN row for the SAME transaction would actually collide in practice is unmeasured — Star One via MX is documented (CLAUDE.md) as posting-only over the feed, so this specific collision needs a CSV-imported pending row (itself an edge case — CSV import IS the pending-eligible path) to still be sitting unresolved when the SAME transaction later arrives over the feed. Recorded here rather than silently discovered later; not sized or fixed as part of this branch. (`src/lib/simplefin/sync.ts`)
