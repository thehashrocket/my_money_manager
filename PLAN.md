# Plan — my_money_manager

Local-first, single-user budgeting app. Automated transaction sync from Star One CU over SimpleFIN, plus CSV import for history older than the feed carries. No cloud copy of your data, no auth, no Plaid.

The canonical design doc lives at `~/.gstack/projects/thehashrocket-my_money_manager/jasonshultz-thehashrocket-budgeting-app-design-20260416-173405.md` (APPROVED). This file is the in-repo roadmap; it does not duplicate the design doc.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind v4 · shadcn/ui · better-sqlite3 · Drizzle ORM · Recharts · Vitest · pnpm · Node 24 · SimpleFIN for the bank feed

## Timeline

4-5 weekend sessions over 5-6 calendar weeks.

| # | Focus | Status |
|---|-------|--------|
| W1 | Scaffold + CSV import end-to-end (sign correction, transfer detection, dedup) + HMR smoke test | done |
| W2 | Budget views + hybrid categorization (auto-learn + manual rules) + integration checkpoint (use on real data for 1 week) | done (integration checkpoint pending) |
| W3 | Dashboard + Uncategorized backlog tile + merchant normalization refinement | done |
| W4 | Subscriptions tracker — **cut-line** if behind (keep goals instead) | done |
| W5 | Goals / savings + Recharts trend chart | done |
| S1 | Automated sync from Star One over SimpleFIN (`/sync`): link, pull, balance check, transfer review, undo | done (v0.8.0) |

## Current status (2026-09-05)

All five weekends shipped, plus the automated sync that follows them, plus zero-based budgeting (below). The app runs end-to-end in a real browser: transactions arrive from `/sync` (or `/import` for older history) → categorize → `/budget` zero-based month editor with inline allocate → dashboard, subscriptions, goals and the 6-month trend chart.

v0.15.0 — `/transactions` gets a real filter bar (`_filter-bar.tsx`), replacing the old `year`/`month` URL params with independent `dateFrom`/`dateTo` bounds: search (description/merchant/payee, `LIKE`-escaped), account, category, date range (with a "This month" quick-select), amount range (matches `ABS(amount_cents)`, so a min/max is sign-agnostic), and pending/posted/all status — all composable, all preserved across pagination. New `listAccounts` (`src/lib/accounts/listAccounts.ts`) supplies the account picker, mirroring the existing `listLeafCategories` shape. `loadTransactions` (`src/lib/categorize/loadTransactions.ts`) swapped its `year`+`month` window for independent `dateFrom`/`dateTo` predicates. Fixed alongside: `/budget`'s four category-drilldown links (`_month-editor.tsx`) still built `?categoryId=&year=&month=` — Zod on `/transactions` silently ignores unknown keys rather than erroring, so a stale link would have widened to "every transaction ever" for that category instead of failing loudly; a new `transactionsDrilldownHref` helper (`src/lib/budget/transactionsDrilldownHref.ts`, using a new `lastDayOfMonth` in `monthOfIso.ts`) builds the correct `dateFrom`/`dateTo` pair instead. Also fixed: an account/category filter pointing at a value outside the current picker list (an archived category, a hand-edited URL) no longer silently reverts to "All" on the next filter change, a stale `?year=&month=` link now 404s instead of silently showing all-time data, and a non-default page size no longer resets to 50 when a filter changes. See the Added/Fixed sections of [CHANGELOG.md](./CHANGELOG.md).

v0.14.0 — collapsible "How this page works" reference panel on `/budget/[year]/[month]`, per [docs/plans/budget-page-help-panel.md](./docs/plans/budget-page-help-panel.md). A single native `<details>`/`<summary>` glossary (`_help-panel.tsx`, plain server component, no client JS) explains the envelope-budgeting model and all five `LeftToBudget` states, why Funds is read-only here, and why Spent can look wrong before transactions are categorized. Reuses the same `<details>` disclosure pattern `/goals` already established rather than a client-side `Collapsible` + `localStorage` toggle (an earlier draft, dropped after review found it added a flash-of-content window and a same-tab storage-event gap for a "remember my choice" behavior nobody asked for). Hidden on a genuine first-run month so it never stacks with `FirstRunCard`'s onboarding card. See the Added section of [CHANGELOG.md](./CHANGELOG.md).

