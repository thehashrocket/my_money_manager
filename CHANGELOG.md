# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.1] - 2026-09-03

### Fixed
- **The category picker's search box on `/transactions` and `/categorize` stopped matching anything you typed.** Typing "hotel" (in any case) wouldn't find the "Hotels" category, because the picker's label-lookup function was being handed the wrong shape of data during filtering and always came back empty — every keystroke matched against nothing. Search now works as typed.
- **The same picker could also lose track of which category was highlighted after searching, then clearing the search text.** A related mismatch meant the currently-selected category and the full category list weren't compared consistently, which could drop the keyboard highlight after backspacing out a search. Fixed alongside the search bug since both traced back to the same root cause.

## [0.12.0] - 2026-09-03

_A too-broad rule trained today already has 23 seeded siblings from migration 0006 (NETFLIX, SPOTIFY, HULU, and 20 others) — every one of them a candidate for mis-tagging an entire import with no way back short of restoring the whole database. This release closes that gap: import-time categorization gets its own undo, scoped to just the categorization, not the transactions it touched._

### Added
- **Auto-categorization at import can now be undone without discarding the whole import.** Every row a trained rule categorizes on the way in — from a CSV import or a SimpleFIN sync — is now recorded, and an "Undo auto-categorization" button on the import success page (and a link from `/sync` for synced batches) reverts just those rows back to uncategorized. A row you've since categorized yourself, by hand, is left alone even if it happens to land back on the same category a rule originally chose.

### Fixed
- CLAUDE.md's description of import-time categorization no longer claims it has no undo — corrected to match the behavior above.

## [0.11.0] - 2026-09-03

_The `/sync` balance check could only say one thing about a difference: "a row is missing or duplicated." That was wrong whenever the bank's own figure was simply out of date — measured once at +$893.84 of "drift" that was really just a day of activity the bank hadn't reported yet. This release teaches the check to tell the two apart, and gives you a way to fix the one thing that was making the ledger-side comparison untrustworthy in the first place._

### Added
- **The balance check on `/sync` now distinguishes a real discrepancy from a stale bank figure.** A difference is only reported as "a row is missing or duplicated" once the bank's own figure is dated *after* your newest ledger row — same-day or older figures are shown as unconfirmed instead, alongside the bank figure's as-of date, rather than accusing the ledger of corruption it doesn't have. A bank figure with no date at all is now called out separately, since that's a different reason to withhold judgment than simply being old.
- **A wrong starting-balance anchor no longer needs raw SQL to fix.** Each account on `/import` has an inline "start [balance] on [date] Save" form — the only way back once an anchor is set too late, since a CSV import can only ever move it forward. The date is capped at today and any future date is rejected outright, since an anchor dated ahead of every real transaction would exclude your entire imported history from the balance and permanently silence the drift check in the same stroke.

_Stabilization pass ahead of loading the real ledger — see `docs/plans/load-the-ledger.md`. Three defects, all of which only bite on real data, plus the doc drift that hid the first one; a pre-landing review then found six more, all silent-corruption paths reachable during the same migrate-then-backfill sequence this pass exists to make safe._

### Added
- **Imported transactions are now categorized automatically** from the rules you have already trained. `applyRuleAtImport` shipped in 0.3.0 with tests and a changelog entry saying it ran at import — and nothing ever called it, on either the CSV path or SimpleFIN sync. Every import landed 100% uncategorized no matter how many rules existed, which is why the backlog only ever grew. Both write paths now resolve each row through the rules table, and the import success page reports how many rows resolved and how many are left.
- **An import now sets the account's starting balance** from Star One's running-balance column, which the parser has always read and always discarded. Accounts created with a starting balance of 0 display net-change-since-signup rather than a balance, and `/sync`'s drift check compares that against the bank's real figure and reports a phantom missing row forever. The anchor is only written when the file's running balance forms a consistent chain — a gappy or hand-assembled export leaves it alone rather than guessing — and it only ever moves forward in time. The import success page now shows the anchor a batch actually wrote, rather than re-reading the account's current anchor (which could belong to a later import by the time you look).

### Fixed
- **A wider CSV re-export no longer imports history twice.** Star One exports an arbitrary date range, and the duplicate check keyed on a hash that includes each row's position in its file — so re-exporting a window that overlapped what you already had shifted every row and matched nothing, silently double-counting the overlap while the preview reported "0 duplicates". Import now also compares on content, the same way sync has since 0.8.0. Two genuinely identical same-day transactions still both import.
- **Transfers from a backfill can now be reviewed.** The transfer-review list on `/sync` looked back 120 days, which cut off the start of any catch-up import; those pairs stayed unlinked and kept counting as spending with nothing on screen to say so. Widened to 240 days.
- **A pending row's posted counterpart no longer vanishes into the ledger forever.** The content-dedup pass above had no pending/posted distinction, so a row CSV-imported while pending permanently suppressed its own posted re-export — stuck on Star One's `6098` placeholder, un-pairable by the transfer matcher, invisible to subscription detection. Content dedup now recognizes a pending row's posted arrival and updates it in place.
- **A migration that seeds the Subscriptions category and its rules was silently skipped** on any database with real history — a journal-timestamp ordering bug meant it could never apply once later migrations landed, though the migration runner reported success either way.
- **The account balance shown after a sync could read as a phantom missing transaction.** A pending row imported from CSV inflated the computed balance past the bank's own posted figure, which `/sync`'s drift check compares against.
- **Undoing a sync could delete a transaction with no other copy.** CSV content-dedup has no notion of which source a row came from, so a later CSV import could quietly rely on a sync batch's row already being there. Undo now refuses once a newer import of any kind exists, rather than deleting silently.
- **A same-day, same-amount coincidence between two CSV rows could get auto-linked as a transfer** instead of being sent to review — backwards from the intent, since both legs having already been examined and declined by the stronger ±1 matcher is the strongest evidence against a real transfer, not the weakest.

