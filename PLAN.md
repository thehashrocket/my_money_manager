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

## Current status (2026-09-02)

All five weekends shipped, plus the automated sync that follows them. The app runs end-to-end in a real browser: transactions arrive from `/sync` (or `/import` for older history) → categorize → `/budget` envelope view with live allocate → dashboard, subscriptions, goals and the 6-month trend chart.

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
- v0.8.0 ship-review follow-ups: re-pointing a SimpleFIN link orphans `external_id`s, `syncNowAction` drops the sync warnings, and the sync test gaps
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
| SimpleFIN credentials | `SIMPLEFIN_ACCESS_URL` in `.env.local` (gitignored; written by `pnpm simplefin:claim`) |