v0.13.0 — zero-based (EveryDollar-style) budgeting, per [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md): PR1 (data model + read-only surface) and PR2 (inline editing + category CRUD), all four sub-merges (PR1a/PR1b/PR2a/PR2b) landed in one branch. `categories.kind` (`income`/`expense`/`fund`) + `sort_order` + `archived_at` (migration `0017`) make `leftToBudgetCents` computable and let a `<MonthEditor>` client island replace the old redirect-per-commit Allocate dialog with inline `CurrencyInput` cells (select-on-focus, Enter commits + advances, live Left to Budget). Categories can be created inline, renamed, reordered, given a carryover policy, archived (refusing `Uncategorized`, categories with children, or a nonzero current/future allocation), and — in the one case D9A/X1 carve out — reclassified from expense to income when every transaction is positive, the repair path for a mislabeled income category. New `/budget/categories` route is the one place an archived category can be seen and undone. See the Added section of [CHANGELOG.md](./CHANGELOG.md) and [TODOS.md](./TODOS.md) for what's deliberately deferred to PR3 (fund behavior unification).

v0.12.4 — three correctness fixes to transfer-pair matching and CSV date validation. `linkTransferPairs`'s `sameDayUnpaired` candidate query (`src/lib/importBatch.ts`) now excludes pending rows (`is_pending = false`, mirroring rule 1's balance-sum filter): a still-pending row can carry Star One's shared `6098` placeholder transaction number, which was a legitimate-looking ±1 match for an unrelated posted row and could silently drop both from spending totals as a false transfer pair. `parseCsv.ts`'s `mmddyyyyToIso` now validates every transaction row's date against the same `z.iso.date()` schema the starting-balance anchor already used (v0.12.3), not just month/day range checks (1-12, 1-31) — a calendar-invalid date like `04/31` or a non-leap-year `02/29` was previously imported silently. And marking a pair "Not a transfer" (`unlinkTransferPair`) now records the rejection pair-scoped, on a new `transfer_rejected_partner_id` column (migration `0016`), instead of just clearing `transferPairId` — previously an unrelated later import landing on the same date could silently re-link the exact mismatch the user had just corrected. Both matchers (`findTransferPairs`, `matchTransfers`) take the rejection as a predicate checked before committing a candidate, so a rejected row stays eligible to pair with its real counterpart later; `linkTransferPairManually` clears the marker only when it points at the row actually being relinked. See the Fixed section of [CHANGELOG.md](./CHANGELOG.md).

v0.12.3 — three correctness fixes, the largest closing a blind spot in transfer-pair matching. `linkTransferPairs` (`src/lib/importBatch.ts`) previously re-checked only rows carrying the current import batch's own id, but a row `commitImport` flips from pending to posted in place (`toUpdate`) keeps its *original* batch's id by design — so a transfer whose pending leg only posted via a narrow re-export (no new rows at all) could never get matched to its real counterpart on another account. `linkTransferPairs` now takes explicit seed row ids covering both freshly-inserted rows and just-posted `toUpdate` rows, and `import_batches` gained a `pairs_linked_count` column (migration `0015`) so `/import/success/[batchId]`'s "transfer pairs linked" tile reflects that case instead of recomputing a `COUNT(*)` that undercounts it. Also fixed: the shared `startingBalanceDateSchema` now rejects calendar-invalid dates like `2026-13-40` via `z.iso.date()` — a bare `YYYY-MM-DD` regex previously accepted them, and SQLite's TEXT date comparison sorts a malformed date after every real one, so it could silently drop an account's entire imported history out of its displayed balance; and `scripts/db-paths.mjs` now respects `DATA_DIR` like the rest of the app, so running `pnpm db:migrate` from the wrong working directory (a second local checkout, say) can no longer silently migrate an unrelated empty database and report success. See the Fixed section of [CHANGELOG.md](./CHANGELOG.md).

v0.12.2 — two starting-balance correctness fixes plus a dashboard chart UI fix. `deriveStartingBalance` (`src/lib/accounts/deriveStartingBalance.ts`) previously defaulted to the file's own row order whenever a same-day transaction pair netting to zero made the running-balance chain validate in both directions — the two orders are mathematically indistinguishable but can produce disagreeing anchors, so it now refuses to move the anchor unless both orders agree. `anchorStartingBalance` (`src/lib/importBatch.ts`) now runs inside `commitImport`'s write transaction instead of after it, bounds-checks the derived balance/date against the same shared schema (`src/lib/import/accountAnchorFields.ts`) `validateCreateAccountInput`/`validateUpdateAnchorInput` use, and persists the account's prior anchor onto the batch (migration `0014`) so a bad automatic move is visible and reversible from `/import/success/[batchId]` instead of only via a full snapshot restore. Separately, the dashboard's 6-month trend chart tooltip no longer overlaps its own legend on months with many categories (capped at 5 rows plus a "+N more" line, pinned near the top of the plot area) and its hover-highlight rectangle now uses the chart's own border color instead of Recharts' default light-theme fill. See the Fixed section of [CHANGELOG.md](./CHANGELOG.md).