## [0.9.0] - 2026-09-03

_PR1 of the dockerize-postgres plan: the app now runs in Docker, still on SQLite. `pnpm dev` is unaffected — this is a second way to run the app, not a replacement._

### Added
- **`docker compose up` starts the app at `localhost:3000`**, serving your existing ledger. The port is bound to loopback only (this app has no auth), the ledger lives in a named Docker volume (SQLite's WAL mode doesn't tolerate bind-mount filesystems reliably), and pre-write/pre-migrate snapshots land on a separate `./backups` bind mount so `docker compose down -v` can't take the ledger and its rollback history out in one command.
- `pnpm db:seed-volume` — one-time host → volume copy for the first `docker compose up`, so a fresh container doesn't start with an empty ledger. Refuses to overwrite a volume that already has data.
- `pnpm db:export` / `pnpm db:import <file>` — snapshot the running container's ledger out to `./backups`, and restore a snapshot back in (stopping and restarting the container). `db:import` now also refuses to restore a file that isn't a real, openable database with an `accounts` table — a corrupt or empty snapshot used to "restore" silently as an empty ledger with no error.
- `/api/health` — a liveness probe the Compose healthcheck uses; doesn't run the full dashboard query set.
- A CI job builds the Docker image on every PR, seeds it, brings it up, and round-trips an export/import to catch regressions in the container path before merge.

### Fixed
- **The app could compute the wrong budget month for part of every day**, because it read the system clock through `.toISOString()` in a few places, which always renders the UTC calendar date regardless of the configured timezone. A shared `src/lib/now.ts` fixes this everywhere it mattered, including one site that fed the transfer-review window — under the old code an ambiguous transfer pair right at the edge of that window could silently drop out of review and keep inflating spending.
- **`/import` was frozen at build time** (a pre-existing bug, surfaced by containerizing): the page never opted into per-request rendering, so its starting-balance date default froze to whenever the app was last built rather than updating daily.
- Every container restart was writing a rollback snapshot into the same retention pool that CSV imports and syncs prune to the last 10 — so a crash loop or a routine host reboot could silently evict a real pre-import snapshot a user might actually need. Restart snapshots now use their own pool, matching the naming convention `pnpm db:migrate` already used for this on the host.
- On real Linux hosts (found via CI, which runs Ubuntu), `./backups` — a bind mount — got auto-created root-owned on first use, so the container's unprivileged user hit `EACCES` on its very first snapshot write and never became healthy. macOS Docker Desktop's more permissive bind-mount layer never surfaced this. Fixed with a permissions step before the first `docker compose up`, documented in the README quickstart.
- `db-import`/`db-seed-volume` hardcoded a Docker volume name that could silently diverge from the real one whenever `COMPOSE_PROJECT_NAME` was set, touching a different, empty, auto-created volume instead of the live ledger with no error. Now resolves the actual name from `docker compose config` at runtime.
- The container would boot with `TZ` set to an invalid value (e.g. a typo) and silently behave as UTC — reintroducing the exact bug this release fixes. `TZ` is now validated as a real IANA zone at boot, not just checked for non-empty.

_Re-pointing a SimpleFIN account link no longer crashes the next sync — and the database migration that made that possible was hardened after it turned out to crash on any real database, not just an empty dev one._

### Fixed
- **Re-linking a SimpleFIN account to a different feed no longer crashes the next sync.** Previously, un-linking or re-pointing an account's feed kept its old rows tagged with the feed's `external_id`, so the next sync collided with a unique-index constraint and aborted. `setAccountLink` now clears those tags when a link changes, and reports how many rows it touched.
  - This does **not** fully prevent double-counted transactions if a different account later claims the same feed — the app's duplicate-detection is scoped per account by design, so it can't see rows that moved to a different one. The warning now says so explicitly instead of promising protection it can't deliver; tracked as a follow-up in `TODOS.md`.
