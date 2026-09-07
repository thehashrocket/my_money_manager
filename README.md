# my_money_manager

Local-first, single-user personal budgeting app for Star One Credit Union (checking + savings), plus the credit cards and loans you owe on. Transactions arrive on their own over SimpleFIN, or from a CSV export when you need older history. Categorize them, track envelope-style budgets, watch your net worth, and keep every row on your own machine instead of handing it to Plaid or a cloud service.

**Status:** v0.17.0. Merchant names finally group. A reference number, a timestamp or a city stuck on the end of a bank memo used to make every purchase look like a brand-new merchant — 516 different names for 1540 transactions. The normalizer now splits payment processors (`SQ *`, `TST *`) from the merchant behind them, strips known cities and store numbers, and keeps cleaning until the name stops changing, which brought that to 363 names and cut one-off merchants from 354 to 222. Google One and YouTube Premium are separate merchants again instead of sharing one "GOOGLE" bucket that spanned two categories, Amazon Prime stays separate from ordinary Amazon orders, and a store name the bank truncated mid-word (`TAPPED APPLE LL`) no longer loses its last two letters to a state-code strip. Because the merchant name is stored on each row at import time, changing the normalizer leaves your ledger a generation behind the code: `pnpm db:backfill-merchants` closes that gap, renormalizing every row and rewriting the categorization rules you have already trained so they keep firing. It dry-runs by default, snapshots before it writes, and refuses outright when two rules would merge while disagreeing about the category.

v0.16.0: credit cards and loans are real account types — the app has always tracked what you have, and this is the first release that tracks what you owe and puts the two together into a net worth figure. A new `/accounts` page (second in the nav) lists assets and liabilities as ruled lists, with a `Cash` subtotal, a `Debt` subtotal, and net worth closing it; a card row shows how much of its limit is used, when its balance was last confirmed, and how much you paid down this month. You enter what you owe as a positive number and never type a minus sign anywhere in the app — the balance is stored negative, which is what lets every existing balance, transfer-pair, and spending query keep working unchanged. A card's balance moves three ways: **Reconcile** (set what it actually owes today), a hand-entered charge or refund (categorized, so card spending counts toward its envelope in the month you spent it), and marking the checking-side payment as a **card payment** from the `/transactions` row menu, which pairs the two so it counts as neither spending nor income. Feed-linked accounts with no transactions of their own get **Refresh** instead, pulling the balance straight from the bank. Every balance change records the one it replaced and can be undone — and the undo is itself undoable. A mortgage is deliberately quiet: it counts toward net worth, keeps a balance control so it stays correctable, and otherwise stays out of the way. Also new: a **"Closest to limit"** tile on the dashboard (the five categories nearest to spending their budget, worst first), a **show-transfers toggle** on `/transactions`, and `DESIGN.md`'s 4/8/12/16/20/28/40/56 spacing cadence finally applied app-wide across 37 files instead of the 24px shadcn cadence it tells you to avoid.