v0.12.0 — auto-categorization at import time gets its own undo: `commitImport` and `syncSimpleFin` now write an `import_batch_categorizations` row (transaction id, category id, rule id) whenever `buildRuleMatcher` resolves a row, and `undoImportCategorization` (`src/lib/categorize/`) reverts a batch's rule-matched rows in one bulk UPDATE per category — stale-row-safe, so a row you've since hand-recategorized (even back to the same category) is left alone. Wired to an "Undo auto-categorization" button on `/import/success/[batchId]`, with `/sync` linking there instead of duplicating the control for synced batches. Closes the gap CLAUDE.md rule 6 had flagged since v0.3.0: the migration that seeds 23 broad subscription-merchant rules is exactly the kind of too-broad rule this exists to recover from. See the Added/Fixed sections of [CHANGELOG.md](./CHANGELOG.md).

v0.11.0 — the `/sync` balance check now tells real drift from a stale bank figure: a difference is only reported as "a row is missing or duplicated" once the bank's own balance-date is after the ledger's newest row, via a new pure `classifyBalanceFreshness` (`src/lib/simplefin/balanceFreshness.ts`) — same-day, older, or dateless bank figures render as unconfirmed instead. Also added an inline anchor-edit form on `/import` (`updateAccountAnchorAction` + `validateUpdateAnchorInput`) so a wrong starting-balance anchor no longer needs raw SQL to fix, capped at today's date since a future anchor would exclude the account's entire history from its balance. See the Added section of [CHANGELOG.md](./CHANGELOG.md).

v0.10.0 — stabilization pass ahead of loading the real ledger ([docs/plans/load-the-ledger.md](./docs/plans/load-the-ledger.md)): imports now auto-categorize against trained rules (`applyRuleAtImport` shipped in v0.3.0 but had zero production callers until this pass, so every import had been landing 100% uncategorized), and CSV import now derives the account's starting balance from Star One's own running-balance column instead of trusting the number typed at account creation. A pre-landing review then found six more silent-corruption paths reachable on that same migrate-then-backfill sequence: a wider CSV re-export could import history twice, a pending row's posted counterpart could vanish into the ledger forever, a journal-timestamp bug silently skipped the migration that seeds the Subscriptions category, a pending row could inflate the computed balance past the bank's own figure, undoing a sync could delete a transaction with no other copy, and a CSV↔CSV coincidence could auto-link as a transfer instead of going to review. See the Added/Fixed sections of [CHANGELOG.md](./CHANGELOG.md).

