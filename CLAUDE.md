@AGENTS.md

# my_money_manager — project guide for AI agents

Local-first, single-user personal budgeting app. CSV import from Star One CU (checking + savings). No cloud, no auth, no Plaid. The whole point is that **the user owns every sign on every row**.

Read `.context/notes.md` first. It is the source-of-truth index for design artifacts.

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript + React 19
- Tailwind v4 + shadcn/ui (base-nova style, Base UI primitives)
- better-sqlite3 + Drizzle ORM (`./data/money.db`, gitignored)
- Vitest for categorization/parser tests
- pnpm, Node 24 (pinned via `.nvmrc`, enforced via `engines` + `engine-strict`)

No Recharts yet — it lands in Weekend 5 with the trend chart. Envelope cards are plain CSS.

Wrong-Node symptom: any `pnpm` command fails with `ERR_PNPM_UNSUPPORTED_ENGINE` (blocked by `engines` + `engine-strict=true`). Run `nvm use` in the workspace to pick up `.nvmrc`. If you bypass pnpm (e.g., invoke `vitest` directly on Node 22), `better-sqlite3` crashes with a `NODE_MODULE_VERSION` mismatch because its native binding is built against Node 24.

## Layout

```
src/
  app/             Next.js 16 App Router pages + server actions
  app/_components/ Shared RSC components co-located with the app (e.g. BacklogBanner)
  components/      UI components (shadcn in components/ui, ledger/ design-system components)
  db/              Drizzle schema + client singleton
  lib/             Pure functions: parsers, normalizer, categorization, money, utils
  lib/accounts/    loadAccountBalances — live per-account balance queries
  lib/budget/      loadMonthView, upsertAllocation, validateAllocateInput
  lib/categorize/  Bulk-categorize logic and validators
  lib/import/      Import orchestration and validators
  lib/simplefin/   Automated sync: client, mapping, bucket transfer matcher, undo
drizzle/           Migration output (committed)
data/             money.db + pre-import snapshots (gitignored)
.context/         Design artifacts, CSV samples, deltas (gitignored)
design_handoff_nav_and_design_system/  Live HTML design specimens + README
```

## Scripts

- `pnpm dev` — start dev server (localhost:3000, this IS the app)
- `pnpm test` / `test:watch` / `test:ui`
- `pnpm db:generate` — generate Drizzle migration from `src/db/schema.ts`
- `pnpm db:migrate` — apply pending migrations
- `pnpm db:studio` — Drizzle Studio GUI
- `pnpm simplefin:claim` — one-time: exchange a SimpleFIN setup token for an access URL (writes `.env.local`)
- `pnpm simplefin:sample` — dump a live `/accounts` payload to `.context/simplefin-sample.json` for analysis

## Core rules baked into the data model

These are load-bearing. Violating them corrupts the database.

1. **All money is stored as signed integer `amount_cents`.** Never floats. Never a separate sign column. Withdrawals are negative. Deposits are positive. Balance = `starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)`.

2. **The CSV's signs are already correct.** `Amount Debit` is pre-negative, `Amount Credit` is positive, mutually exclusive. Parser rule: `debit ? debit*100 : credit*100`. No `Math.abs`, no negation by `Description`. The Plaid bug happens because Plaid transforms the data; this app doesn't.

3. **Dedup key is `(account_id, import_batch_id, import_row_hash)`**, never the bank's `Transaction Number`. Star One reuses `6098` as a pending-deposit placeholder across rows. `import_row_hash = sha1(date | amount_cents | raw_description | raw_memo | row_index_in_source_file)`.
   **SimpleFIN rows dedup on `external_id` instead** — the feed's own per-account transaction id, enforced by a partial unique index on `(account_id, external_id)`. There is no row index in a JSON feed, so `import_row_hash` is derived from the external id. Because the feed re-sends days already imported from CSV, sync ALSO dedups on a content signature (`date|amount_cents|raw_memo`) counted as a multiset, so two genuinely identical same-day coffees still both survive.

4. **Transfer pair matcher is MEMO-INDEPENDENT.** Two rows are a transfer pair iff: `|txn_a - txn_b| == 1` AND same date AND `|amount_a| == |amount_b|` AND opposite signs AND different accounts. Star One labels the receiving-side memo correctly only 20% of the time; the other 80% it mislabels with the triggering merchant. Memo is confirmation-only, never disqualifying. See `memory/project_star_one_cu_overdraft_labeling.md`.
   **This rule is CSV-only.** The SimpleFIN feed carries no transaction number and no `extra{}`, so `src/lib/simplefin/matchTransfers.ts` replaces it with a counting argument: bucket by `(date, |amount|, opposite sign, cross-account)`, and when a bucket holds N positives and N negatives, every bijection excludes the same rows from spending — so link it without asking. Only unbalanced buckets need a human. Two refinements matter and are both load-bearing: ATM cash withdrawals are excluded from candidacy (they collide on the round amounts sweeps use), and counts are compared **per account-pair direction**, never globally (a charge in the same account as an inbound sweep is the purchase that triggered it, not a candidate for it). Measured on real data: 56 pairs auto-link, ~1 undecidable day per 90.

