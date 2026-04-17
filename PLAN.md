# Plan — my_money_manager

Local-first, single-user budgeting app. CSV import from Star One CU. No cloud, no auth, no Plaid.

The canonical design doc lives at `~/.gstack/projects/thehashrocket-my_money_manager/jasonshultz-thehashrocket-budgeting-app-design-20260416-173405.md` (APPROVED). This file is the in-repo roadmap; it does not duplicate the design doc.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind v4 · shadcn/ui · better-sqlite3 · Drizzle ORM · Vitest · pnpm · Node 24

## Timeline

4-5 weekend sessions over 5-6 calendar weeks.

| # | Focus | Status |
|---|-------|--------|
| W1 | Scaffold + CSV import end-to-end (sign correction, transfer detection, dedup) + HMR smoke test | done |
| W2 | Budget views + hybrid categorization (auto-learn + manual rules) + integration checkpoint (use on real data for 1 week) | not started |
| W3 | Dashboard + Uncategorized backlog tile + merchant normalization refinement | not started |
| W4 | Subscriptions tracker — **cut-line** if behind (keep goals instead) | not started |
| W5 | Goals / savings + Recharts trend chart | not started |

## Current status (2026-04-16)

Weekend 1 complete. Import pipeline works end-to-end in a real browser:
- Real CSV data analyzed (checking + savings, 90 days, 652 rows combined)
- Six-table Drizzle schema + migration landed; HMR-safe DB singleton in place
- Pure-function tier shipped with Vitest coverage: merchant normalizer (12 rules), row-hash, Star One CSV parser, memo-independent transfer-pair matcher
- Snapshot + import orchestrator: `commitImport` snapshots the DB, inserts batch + rows in a single transaction, then links transfer pairs
- Upload/preview/confirm UI in the App Router using Server Actions; confirm flow verified live (543 rows committed, snapshot written, redirect to success page)
- Star One CU memo-labeling quirk logged as a durable project memory
- 45 Vitest tests pass, `tsc --noEmit` clean, 10-reload HMR smoke test passes

Next up (see [TODOS.md](./TODOS.md)):
- Weekend 2: budget periods UI (envelope cards), hybrid categorization (auto-learn + priority-50 manual rules), Uncategorized backlog tile
- **Integration checkpoint** before W3: use the app on real data for 1 week

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