- **A batch's stored label no longer holds a fake filename.** Sync batches used to store a synthetic string like `"simplefin 2026-09-02 17:00Z"` in a field meant for real uploaded filenames. `import_batches.filename` is now a nullable `label` — CSV imports still record the real filename, and sync batches leave it blank, with the display computed from the batch's source and time instead.
- **Database migrations no longer risk failing on a real database.** The migration above needed a full table rebuild (SQLite can't relax a `NOT NULL` column any other way), which turned out to crash with a foreign-key error the moment the database had any real imported data — invisible in local dev because an empty database never hits the failure path. `pnpm db:migrate` now runs through a small custom script that disables foreign-key enforcement for the duration of the migration instead of relying on `drizzle-kit migrate`'s default connection handling, which can't do that safely.

## [0.8.2] - 2026-09-02

_Closes the known issue recorded in 0.8.1: CSV import now actually checks the snapshot it takes before trusting it as a rollback point._

### Fixed
- **CSV import no longer trusts an unverified database snapshot.** `commitImport` now checks the `consistent` flag `createSnapshot` returns, matching the check `/sync` already had. If the pre-import snapshot degrades to a plain file copy (which can produce a file that won't open at all if restored), the import still completes — it isn't blocked — but a warning is now recorded on the batch and shown on the import success page, so it's visible instead of silently assumed to be a working rollback.
- The warning is persisted on the batch row (`import_batches.snapshot_warning`), not just shown once right after import — it stays visible on that batch's success page on any later visit, and never touches the URL.
- `/sync` now persists its own degraded-snapshot warning the same way. It already checked `consistent`, but only ever surfaced the warning transiently through the sync page's action state — the batch row itself was left with `snapshot_warning` always `NULL`, which made the DB an unreliable record for any SimpleFIN-sourced batch.

## [0.8.1] - 2026-09-02

_Planning only — the app itself is unchanged and every one of the 402 tests still passes. This release adds the reviewed plan for running my_money_manager in a container and moving it to Postgres, staged as two separate PRs so the ledger is never protected by an undefined safety net. It also records a real bug the review turned up in code that already ships._

### Added
- **Dockerize + Postgres plan** (`docs/plans/dockerize-postgres.md`) — the full design for PR1 (containerize on SQLite) and PR2 (migrate to Postgres), with 20 implementation tasks, 23 required tests, and 24 tracked failure modes. Staged deliberately: PR1 leaves the app better off even if PR2 never happens, and the snapshot/rollback story is never undefined at the same time as the container story.
- **Two follow-ups recorded in `TODOS.md`** — reaching the app from a phone or a NAS (the reason Postgres is in the plan at all), and a `/budget` query rewrite that closes itself if a measurement comes in under 150ms.

### Known issues
- Nothing in shipped code changed this release, but one existing defect is now written down rather than unknown: **CSV import records a database snapshot it never verifies.** `createSnapshot` reports `consistent: false` when it falls back to a plain copy, which can produce a file that will not open at all. `/sync` checks that flag; CSV import does not, so an import can complete believing it has a rollback that would fail at the moment it is needed. Tracked as a P0 in `TODOS.md` and scheduled as the first task of PR1 (T6a).

## [0.8.0] - 2026-09-02

_Transactions now pull themselves in. Link your Star One accounts once and `/sync` fetches posted transactions straight from the bank behind a database snapshot you can undo — no weekly CSV download, no sign-in. Balances are checked against the bank's own figure on every visit, so a missing or duplicated row shows up as drift instead of hiding. CSV import is untouched and stays the only way to load history older than 45 days._

### Added
- **`/sync` page** — link each local account to a Star One account, pull posted transactions on demand, and see what landed. Writes straight to the ledger; no preview step.
- **Undo last sync** — removes the batch's transactions and the batch itself without stopping the dev server. The pre-write database snapshot stays as the escape hatch for anything undo can't reach.
- **Balance check** — the bank's own balance against the one this ledger computes, with the difference called out when they disagree. Available balance is shown separately, which is where pending card holds appear.
- **Transfers needing review** — when a same-day, same-amount transfer genuinely can't be resolved by counting, it asks instead of guessing. On real data this is roughly one day per quarter. Note the UI counts *buckets*, which are emitted per account-pair direction, so a single undecidable day can show as two entries.
- **Automatic transfer matching for feed rows** (`src/lib/simplefin/matchTransfers.ts`) — the CSV matcher keys on Star One's sequential transaction number, which the feed doesn't carry, so this replaces it with a counting argument over `(date, |amount|)` buckets, filtered within each bucket to opposite signs across different accounts. 56 of 58 pairs link themselves on a real 90-day pull; the one undecidable day admits two more. A pair spanning both sources only auto-links when the memo corroborates it — otherwise the CSV transaction-number matcher, which is a stronger signal and already declined that row, would be silently overridden by a same-day coincidence.
- **Pending rows from the feed are refused, not written** — sync never requests them and Star One returns none, but if one ever arrived it could not be updated when it posted, so the pre-authorisation amount would be frozen and the posted row added alongside it. They are now skipped and reported instead.
- **Unpair a transfer** — a "Linked transfers" list on `/sync` with a "Not a transfer" button. Auto-linking excludes both rows from every spending view, so this is the way back out when a same-day, same-amount coincidence gets paired by mistake.
- **Merchant names from the feed** (`drizzle/0008_naive_zeigeist.sql`) — the bank's cleaned payee ("Save Mart") is stored alongside the raw description. Categorization still matches on the raw form, so existing rules keep working.
- **`pnpm simplefin:claim`** — one-time exchange of a SimpleFIN setup token for an access URL, written to `.env.local` with owner-only permissions.
- **`pnpm simplefin:sample`** — dumps a live account payload to `.context/` for inspection.

### Changed
- **Duplicate detection now understands two sources** (`drizzle/0007_unique_lily_hollister.sql`) — feed rows dedupe on the bank's own transaction id, enforced by a database index. Because the feed re-sends days already imported from CSV, rows are also compared on content, counted rather than matched, so two genuinely identical same-day purchases both survive.
- **Sidebar** — added a Sync tab above Import.

### Fixed
- **Pre-import snapshots could be unreadable, not just incomplete.** The database runs in WAL mode, so committed writes can live in a side file that a plain copy missed. Folding the log in first with `PRAGMA wal_checkpoint` is not enough: it does not fail loudly when another connection holds a read — it reports "busy" in a return value the old code discarded — and the resulting copy could fail to open at all with "database disk image is malformed". Snapshots are now written with `VACUUM INTO`, which is consistent by construction, and a snapshot that has to fall back to a plain copy says so. This affects CSV import too, not just sync.
- **Old snapshots were deleted before the write they protect.** A failed import had already evicted the oldest snapshot to make room for a useless one, so repeated failures quietly ate the rollback history. Pruning now happens only after a write commits, and a failure to delete an old snapshot no longer aborts an import that already succeeded.
- **`.context/` was not ignored by the committed `.gitignore`** — it held real transaction data and was excluded only by a local, unshared git setting, so a fresh clone would have left it exposed to `git add`.

## [0.7.2] - 2026-04-21

_Subscriptions can now be categorized in one click. New auto-categorize actions on the subscriptions page tag detected recurring charges as Subscriptions and create a remember-this-merchant rule. Twenty-three category rules for common streaming and software services seed automatically so new imports land in the right bucket from day one._

### Added
- **"Categorize" button per subscription row** — tags all uncategorized transactions from that merchant as Subscriptions and saves an exact rule for future imports.
- **"Categorize all" button** — bulk-categorizes every active detected subscription at once.
- **Subscription service category rules** (`drizzle/0006_subscription_rules.sql`) — 23 `contains` rules at priority 30 for Netflix, Spotify, Hulu, Disney+, Amazon Prime, YouTube Premium, HBO Max, Peacock, Paramount+, Adobe, Dropbox, GitHub, Zoom, Crunchyroll, iCloud, Google One, Microsoft 365, Office 365, Apple One, ESPN+, and Audible. Priority 30 means user-created rules (priority 50) always win.

### Fixed
- **Test suite compatibility** — rule-count assertions now filter to `matchType = 'exact'` so the seeded `contains` rules from this migration don't inflate counts.

## [0.7.1] - 2026-04-21

_Integration checkpoint polish. Categorized items on `/categorize` and `/transactions` now fade to 50% opacity so the uncategorized work is obvious at a glance. A new Subscriptions category joins the spending list._

### Added
- **Subscriptions category** (`drizzle/0005_subscriptions_category.sql`): generic catch-all for subscription-based charges that don't fit the more specific Streaming/Software/News categories.

### Changed
- **`/categorize`** — merchant rows with an existing rule fade to 50% opacity (`opacity-50 hover:opacity-100`). The uncategorized work rises to the top visually.
- **`/transactions`** — already-categorized rows fade to 50% opacity, restoring on hover. Uncategorized rows stay full-brightness so the backlog is obvious.

## [0.7.0] - 2026-04-20

_Weekend 5 — Goals and trend chart ship. You can now create savings goals, track contributions month-by-month, and see a 6-month spending breakdown by category directly on the dashboard. Recharts enters the stack, client-side only, rendering a stacked bar chart from server-fetched data._

### Added
- **`/goals` page**: server-rendered savings goals list. Each goal card shows name, progress bar (contributed − withdrawn / target), percentage complete, remaining amount, and a native `<details>` monthly contribution breakdown. Empty state prompts creating the first goal.
- **Create goal form**: inline `<form action>` on `/goals` — name, target ($), carryover policy (none/rollover/reset). Validates via Zod (`validateGoalInput.ts`), inserts a category row with `is_savings_goal=true`.
- **Edit target**: inline `<details>` disclosure form on each goal card — updates `target_cents` in place, page rerenders. No redirect needed.
- **`loadGoals`** (`src/lib/goals/loadGoals.ts`): three synchronous queries — savings goal categories (LEFT JOIN budget_periods for contributions), withdrawal aggregation (negative transactions, transfer-excluded), monthly breakdown. Returns `GoalsView` with per-goal progress and totals strip.
- **`validateGoalInput`** (`src/lib/goals/validateGoalInput.ts`): Zod schemas for create and update-target, following the `safeParse` pattern used throughout the project.
- **`NotASavingsGoalError`** added to `src/lib/categoryErrors.ts`.
- **Goals nav link** in Spine enabled (`/goals`); "Coming Weekend 5" tooltip removed.
- **Spending trend chart** on dashboard (`/`): stacked bar chart showing last 6 months of categorized spending by top-level category group (excludes transfers, savings goals, income). Sits between MonthlySummary and the backlog tile.
- **`loadMonthlyTrends`** (`src/lib/trends/loadMonthlyTrends.ts`): server-side query — two SQL calls (category hierarchy map + spend aggregation with `strftime`), post-processed in TypeScript into a `TrendData` shape safe to cross the RSC→Client boundary.
- **`TrendChart`** (`src/components/ledger/trend-chart.tsx`): `"use client"` Recharts `BarChart` — stacked bars per month, CSS var chart colors, custom tooltip using `formatCents`, empty state when no data. `recharts@3.8.1` added to dependencies.

## [0.6.0] - 2026-04-20

_Weekend 4 — Subscriptions tracker ships. The app now automatically detects recurring charges from your transaction history using a simple, deliberate heuristic: 3+ transactions for the same merchant with consistent monthly (25–35 day) or quarterly (85–95 day) intervals and amounts within MAX($0.50, 2% of median). No manual entry, no separate subscription ledger — detection runs from the data you've already imported._

### Added
- **`/subscriptions` page**: server-rendered list of detected recurring charges with cadence (monthly/quarterly), median charge amount, first-seen date, and next expected charge date. Empty state prompts importing 3+ months of history.
- **Dismiss/Restore**: one toggle per merchant group — "Not a subscription" moves it to a dismissed section; Restore brings it back. Implemented via `dismissSubscriptionAction` and `restoreSubscriptionAction` (Zod-validated server actions).
- **`subscription_dismissals` table** (`drizzle/0004_chubby_the_spike.sql`): stores dismissed merchants with a unique index; applied via migration.
- **`detectSubscriptions`** (`src/lib/subscriptions/detectSubscriptions.ts`): pure detection function, 14 Vitest tests covering monthly, quarterly, irregular, amount tolerance, empty input, and the 2%-vs-$0.50 tolerance boundary.
- **`loadSubscriptions`** (`src/lib/subscriptions/loadSubscriptions.ts`): queries non-transfer, non-pending transactions (excluding `DEPOSIT` rows and `POS \d+` refund memos per CLAUDE.md exclusion rules), runs detection, splits results into active and dismissed.
- Spine nav Subscriptions link enabled; Goals remains "Coming Weekend 5".

### Fixed
- **Subscription detection exclusions**: `loadSubscriptions` now filters out `raw_description = 'DEPOSIT'` and `raw_memo LIKE 'POS %'` rows before detection, per CLAUDE.md exclusion rules (these are deposits and refunds, never recurring charges).

## [0.5.2] - 2026-04-20

### Fixed
- **Rule upsert race (TOCTOU)**: `createOrUpdateRule` previously did a select-then-insert that two concurrent writes could both win. Now a single `INSERT ... ON CONFLICT (match_type, match_value) DO UPDATE` backed by a new unique index on `category_rules(match_type, match_value)` closes the window entirely. Requires migration `0003_flimsy_micromacro.sql`.
- **Undo bulk-categorize deletes wrong rule**: when no prior rule existed, `undoBulkCategorize` deleted by `(match_type, match_value, category_id)`. A concurrent bulk-categorize could cause it to delete a rule it didn't create. Now deletes by the primary key (`insertedRuleId`) captured at bulk time.
- **ReDoS on regex rules**: `applyRuleAtImport` compiled user-authored regex patterns without a length guard. Patterns longer than 200 characters now short-circuit to non-matching before the regex engine sees them.

## [0.5.1] - 2026-04-20

### Added
- **43 spending categories** via `drizzle/0002_more_categories.sql`: Rent, Home Maintenance, Renter's Insurance, Car Insurance, Car Maintenance, Parking, Rideshare, Public Transit, Coffee, Fast Food, Alcohol, Internet, Phone, Electric, Water, Doctor, Dentist, Pharmacy, Health Insurance, Gym, Haircut, Clothing, Movies & Events, Hobbies, Streaming, Books & Music, Amazon, Electronics, Home Goods, Bank Fees, ATM, Gifts, Charity, Paycheck, Interest, Reimbursement, Hotels, Flights, Vacation, Childcare, School, Software, News & Magazines. Total category count: 49 (up from 6).

## [0.5.0] - 2026-04-20

_Weekend 3 — Ledger Paper design system lands. The app now has a full visual identity: warm paper-tone surfaces, Newsreader serif for headings, Geist Mono for money, a Spine navigation rail that stays on every page, and a dashboard command-center that shows account balances, monthly budget summary, and the uncategorized backlog at a glance. Light and dark themes switch without flash. The design tokens and nav prototype live in `design_handoff_nav_and_design_system/` as live HTML specimens._

### Added
- **Dashboard** (`src/app/page.tsx`): account balance tiles per account, total balance row, monthly summary strip (Allocated / Effective / Spent / Remaining), uncategorized backlog tile, quick links to `/budget` and `/transactions`. Empty state shows `∅` with a link to import.
- **Spine navigation rail** (`src/components/ledger/spine*.tsx`): fixed left rail with app branding, active-tab highlight, month picker (context-aware: follows current month on most pages, follows the URL on `/budget`), account balance peek with running total, and an amber count chip for the uncategorized backlog.
- **Ledger Paper design system** (`src/app/globals.css`, `design_handoff_nav_and_design_system/`): full token set — paper surfaces (`--paper-0/1/2/3/4`), ink text (`--ink-1/2/3/4`), semantic money colors (`--money-pos/neg/zero`), Terracotta primary, Amber backlog, Ledger green, Redbrown destructive. Radii, shadow, and spacing cadence locked. Tailwind utilities wired to all tokens.
- **Light / dark theme** (`src/components/ledger/theme-toggle.tsx`, `theme-init.tsx`): system-preference default, FOITD-free inline script in `<head>` so there is no flash on reload.
- **`EnvelopeCard`** (`src/components/ledger/envelope-card.tsx`): signature card component for budget envelope display — envelope name, allocated / spent / remaining cells with correct money coloring, over-budget destructive state.
- **`loadAccountBalances`** (`src/lib/accounts/loadAccountBalances.ts`): authoritative per-account balance using the formula from CLAUDE.md (`starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)`).
- **Design handoff** (`design_handoff_nav_and_design_system/`): live HTML specimens for the design system and nav prototype, plus a `README.md` capturing all visual decisions.
- **Zod validation on all Server Actions** (`src/app/import/actions.ts`, `src/app/categorize/actions.ts`): `validateCreateAccountInput`, `validateUploadCsvInput`, `validateImportIdInput`, `validateBulkCategorizeSnapshot` replace ad-hoc checks. All validators ship with full test suites (124 new tests across 4 files).
- shadcn primitives: `src/components/ui/table.tsx`, `combobox.tsx`, `input-group.tsx`, `input.tsx`, `textarea.tsx`.
- Shared `CategoryCombobox` wrapper (`src/components/CategoryCombobox.tsx`) used by both categorize and transactions inline pickers.
- CSV fixture files for testing: `src/lib/__fixtures__/sample-checking.csv`, `sample-savings.csv`.
- Node 24 engine lock (`.nvmrc`, `engines` field in `package.json`, `.npmrc` with `engine-strict=true`).

### Changed
- **Layout** (`src/app/layout.tsx`): Newsreader + Geist + Geist Mono loaded via `next/font`, Spine rail wired into the shell, `ThemeInit` script in `<head>`.
- **`BacklogBanner`**: updated to use Amber design tokens; accepts `variant="budget"` prop.
- `/budget` page: raw `<table>` → shadcn `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell` primitives.
- `/categorize` and `/transactions` inline pickers: native `<select>` → searchable `CategoryCombobox` (Base UI Combobox variant).
- **`findTransferPairs`** (`src/lib/transferPair.ts`): buckets candidates by `(date, |amount|)` — same-day scan drops from O(N²) to O(N).

### Fixed
- `parseCsv` test fixture aligned with actual Star One CSV format.

## [0.4.1] - 2026-04-19

_Weekend 2 polish — transfer-pair matcher now scales linearly on same-day imports. Previously, every unpaired row for a given date was compared against every other unpaired row for that date; with N rows sharing one date, that's O(N²) work on each import. Now candidates are bucketed by `(date, |amount|)` before the pairing scan, so two rows only enter the inner comparison if they already agree on both. Real-world same-day row counts stay in the single digits, but the ceiling is no longer O(N²)._

_Also: scope-guardrail cleanup — the "shadcn components locked" item in TODOS.md is now honored. `/budget` renders through the shadcn `Table` primitive (still server-rendered, still no TanStack). Both inline category pickers on `/categorize` and `/transactions` swap native `<select>` for a searchable shadcn/Base UI `Combobox` via a shared `CategoryCombobox` wrapper that still submits the selected id via the FormData path, so every existing Server Action is untouched._

### Changed
- **`findTransferPairs`** (`src/lib/transferPair.ts`): buckets candidates by `(date, |amount|)` instead of just `date`. Same-day scan drops from O(N²) to O(N) across buckets of size 2–3. Zero-amount filter moved to the bucketing step (same observable behavior — a zero-amount row cannot form a pair with an opposite-sign counterpart).
- Removed now-redundant in-loop checks: `Math.abs(a.amountCents) !== Math.abs(b.amountCents)` and `a.amountCents === 0` are invariants of the bucket, not the pair.
- `src/app/budget/[year]/[month]/page.tsx` — raw `<table>` / `<thead>` / `<tbody>` / `<tr>` / `<th>` / `<td>` → shadcn `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell`. Track A's "no TanStack" decision preserved; this is the shadcn primitive, not DataTable. The `MobileCards` stacked-cards path (sm:hidden) is unchanged.
- `src/app/categorize/_merchant-row.tsx` — native `<select>` → `CategoryCombobox`. Same form, same action, same Sonner Undo toast.
- `src/app/transactions/_transaction-row.tsx` — same swap as above. iOS autozoom fix (`text-base sm:text-sm`) now inherited from the shared wrapper's ComboboxInput.
- `TODOS.md` — Weekend 2 scope-guardrails: "shadcn components locked" box is now `[x]` with a note recording that DataTable was intentionally ruled out in favor of the `Table` primitive; the mobile-cards + parens-for-negatives boxes marked `[x]` with anchor references.

### Added
- Scaling test: 500 unrelated same-day rows + 1 real pair → 1 pair found, no noise.
- Zero-amount test: two zero-amount rows across accounts produce no pairs.
- **shadcn primitives** (added via `shadcn add`, base-nova style, Base UI variant):
  - `src/components/ui/table.tsx` — used on `/budget/[year]/[month]`.
  - `src/components/ui/combobox.tsx` — used by the shared `CategoryCombobox` wrapper.
  - `src/components/ui/input-group.tsx`, `input.tsx`, `textarea.tsx` — pulled in as Combobox dependencies.
- **Shared picker** (`src/components/CategoryCombobox.tsx`):
  - Wraps Base UI's Combobox with the `{value: string, label: string}` shape that both inline categorize rows need. `value={value || null}` so a cleared selection round-trips, `itemToStringLabel` maps id → category name for the input display, `required` / `disabled` pass-through. Name-bearing hidden input keeps FormData submission working unchanged.

### Notes
- All 286 tests pass (27 files). No behavior change for any existing fixture. TODOS.md P2 closed.
- Shipped via `/ship`. Coverage scope unchanged from v0.4.0: pure functional + DB-query tier (284 tests across 27 files, identical to v0.4.0). UI components not tested; the three touched pages verified by live browser smoke test including an end-to-end category select → submit → DB write on a seeded row.
- One pre-landing review fix applied inline before commit: `CategoryCombobox` was passing the full `{value, label}` object as `ComboboxItem.value`, which made Base UI fire `onValueChange` with the object. The wrapper's `typeof next === "string" ? next : ""` guard silently reset selection to empty on every click, so Save stayed disabled. Caught during browser smoke test (not the PLAN source's claim that "browser smoke: all render without console errors"). Fixed by passing `item.value` (string id) as `ComboboxItem.value` and adding `itemToStringLabel` so Base UI resolves the id back to the display label in the input.

### Verified
- Vitest suite: **286 tests across 27 files** — all green on Node 24.
- `tsc --noEmit` clean.
- `pnpm lint` clean (only pre-existing `@typescript-eslint/no-unused-vars` warning in `loadMonthView.test.ts`, unrelated).
- Live browser smoke on seeded test transaction:
  - `/transactions`: open combobox → select "Groceries" → hidden `categoryId` input holds `"2"`, visible input displays `"Groceries"`, Save enables, click Save → Sonner toast "Categorized 1 row as Groceries." + 10s Undo → DB confirms `category_id=2` on the row.
  - `/categorize`: same flow with "Dining" → hidden value `"4"`, visible label `"Dining"`, Save enables.
  - `/budget/[year]/[month]`: table renders via shadcn primitive, no console errors at 390px (cards) or 1280px (table).

### Fixed (pre-landing review)
- `CategoryCombobox` was silently discarding every selection because `ComboboxItem` received the `{value, label}` item object while the wrapper only accepted string values through `onValueChange`. Base UI's `store.state.handleSelection(event, itemValue)` fires `onValueChange` with whatever `ComboboxItem.value` is set to (confirmed by reading `@base-ui/react` internals at `esm/combobox/root/AriaCombobox.js:533` and `esm/combobox/item/ComboboxItem.js:126`), so the wrapper's `typeof next === "string" ? next : ""` fallback always evaluated to `""` and the submit button stayed disabled on every click. Fixed by (a) passing `item.value` (string id) to `ComboboxItem`, and (b) adding `itemToStringLabel={(v) => labelFor(String(v))}` on the Combobox root so the input shows the category name instead of the raw id. Hidden-input serialization via `stringifyAsValue` still submits the id unchanged — the FormData contract with every Server Action is preserved.

### Project decisions (non-code, worth logging)
- **Shared `CategoryCombobox` over duplicating the Combobox boilerplate twice**: the `/categorize` and `/transactions` pickers share the exact same leaf-category set and the same FormData key (`categoryId`), so a single wrapper keeps the Base UI wiring (controlled `value`, `items`, `itemToStringLabel`, cleared-selection `null` coercion) in one file. Also makes the pre-landing fix a one-line change across both call sites.
- **Table primitive, not DataTable**: the plan called out "no TanStack" and Track A shipped its own server-rendered table. Swapping to shadcn `Table` keeps that decision while still giving us consistent borders, spacing, and hover tokens.

### Known follow-ups (tracked in TODOS.md)
- Carry-forwards from earlier ships (P2 TOCTOU on `createOrUpdateRule`, P3 ReDoS on user-authored regex rules, P3 undo-rule-delete edge case, P2 `linkTransferPairs` O(n²)-within-day) are unchanged by this ship.

## [0.4.0] - 2026-04-17

_Weekend 2 Track B complete — `/transactions` is live. You now have a filtered, paginated list of every non-transfer-paired transaction with an inline category picker, "Remember for all [merchant]" to silently upsert the exact rule, and "Apply to past [merchant]" to fan the chosen category out to every uncategorized sibling. Each Save fires a 10s Sonner Undo that atomically reverses the target row, the applyToPast hits, AND any rule change, all while preserving rows the user has re-touched since. `/budget` and `/categorize` now share the same rollover-invalidation story across the Track A/B/C + D surfaces._

### Notes
- Shipped via `/ship`. Coverage scope unchanged from v0.3.0: pure functional + DB-query tier (225 tests across 22 files, +41 over v0.3.0). UI components not tested; `/transactions` verified by live browser smoke test.
- Three pre-landing review fixes applied inline before commit: `undoCategorizeTransactionAction` is now Zod-gated against a new `categorizeTransactionSnapshotSchema` (CLAUDE.md rule: every Server Action must validate at the boundary); `categorizeTransaction`'s parent + savings-goal + category-exists preconditions now run inside the same `db.transaction(...)` as the writes (closes a narrow race window); `loadTransactions` wraps its `COUNT(*)` + paginated SELECT in a read transaction so pagination math cannot drift under a concurrent categorize write.
- Known cosmetic: after "Apply to past" fires, sibling rows on the same page keep their "Uncategorized" badge until reload — each row owns its own `useState` seeded at mount. The live backlog counter is correct. Tracked separately.

### Added
- **`/transactions` page** (`src/app/transactions/page.tsx`):
  - Server Component. `await connection()` + Zod `searchParamsSchema` gated by `notFound()` on tamper (matches `/budget/[year]/[month]`).
  - Filter params: `categoryId=<leafId>|none`, optional `year`+`month` (both-or-neither), `page`, `pageSize` (clamped 1–500).
  - Entry points: from a `/budget` row (drilldown) or standalone (no filter, newest first).
- **Transaction query layer** (`src/lib/categorize/loadTransactions.ts`):
  - Paginated read; transfer-paired rows excluded unconditionally via `isNull(transferPairId)`.
  - Sort: `date DESC, id DESC` (stable tiebreaker). Joins: `leftJoin(categories)` for display name, `innerJoin(accounts)` for account name.
- **Single-row categorize pipeline** (`src/lib/categorize/categorizeTransaction.ts`):
  - Server-trust: `normalizedMerchant` is read from the target row, NOT from FormData. A tampered applyToPast can't broadcast across merchants.
  - Dual-invalidation pattern: new category invalidated starting at `earliest(target.date, earliestApplyToPastDate)` month; old category invalidated at `target.date` month (only when the row had a prior category).
  - applyToPast scope: `categoryId IS NULL AND id != target.id AND transferPairId IS NULL`. Matches Track C semantics.
- **Undo** (`src/lib/categorize/undoCategorizeTransaction.ts`):
  - Snapshot-based reverse inside a single `db.transaction`. Re-touch guard: both target + applyToPast UPDATEs filter `WHERE categoryId = newCategoryId`, so rows the user has since re-categorized are preserved.
  - 3-case rule rollback (no prior rule → delete, prior → full restore). Mirrors Track C's rule rollback.
- **Zod validators**:
  - `src/lib/categorize/validateCategorizeTransactionInput.ts` — FormData coercion, strings → numbers/booleans.
  - `src/lib/categorize/validateCategorizeTransactionSnapshot.ts` — new this ship, guards `undoCategorizeTransactionAction` against client-supplied snapshot payloads.
- **Client islands**:
  - `src/app/transactions/_transactions-ui.tsx` — sticky `aria-live` backlog strip, empty state, pagination.
  - `src/app/transactions/_transaction-row.tsx` — inline select + Remember/Apply-to-past checkboxes + Sonner 10s Undo toast. iOS autozoom fix (`text-base sm:text-sm`) on the select.
- **Server Actions** (`src/app/transactions/actions.ts`):
  - `categorizeTransactionAction` — Zod-gates input, returns snapshot + updatedCount + categoryName.
  - `undoCategorizeTransactionAction` — Zod-gates the snapshot, idempotent reverse. Both revalidate `/transactions`, `/categorize`, and the `/budget` layout.
- **Mandatory regression guard** (`src/lib/categorize/categorizeTransaction.regression.test.ts`):
  - The Track B review's must-pass test: categorize flips `/budget` MTD on the new category, invalidates May's rollover cache, and Undo cleanly reverses both plus the target row.
- **Shared helper** (`src/lib/budget/monthOfIso.ts`):
  - Extracted `parseIsoMonth(dateIso)` out of `bulkCategorize` so `categorizeTransaction` uses the same primitive.

### Verified
- Vitest suite: **225 tests across 22 files**, all green on Node 24. (+41 over v0.3.0: core/undo/validator/loader/regression/action suites.)
- `tsc --noEmit` clean.
- Live browser: seeded 3 uncategorized SAFEWAY rows, categorized one with "Apply to past" ticked → 2 additional rows flipped, Sonner toast shown with Undo, Undo restored all three rows + cleared the rule.

### Fixed (pre-landing review)
- `undoCategorizeTransactionAction` was accepting the snapshot without validation. A crafted payload could have flipped any row matching a chosen category back to a caller-supplied prior, and forced `invalidateForwardRollover` on arbitrary (category, year, month) combos. Now Zod-validated against `categorizeTransactionSnapshotSchema` before the reverse fires.
- `categorizeTransaction`'s `CategoryNotFoundError` / `SavingsGoalCategoryError` / `ParentAllocationError` pre-flight checks were SELECTing outside the write transaction. Between those reads and the UPDATE, a concurrent write could have flipped the category shape. Moved both lookups inside the `db.transaction(...)`.
- `loadTransactions` was running `COUNT(*)` and the paginated SELECT in separate DB calls. A concurrent categorize between them could produce off-by-one `totalPages` / `firstRow` / `lastRow` relative to the returned rows. Both queries now share one read transaction.

### Project decisions (non-code, worth logging)
- **Server-trust on merchant**: the target row's stored `normalized_merchant` is the source of truth for Apply-to-past. Never read from FormData. Prevents cross-merchant fanout via a tampered form.
- **Transfer-paired rows stay hidden on `/transactions`**: they're owned by the transfer machinery. `loadTransactions` filters them out server-side and `categorizeTransaction` additionally refuses them as defense-in-depth.
- **Undo is idempotent by design**: a user who re-categorizes a row between Save and Undo keeps their new choice. Both target and applyToPast UPDATEs filter on the snapshot's `newCategoryId`.
- **Re-categorize support**: a row that already has a category can be flipped to a different leaf. Dual-invalidation fires on both the old and new category's month chains.

### Known follow-ups (tracked in TODOS.md)
- **P0** — `parseCsv.test.ts` fails at test-load time with ENOENT on a gitignored fixture path. Pre-existing, not caused by this ship. Either bundle a safe fixture or guard the test with `describe.skipIf`.
- **Cosmetic** — sibling rows hit by Apply-to-past keep their "Uncategorized" badge until reload (each row form owns its `useState` seeded at mount). Backlog counter is correct; server round-trip would fix it but cost an extra render. Deferred.

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
- **Rule engine** (`src/lib/rules.ts`): `applyRuleAtImport` + `createOrUpdateRule` (idempotent upsert). **Correction:** this entry originally described `applyRuleAtImport` as auto-categorizing during commit. It did not — the function was written and tested but never called from either write path, so every import landed uncategorized until that was wired up (see Unreleased).
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