5. **Every batch import writes a DB snapshot first.** Copy `data/money.db` to `data/money.db.pre-import-{timestamp}` before any write. Rollback = stop dev server, swap file. Keep last 10 snapshots. Sync does this too, and additionally supports a logical undo (delete the batch's rows) that works without stopping the server — the file snapshot stays as the escape hatch.

6. **Uncategorized transactions have `category_id = NULL`** and surface in the dashboard backlog tile. The "Uncategorized" seed category is for manual overrides; NULL is the default for unmatched rows.

## Conventions

- Dates stored as ISO `YYYY-MM-DD` text. Timestamps as Unix seconds (`integer` with `mode: 'timestamp'`).
- Booleans as `integer` with `mode: 'boolean'`.
- Enum-like text columns use `text('col', { enum: [...] })` so Drizzle type-narrows.
- Foreign keys: always declare `references(() => ...)` on the column. Use `onDelete: 'restrict'` by default; explicit `'cascade'` where it makes sense (e.g. `category_rules` → `categories`).
- Merchant normalization is a pure function in `src/lib/normalize.ts`. Tested in isolation. 12 rules total (8 checking + 4 savings). See `.context/csv-format.md`.
- Subscription detection excludes rows where `raw_description = 'DEPOSIT'` or `raw_memo` starts with `POS ` + digits (those are refunds, never recurring).

## Automated sync (SimpleFIN)

`/sync` pulls posted transactions from Star One via SimpleFIN and writes them straight in — no preview step — behind a pre-write snapshot and a per-batch undo. Credentials live in `SIMPLEFIN_ACCESS_URL` in `.env.local` (gitignored); only the host is ever safe to display.

Constraints that are properties of the feed, not choices:

- **Never more than ~45 days of history.** SimpleFIN hard-caps at 90 days and warns above 45. CSV import stays the only path to anything older — it is not legacy.
- **No pending transactions.** Star One via MX exposes posted rows only, so there is no insert-then-update path to write. Pending activity is visible only as the gap between `balance` and `available-balance`.
- **Accounts must be linked explicitly** (`accounts.simplefin_account_id`). The feed also returns a mortgage, which the `checking|savings` enum does not model; unlinked means never imported.
- **`description === memo` on every row**, so `raw_description` has no source field and is derived from the sign. This keeps the subscription-detection exclusion on `raw_description = 'DEPOSIT'` working.
- Amounts are decimal strings — parse via `parseAmountToCents` (string math), never `parseFloat(x) * 100`.
- `normalizeMerchant` needs no SimpleFIN-specific rules: the feed's `description` is byte-identical in shape to the CSV `Memo` column, so trained `category_rules` keep matching. MX's cleaned `payee` is persisted to `transactions.payee` for display only — categorization keys on `normalized_merchant`, never on `payee`, or every trained rule would break. NULL on CSV rows.

## What's NOT in V1 — do not add

Credit cards. Auth. Cloud sync. Multi-currency. Bill pay. Investment tracking. Tax features. Split transactions (one category per transaction; override wins). Retroactive goal target edits. YNAB-style overspend-shuffle. Deployment. Tests for UI components (categorization logic only).

CI (lint + test + build on PR) is in via `.github/workflows/ci.yml` — gates merges into `main`.

## Next.js 16 gotchas

This version has breaking changes from training-data-era Next.js. Read the relevant guide in `node_modules/next/dist/docs/01-app/` before touching anything in `src/app/`. In particular: Server Actions, `params`/`searchParams` as Promises, caching defaults, and `next.config.ts` options all shifted.

For the better-sqlite3 + HMR case: wrap the DB client in a `globalThis`-cached singleton (standard pattern for native deps). End-of-Weekend-1 smoke test is "10 HMR reloads, DB still connects."

## When in doubt

1. Read `.context/notes.md` → design artifacts index.
2. Read `.context/csv-format.md` → real-data-derived parser rules.
3. Read `.context/design-updates.md` → deltas to the canonical doc (Updates 1–5).
4. The canonical design doc is at `~/.gstack/projects/thehashrocket-my_money_manager/jasonshultz-thehashrocket-budgeting-app-design-20260416-173405.md` (outside the repo — don't duplicate into `docs/`).

## GBrain Search Guidance (configured by /sync-gbrain)
<!-- gstack-gbrain-search-guidance:start -->

GBrain is set up and synced on this machine. The agent should prefer gbrain
over Grep when the question is semantic or when you don't know the exact
identifier yet.

**This worktree is pinned to a worktree-scoped code source** via the
`.gbrain-source` file in the repo root (kubectl-style context). Any
`gbrain code-def`, `code-refs`, `code-callers`, `code-callees`, or `query`
call from anywhere under this worktree routes to that source by default —
no `--source` flag needed. Conductor sibling worktrees of the same repo
each have their own pin and their own indexed pages, so semantic results
match the actual code on disk in this worktree.

Two indexed corpora available via the `gbrain` CLI:
- This worktree's code (auto-pinned via `.gbrain-source`).
- `~/.gstack/` curated memory (registered as `gstack-brain-<user>` source via
  the existing federation pipeline).

Prefer gbrain when:
- "Where is X handled?" / semantic intent, no exact string yet:
    `gbrain search "<terms>"` or `gbrain query "<question>"`
- "Where is symbol Y defined?" / symbol-based code questions:
    `gbrain code-def <symbol>` or `gbrain code-refs <symbol>`
- "What calls Y?" / "What does Y depend on?":
    `gbrain code-callers <symbol>` / `gbrain code-callees <symbol>`
- "What did we decide last time?" / past plans, retros, learnings:
    `gbrain search "<terms>" --source gstack-brain-<user>`

Grep is still right for known exact strings, regex, multiline patterns, and
file globs. Run `/sync-gbrain` after meaningful code changes; for ongoing
auto-sync across all worktrees, run `gbrain autopilot --install` once per
machine — gbrain's daemon handles incremental refresh on a schedule.

<!-- gstack-gbrain-search-guidance:end -->