v0.9.0 — PR1 of the dockerize-postgres plan ([docs/plans/dockerize-postgres.md](./docs/plans/dockerize-postgres.md)): `docker compose up` starts the app at `localhost:3000` on the existing ledger, still on SQLite. `pnpm dev` is unaffected — Docker is a second way to run the app, not a replacement. Ledger lives in a named volume (WAL-mode SQLite doesn't tolerate bind-mount filesystems reliably), snapshots land on a separate `./backups` bind mount, `pnpm db:seed-volume`/`db:export`/`db:import` cover first-run seeding and rollback, and `/api/health` backs the Compose healthcheck. Also fixed a live bug where the app derived the current budget month through `.toISOString()` in a few places, which ignores the configured timezone — one of those sites fed the transfer-review window, so an ambiguous transfer pair right at the edge could silently drop out of review. PR2 (SQLite → Postgres) is planned but not started. See the Fixed/Added sections of [CHANGELOG.md](./CHANGELOG.md).

v0.8.3 — three fixes from the v0.8.0 ship review: re-pointing a SimpleFIN account link no longer crashes the next sync (`setAccountLink` now clears the old rows' `external_id`, though it still can't rule out a double-count if a different account later claims the same feed — tracked as a follow-up); `import_batches.filename` is now a nullable `label` instead of holding a synthetic non-filename for sync batches, with `deriveBatchLabel`/`resolveBatchLabel` (`src/lib/batchLabel.ts`) computing the display string; and `pnpm db:migrate` runs through `scripts/migrate.mjs` instead of `drizzle-kit migrate`, because the label migration's table rebuild crashed with a foreign-key error against any database with real rows (invisible on an empty dev database). See the Fixed section of [CHANGELOG.md](./CHANGELOG.md).

v0.8.2 — CSV import now checks the snapshot it takes before trusting it as a rollback point, closing the known issue recorded in 0.8.1 (`commitImport` never checked `createSnapshot`'s `consistent` flag; `/sync` already did). A degraded snapshot no longer blocks the import — it's recorded on `import_batches.snapshot_warning` and shown on `/import/success/[batchId]` instead of being silently assumed to work. See the Fixed section of [CHANGELOG.md](./CHANGELOG.md).

v0.8.1 — planning only: reviewed plan for running the app in a container and moving it to Postgres, staged as two PRs. No app code changed in that release.

v0.8.0 — automated sync:
- `/sync`: map each local account to a Star One account from the feed, pull posted transactions on demand, undo the last batch without stopping the dev server
- `src/lib/simplefin/`: access-URL parsing, feed client, row mapping, two-source dedup (`external_id` + content signature), counting-based transfer matcher, logical undo
- Migrations `0007` (`accounts.simplefin_account_id`, `transactions.external_id` + partial unique indexes) and `0008` (`transactions.payee`)
- `pnpm simplefin:claim` / `pnpm simplefin:sample`
- Snapshot fix: WAL is folded in before the file copy, so pre-write snapshots are complete — this affected CSV import too
- Feed limits that shape the design: ~45 days of history, posted rows only, accounts imported only once explicitly linked. CSV import is not legacy; it is the only path to older history.

Weekend 1 — CSV import pipeline:
- Real CSV data analyzed (checking + savings, 90 days, 652 rows combined)
- Six-table Drizzle schema + migration landed; HMR-safe DB singleton in place
- Pure-function tier shipped with Vitest coverage: merchant normalizer (12 rules), row-hash, Star One CSV parser, memo-independent transfer-pair matcher
- Snapshot + import orchestrator: `commitImport` snapshots the DB, inserts batch + rows in a single transaction, then links transfer pairs
- Upload/preview/confirm UI in the App Router using Server Actions; confirm flow verified live (543 rows committed, snapshot written, redirect to success page)
- Star One CU memo-labeling quirk logged as a durable project memory

Weekend 2 — envelope budgeting + bulk categorize:
- `budget_periods.effective_allocation_cents` migration + `getEffectiveAllocation` lazy-cache + `invalidateForwardRollover` contract (triggered on allocation edits, categorize/re-categorize, carryover_policy change)
- `/budget/[year]/[month]` server-rendered table (parent-grouping with synthetic "Ungrouped" section, summary strip, backlog banner)
- `/categorize` bulk-by-merchant surface with Sonner 10s Undo toast and live backlog counter
- Track D — Allocate 3-field Dialog (Explicit editable, Rollover read-only, Effective live-computed) shipped as shadcn Dialog client island, with iOS autozoom fix (`text-base sm:text-sm`)
- 174 Vitest tests pass, `tsc --noEmit` clean

Next up (see [TODOS.md](./TODOS.md)):
- v0.8.0 ship-review follow-ups: re-pointing a SimpleFIN link still orphans `external_id`s (open). The dropped sync warnings, the cross-source dedup and snapshot bugs, the sync test gaps, and the CSV-import snapshot-check gap are all closed — see the Fixed section of [CHANGELOG.md](./CHANGELOG.md).
- Dockerize + Postgres migration: PR1 (containerize on SQLite) shipped in v0.9.0. PR2 (SQLite → Postgres) is planned in [docs/plans/dockerize-postgres.md](./docs/plans/dockerize-postgres.md) but not started.
- **Integration checkpoint**: use the app on real data for a week, now with sync doing the loading

## Cut-line

Drop the subscriptions tracker (Weekend 4) if behind. Keep goals/savings (Weekend 5) — they were in-scope from day one.

## Where things live

| Thing | Location |
|---|---|
| Canonical design doc | `~/.gstack/projects/thehashrocket-my_money_manager/jasonshultz-thehashrocket-budgeting-app-design-20260416-173405.md` |
| Design deltas after real CSV review | `.context/design-updates.md` (Updates 1-5) |
| CSV format notes (checking + savings) | `.context/csv-format.md` |
| Assignment / short-term todos | [TODOS.md](./TODOS.md) |
| Release history | [CHANGELOG.md](./CHANGELOG.md) |
| Current version | `package.json` `"version"` field |
| Star One CU labeling quirk | `~/.claude/projects/…/memory/project_star_one_cu_overdraft_labeling.md` |
| SimpleFIN feed shape (real payload) | `~/.claude/projects/…/memory/project_simplefin_star_one_data_shape.md` |
| Design system reference | [DESIGN.md](./DESIGN.md) |
| Dockerize + Postgres plan (PR1 shipped, PR2 not started) | [docs/plans/dockerize-postgres.md](./docs/plans/dockerize-postgres.md) |
| Zero-based budgeting plan (PR1+PR2 shipped in v0.13.0, PR3 deferred) | [docs/plans/envelope-budgeting.md](./docs/plans/envelope-budgeting.md) |
| SimpleFIN credentials | `SIMPLEFIN_ACCESS_URL` in `.env.local` (gitignored; written by `pnpm simplefin:claim`) |