`/transactions` has a real filter bar: search by description/merchant/payee, narrow to one account or category, pick an arbitrary date range (replacing the old one-month-at-a-time picker) with a "This month" quick-select, filter by amount range regardless of deposit/withdrawal sign, and show posted-only, pending-only, or everything — filters compose and survive pagination. `/budget`'s category drilldown links were updated to match (they used to jump into that new date-range filter with the old month-picker params, which silently widened to "every transaction ever" instead of erroring). `/budget/[year]/[month]` is a real zero-based (EveryDollar-style) budget: categories have a `kind` (income/expense/fund), every planned-amount cell is editable in place with instant save, "Copy previous month" fills the whole month in one click, and categories can be created, renamed, reorganized, archived, and (in one narrow, evidence-backed case) reclassified from expense to income — all without leaving the page; unarchiving is the one exception, handled from its own `/budget/categories` page. The page also has an in-page "How this page works" reference — a collapsible glossary (closed by default, same native `<details>`/`<summary>` pattern as `/goals`) explaining the envelope-budgeting model and each Left to Budget state, hidden on a genuine first-run month so it never stacks with the onboarding card. Dashboard, bulk categorization, subscriptions, goals and the 6-month trend chart all ship too. `/sync` pulls posted transactions straight from the bank, and its balance check now tells real drift from a stale bank figure instead of flagging both the same way; `/import` still handles anything the feed's 45-day window no longer reaches, and can now fix a wrong starting-balance anchor inline — the anchor move itself is now atomic with the import, bounds-checked against calendar-invalid dates (now enforced on every imported row's date, not just the anchor), and reversible from the import success page, whose "transfer pairs linked" count is now accurate even when a pending row posts via re-import rather than a fresh insert. Transfer-pair matching no longer selects a still-pending row as a match, and a "Not a transfer" correction now sticks instead of being silently reversible by a later unrelated import. Auto-categorization at import time (CSV or sync) can now be undone per-batch, reverting just the categorization without discarding the rest of the import. The app also runs in Docker now (still on SQLite — see the [Docker](#docker) section below). See [PLAN.md](./PLAN.md) and [CHANGELOG.md](./CHANGELOG.md).

## Stack

- **Next.js 16** (App Router + Turbopack) · **React 19** · **TypeScript**
- **Tailwind v4** · **shadcn/ui** (base-nova style, Base UI primitives)
- **better-sqlite3** + **Drizzle ORM** — local SQLite file at `./data/money.db`
- **Recharts** for the dashboard trend chart (client-side only)
- **Vitest** for parser/categorization/sync/accounts unit tests · GitHub Actions runs lint + test + build on every PR
- **pnpm** · **Node 24** (pinned via `.nvmrc`)

No auth. No Plaid. No cloud — this runs on your machine (or your own Docker host), and your ledger never leaves it. The one outbound call the app makes is a read-only pull from SimpleFIN, and what comes back is written to the local SQLite file.

## Getting started

```bash
nvm use                 # picks up Node 24 from .nvmrc
pnpm install
pnpm db:migrate         # applies Drizzle migrations to ./data/money.db
pnpm dev                # http://localhost:3000 → dashboard
```

### Docker

An alternative to `pnpm dev`, still on SQLite — no Postgres yet (see `docs/plans/dockerize-postgres.md`). The ledger lives in a named Docker volume rather than `./data`, so it isn't directly visible on the host; use the scripts below rather than reaching into the volume.

```bash
sudo mkdir -p backups && sudo chmod 777 backups  # Linux only, and only before the FIRST run — see note below
pnpm db:seed-volume            # first run only, BEFORE `docker compose up` — copies ./data/money.db
                                # into the volume so the container doesn't start with an empty ledger
docker compose up -d           # http://127.0.0.1:3000 — bound to loopback only, this app has no auth
```

On real Linux hosts, Docker auto-creates a missing `./backups` bind-mount directory as root-owned, which the container's unprivileged user can't write to. The `mkdir`/`chmod` step must come **before** `db:seed-volume` — `db:seed-volume` starts a container of its own to verify the seed, which would otherwise race Docker into auto-creating `./backups` as root first. `chmod` rather than `chown`ing to a specific user: both the container (writing snapshots) and `pnpm db:export` running on the host (copying them out) need write access to the same directory, and they run as different users. Not needed on macOS Docker Desktop, whose bind-mount layer doesn't have this issue.

`.env.local` is optional: SimpleFIN sync degrades to a configuration banner without it, and CSV import works either way. `TZ` is required (`compose.yaml` sets `America/Los_Angeles`; the container refuses to boot without one, since the app derives the current budget month from local time).

| Command | What it does |
|---|---|
| `pnpm db:export` | Snapshot the running container's ledger out to `./backups/` |
| `pnpm db:import <file>` | Stop the container, restore a snapshot file, restart |
| `pnpm db:seed-volume` | One-time host → volume copy (run before the first `docker compose up`) |
| `pnpm db:backfill-merchants` | Bring stored merchant names in line with the current normalizer, and rewrite the trained rules that key off them. Dry run by default; `--apply` snapshots first and writes in one transaction. Runs inside the container, so rebuild the image (`docker compose build && docker compose up -d`) after a normalizer change before running it |

Create an account (name, type, balance + date) from `/import` — checking, savings, credit card, or loan. A card or a loan asks for the **balance owed** as a positive number, and a card can carry a credit limit and a minimum payment; a loan carries neither, on purpose. Liabilities have no transaction feed, so the rest of this section is about the two accounts that do. Debt lives on [`/accounts`](#accounts-and-net-worth) instead.

### Automated sync (the normal path)

```bash
SIMPLEFIN_SETUP_TOKEN=<token from simplefin.org> pnpm simplefin:claim
```

That runs once. It exchanges the setup token for a long-lived access URL and writes `SIMPLEFIN_ACCESS_URL` to `.env.local` with owner-only permissions — the URL carries your credentials, so it is gitignored and only its host is ever displayed.

Then open `/sync`, pick which remote account each local account maps to, and hit **Sync now**. Posted transactions are written straight to the ledger — no preview step — behind a database snapshot taken first. The page also shows:

- **Balance check** — the bank's balance next to the one this ledger computes. A difference is only flagged as a real drift once the bank's own figure is dated after your newest ledger row; a same-day, older, or dateless bank figure shows as unconfirmed instead, alongside its as-of date, since it may just not have caught up yet. Available balance is listed separately; that gap is where pending card holds live.
- **Transfers needing review** — the rare same-day, same-amount transfer the matcher can't resolve by counting. Pick the two halves yourself.
- **Linked transfers** — what got paired automatically, each with a **Not a transfer** button. Pairing hides both rows from every spending view, so this is the way back out when a same-day, same-amount coincidence gets linked by mistake. The correction sticks: an unrelated later import landing on the same date can't silently re-link the same two rows, though either one can still pair correctly with a genuinely different match afterward.
- **Undo this sync** — deletes the last batch's rows and the batch itself, no dev-server restart needed. Only offered while that sync is still the newest import of any kind — a CSV import landed afterward can end up relying on one of its rows, so undo refuses once that's happened rather than deleting silently. The pre-write snapshot stays as the escape hatch.
- **Undo just the auto-categorization** — when a sync batch had rows auto-categorized by a trained rule, this page links to `/import/success/[batchId]` to revert just those categorizations, leaving the transactions (and any you've since hand-recategorized) alone. Use this instead of the full sync undo when only a rule's category choice was wrong.

A sync also moves the balance of any linked liability that has no transactions of its own — the mortgage, in practice — without importing a row for it. That gets reported in the sync result ("Balance updated: …") even on a sync that imported nothing, so an anchor never moves quietly behind an "Already up to date" message.

SimpleFIN caps history at 90 days — the feed says so itself when you ask for more. Sync halves that to 45 as its own conservative limit, so anything older has to come from a CSV import; that is a property of the feed, not a missing feature. The feed also returns only posted rows, and sync refuses to write a pending one if it ever appears: there is no way to update a row once it posts, so it would freeze a pre-authorisation amount and duplicate the real charge.

### CSV import (older history)

Upload a Star One CSV export at `/import`. The preview shows row counts, duplicates, pending rows, and errors; clicking **Confirm import** snapshots the DB, inserts the batch inside a transaction, and links transfer pairs across accounts. If the snapshot degrades to a plain file copy, the import still completes, but the success page shows a warning instead of silently trusting it as a working rollback point. This is the only way to load anything the feed no longer carries.

Each **asset** account on `/import` also has an inline "start [balance] on [date]" form — the way to fix a starting-balance anchor that was set wrong (or left at the created-with-$0 default), since a CSV import can only ever move the anchor forward, never correct a too-late one. The date is capped at today. That form takes a *signed* balance with no relabelling, so it is deliberately closed to cards and loans (server-side, not just hidden): a liability's anchor is only ever moved from `/accounts`, where the wording and the sign flip are handled for you. CSV import refuses a liability target for the same reason.

Rows a trained rule auto-categorizes on the way in (from either CSV import or sync) can be undone independently of the import itself: when the success page has revertible rows, an "Undo auto-categorization" button reverts just those categorizations — a transaction you've since hand-recategorized is left alone even if it landed back on the same category a rule chose.

Optional: `pnpm simplefin:sample` dumps a live account payload to `.context/simplefin-sample.json` when you want to inspect what the feed actually returns.

### Accounts and net worth

`/accounts` is where debt is managed. Assets and liabilities are two ruled lists, with a `Cash` subtotal, a `Debt` subtotal, and net worth on the bottom line. The page renders whether or not you have any debt yet.

A credit card carries a credit limit and a minimum payment, both editable after the fact, and its row shows utilization against that limit, when the balance was last confirmed, and how much you paid it down this month. Four things move a liability's balance. Reconcile and Refresh are mutually exclusive — a row offers exactly one of them, never both and never neither — while the other two are card-only and sit alongside whichever it got:

- **Reconcile** — type what the liability actually owes today, as a positive number. The normal way a card's balance moves, and the only way for any liability that isn't feed-linked — including a car loan.
- **Refresh** — pull the balance straight from the bank feed. Offered only where it can work: a feed-linked account with no transactions of its own, which in practice means the mortgage. It refreshes balances only; it does not import transactions.
- **Add a charge** (or a refund) — a hand-entered, categorized transaction, so card spending counts toward its envelope in the month you spent it. A charge dated on or *before* your last reconcile is refused, because that reconcile already includes it and counting it again would be spending that never moved the balance; the refusal hands you to Reconcile instead.
- **Mark a transaction as a card payment** — from the row menu on `/transactions`, pairing the money leaving checking with the money landing on the card. Paired, it counts as neither spending nor income. Unmark it the same way.

Reconcile and Refresh each record the balance they replaced, and the row offers to go back to it. That undo is itself undoable, so it's a toggle rather than a one-shot. Only one prior balance is kept, though — there's no history series behind it, which is also why saving a reconcile that changes nothing is treated as a no-op rather than spending that single slot on it. (A charge or a card payment moves the balance without touching the anchor, so there's nothing for those two to record.)

A mortgage or a loan is deliberately quieter: no utilization bar, no hand-entered charges, no paid-down line until it has activity of its own. It sits under a **Long-term** heading in muted ink, counts toward net worth, and otherwise stays out of the way — it's a fact about your life, not a problem you're solving this month. It still gets a balance control, though: Refresh while it's feed-linked with no transactions, and Reconcile otherwise. A car loan you never linked would be uncorrectable without it.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Start the dev server (this IS the app) |
| `pnpm test` / `test:watch` / `test:ui` | Vitest |
| `pnpm db:generate` | Generate a new Drizzle migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm simplefin:claim` | One-time: exchange a SimpleFIN setup token for an access URL (writes `.env.local`) |
| `pnpm simplefin:sample` | Dump a live `/accounts` payload to `.context/simplefin-sample.json` |
| `pnpm lint` | ESLint |
| `pnpm db:export` / `db:import` / `db:seed-volume` | Docker rollback + first-run seed — see [Docker](#docker) above |
| `pnpm db:backfill-merchants` | Renormalize stored merchant names and rewrite the trained rules that key off them — run this after any change to `src/lib/normalize.ts`. Dry run by default, `--apply` to write; runs against the container's ledger — see [Docker](#docker) above |
| `DATA_DIR=./.context/seed pnpm db:seed-dev` | Fill a **scratch** ledger with fixture accounts (including a card and a mortgage) to drive the UI by hand. Refuses to run without an explicit `DATA_DIR`, and refuses again if that database already holds rows, so it can't touch your real ledger |

## Layout

```
src/
  app/           App Router pages: / (dashboard), /accounts, /budget/[year]/[month],
                 /budget/categories, /transactions, /categorize, /subscriptions, /goals,
                 /sync, /import (+ preview + success)
  components/    shadcn/ui (components/ui) + design-system pieces (components/ledger)
  db/            Drizzle schema + HMR-safe client singleton
  lib/           parseCsv, normalize, hash, transferPair, snapshot, money, rules
  lib/accounts/  Live per-account balance queries, the asset/liability split
                 (accountClass, isLongTermLiability), assets/debt/net worth totals
                 (summarizeBalances), card display rules (resolveUtilizationDisplay,
                 resolveStalenessDisplay, resolveBalanceAction, paidDownCents), and the
                 hand-entered card write path (manualTransaction, validateCardTermsInput)
  lib/budget/    Month view (loadMonthView, resolveRowDisplay), allocations (upsertAllocation,
                 validateAllocateInput), category CRUD + archive + reclassify (manageCategories,
                 archiveCategory, setCategoryKind, loadAllCategories), copyMonth, monthOfIso
  lib/categorize/ Bulk-categorize logic, import-time-categorization undo, and validators
  lib/goals/     Savings goal progress
  lib/import/    CSV import orchestration and validators
  lib/simplefin/ Automated sync: access URL, client, mapping, bucket transfer matcher,
                 link/unlink, undo
  lib/subscriptions/ Recurring-charge detection
  lib/trends/    6-month spend by category
scripts/         simplefin-claim.mjs, simplefin-fetch-sample.mjs, migrate.mjs,
                 db-export.mjs, db-import.mjs, seed-volume.mjs (Docker rollback + seed),
                 seed-dev.mjs (scratch fixture ledger, never the real one),
                 db-backfill-merchants.mjs (host half of db:backfill-merchants),
                 build-docker-artifacts.mjs, snapshot-cli.src.mjs,
                 backfill-merchants.src.mjs (+ .test.mjs) — the .src.mjs files are
                 esbuild-bundled into gitignored artifacts in the Docker builder stage
docker/          entrypoint.src.mjs (committed) + entrypoint.mjs (esbuild-bundled, gitignored)
drizzle/         Committed migration output
data/            money.db, pre-import snapshots, pending-import stash (gitignored)
.context/        Design artifacts, CSV samples, design deltas (gitignored)
```

## Core data rules

These are load-bearing — the whole app is built around them:

1. **All money is stored as signed integer `amount_cents`.** Never floats. Withdrawals negative, deposits positive. **A liability's balance is stored negative too** — owing $2,000 on a Visa is `-200000`. You always type what you owe as a positive number ("Balance owed"); exactly one function flips the sign, so account creation and Reconcile can't disagree about it. The point of the negative convention is that nothing downstream needed a new branch: an overdrawn checking account already produced negative balances, so every balance sum, transfer-pair check, spending filter and accounting-parens formatter kept working as written.
2. **The CSV's signs are already correct.** `Amount Debit` is pre-negative, `Amount Credit` is positive. No `Math.abs`, no sign flips by description. (This is the bug Plaid users keep hitting.)
3. **Dedup is `(account_id, import_batch_id, import_row_hash)`**, never Star One's `Transaction Number` — they reuse `6098` for pending deposits across rows. `import_row_hash = sha1(date | amount_cents | raw_description | raw_memo | row_index)`. Feed rows have no row index, so they dedup on the bank's own `external_id` instead, enforced by a partial unique index on `(account_id, external_id)`. The feed also re-sends days you already imported from CSV, so sync compares content signatures too — counted as a multiset, so two genuinely identical same-day coffees both survive. Memo whitespace is normalised on both sides of that comparison, because the CSV parser preserves Star One's padding byte-for-byte while the feed sends the same row trimmed.
4. **Transfer-pair detection is memo-independent.** Two rows pair iff `|txn_a - txn_b| == 1` AND same date AND `|amount_a| == |amount_b|` AND opposite signs AND different accounts. Star One labels the receiving-side memo correctly only ~20% of the time, so memo is confirmation-only. The feed carries no transaction number, so sync pairs by counting instead: bucket on `(date, |amount|)`, keep only opposite-signed rows in different accounts, and auto-link any bucket where the two sides balance, since every possible pairing excludes the same rows from spending. Unbalanced buckets are the ones `/sync` asks you about — as is any pair with a CSV leg carrying a transaction number the stronger ±1 matcher already judged and declined, whether the other leg is from the feed or CSV too. A still-pending CSV row can never become a pair member (the feed itself never carries pending rows at all), and a pair you've explicitly marked "Not a transfer" stays rejected — it won't get silently re-linked by a later import, though either row can still pair with a genuinely different match.
5. **Every batch import writes a DB snapshot first** to `data/money.db.pre-import-{timestamp}`, using `VACUUM INTO` so WAL-resident writes are included — a plain file copy could produce a snapshot that would not open. Last 10 are kept, pruned only once the write commits. Rollback = stop dev server, swap file. Sync snapshots too, and adds a logical undo that deletes just that batch without stopping the server. Both paths check whether the snapshot actually came back consistent; if it degraded to a plain copy, a warning is persisted on the batch and shown on its success page instead of assuming the rollback works.
6. **Money comes in as decimal strings from the feed** — parse with `parseAmountToCents` (string math), never `parseFloat(x) * 100`.
7. **The merchant name a row groups under is computed once, when the row is written** — never recomputed on read. That makes changing `src/lib/normalize.ts` a two-step job: the code alone leaves every stored name a generation behind, so trained rules keep matching names nothing writes anymore while new imports write names no rule matches. `pnpm db:backfill-merchants` is the second step. It recomputes each name from the original bank memo (not from the existing name), rewrites `category_rules` by following the rows rather than by renormalizing the rule's own value (it falls back to renormalizing the value itself only for a rule whose name no row carries any more), and carries dismissed subscriptions across too — they're stored by merchant name with no link back to the rows, so a rename would otherwise resurrect a dismissed subscription with no way to dismiss it again. A `contains` rule is the one thing no backfill can repair: its value is a substring, so if a normalizer change stops that word appearing in any name, the rule is dead for good.
8. **A category's `kind` (income/expense/fund) can't change once it's been used** — any transaction or planned amount locks it in, with one narrow exception: an expense-labeled category that turns out to be income can be reclassified back, but only if every one of its transactions is positive. Archiving a category excludes it from every picker and stops its auto-categorization rules, but never deletes it — a month it already has a planned or spent amount in keeps showing it (so archiving never erases that month's numbers), and it disappears from a month's view only once there's nothing left there to reconcile.

## What's NOT in V1

Auth. Cloud sync of your data. Multi-currency. Bill pay. Investment tracking. Tax features. Split transactions. YNAB-style overspend-shuffle. Cloud/NAS hosting (Docker exists for local self-hosting only — see [docs/plans/dockerize-postgres.md](./docs/plans/dockerize-postgres.md), PR3).

Credit cards were on this list until v0.16.0 and came in. What deliberately stayed out of them, since it reads as an omission otherwise: no interest or APR modeling, no payoff projection, no statement periods or due dates, no minimum-payment *tracking* (the number is stored for reference and never compared against what you actually paid), no automated import of card transactions (you enter charges by hand), and no balance history — an account remembers exactly one prior balance, which is enough to undo a reconcile and not enough to draw a debt trend line.

## Further reading

- [CLAUDE.md](./CLAUDE.md) — guide for AI agents working in this repo (rules, conventions, Next.js 16 gotchas)
- [DESIGN.md](./DESIGN.md) — Ledger Paper design system: fonts, tokens, money display rules, spine nav
- [PLAN.md](./PLAN.md) — roadmap and current status
- [TODOS.md](./TODOS.md) — short-term checklist and post-ship follow-ups
- [CHANGELOG.md](./CHANGELOG.md) — release notes
