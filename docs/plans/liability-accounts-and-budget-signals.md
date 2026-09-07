# Liability accounts and budget-proximity signals

**Status:** IMPLEMENTED 2026-09-07 on `thehashrocket/budget-progress-credit-cards` (all 39 tasks; see the branch's commits). Originally reviewed via `/plan-eng-review` (2026-09-06), `/plan-design-review` (2026-09-06), and a **second `/plan-eng-review` (2026-09-07)** against the design review's 12 previously-uninspected tasks. 15 engineering decisions (D1–D15) + 20 design decisions (DS49–DS68) + **22 second-review decisions (E1–E22)** locked, **39 tasks**, ready to implement
**Branch:** `thehashrocket/budget-progress-credit-cards`
**Base:** `origin/main` @ `2521d02` (v0.15.0)
**Next migration number:** `0018` (verified: `origin/main` ships through `drizzle/0017_category_kind.sql`; worktree level with origin)

## What the user asked for

1. Visual indicators of how close a budgeted category is to its max, on the dashboard or the budget screen.
2. Credit card support. No transaction sync. Track the balance and payments so transactions can be assigned to card payments, for debt tracking.
3. The mortgage should be an account. It already comes down the SimpleFIN feed and is currently dropped.

## The insight that shapes this plan

Items 2 and 3 are one feature. A credit card and a mortgage are both **an account whose balance is money owed**. Building them separately designs the same thing twice.

**E22 — the premise, corrected.** "One feature" is right about storage and wrong about behaviour, and the gap generated nine divergence bugs (D3, D15, DS59, E4, E5, E7, E16, E17, Codex #1). The accurate statement: **identical storage and aggregation, divergent write paths and refresh models.** The shared half — negative-balance storage, rule 4's transfer-pair definition, every `transfer_pair_id IS NULL` filter, `formatCents`, `accountClass`, `summarizeBalances`, net worth, the Spine filter — is the expensive half and is why they still ship as one PR. The divergent half must never be shared. See §"Second engineering review — E1–E22" for the table.

Item 1 is largely already built, on `/budget`. `src/lib/budget/resolveRowDisplay.ts` already returns `barPct` (capped 0-100), `barTone: "amber"` at >= 80%, an `overflow` badge past 100%, and a `tone` for the Remaining figure. `_month-editor.tsx` renders it in four places. The gap is the **dashboard**, which shows four aggregate numbers and a 6-month trend chart and nothing per-envelope.

## Shipping shape

**PR1 — liability accounts.** The shared half of items 2 and 3.
**PR2 — card activity + dashboard proximity.** The two things that sit on top.

---

# PR1 — Liability accounts

## Sign convention (load-bearing)

**A liability account's balance is stored NEGATIVE.** Owing $2,000 on a card is `-200000` cents. A charge is negative; a payment is positive.

Not a style choice. It makes four existing mechanisms work unchanged:

| Mechanism | Why negative-as-liability works |
|---|---|
| Rule 1 `balance = anchor + SUM(amount_cents WHERE date > anchor_date)` | Unchanged. The sum walks the debt toward zero. |
| Rule 4 transfer pairs (opposite signs, same abs amount, different accounts) | A card payment is `-500` on checking and `+500` on the card. Already a transfer pair by the existing definition. Zero new matcher logic. |
| Every spend query's `transfer_pair_id IS NULL` filter | A paired payment is excluded from spend automatically. No new exclusion clause. |
| `formatCents` (`src/lib/money.ts`) | Already renders negatives as `($2,000.00)`. |

The alternative (positive balance + a `direction` column) requires touching all four.

## Data model — migration `0018`

```
accounts.type:            "checking" | "savings"   →  + "credit" | "loan"
import_batches.source:    "csv" | "simplefin"      →  + "manual"      (D6)
transactions.import_source: "csv" | "simplefin"    →  + "manual"      (D6, Codex)
```

**None of the three enum widenings need migration SQL.** `drizzle/0000_thin_mandroid.sql:4` declares `type` as bare `text NOT NULL`, and there are zero `CHECK` constraints anywhere in `drizzle/`. They are TypeScript-level fictions. Migration `0018` exists only for the columns below.

New on `accounts`:

| Column | Type | Why |
|---|---|---|
| `credit_limit_cents` | `integer` nullable | Utilization display on a card tile. NULL for a loan/mortgage. |
| `balance_as_of` | `integer` timestamp nullable | **The provider's own `balance-date`, NOT when we fetched it** (D15, Codex). `classifyBalanceFreshness` exists precisely because a successful fetch can still serve a stale provider snapshot; storing fetch time would mark a frozen balance as fresh. |
| `balance_source` | `text` enum `feed \| manual` nullable | Which path last moved this account's anchor. Drives whether the tile offers "Refresh" or "Reconcile". |

New pure module `src/lib/accounts/accountClass.ts`:

```
accountClass(type): "asset" | "liability"
  checking | savings  → asset
  credit   | loan     → liability
```

Derived from `type` rather than stored: a stored column can disagree with `type`; a function cannot. Written with an exhaustive `switch` so a future enum value is a compile error, not a silent default to `asset` (failure mode F6).

## The balance aggregation fix (do this FIRST)

```
  TODAY                            AFTER a mortgage exists, UNFIXED
  ┌──────────────┐                 ┌──────────────┐
  │ Checking $2k │                 │ Checking $2k │
  │ Savings  $8k │                 │ Savings  $8k │
  ├──────────────┤                 │ Mortgage-300k│
  │ Total   $10k │  ← useful       ├──────────────┤
  └──────────────┘                 │ Total  -$290k│  ← on EVERY page, via the Spine
                                   └──────────────┘
```

Two callers flat-sum every account today:

- `src/app/page.tsx:63` — `accounts.reduce((sum, a) => sum + a.balanceCents, 0)` → dashboard "Total"
- `src/components/ledger/spine.tsx:40` — the same reduce → the left-rail balance peek, on every route

New `src/lib/accounts/summarizeBalances.ts`:

```
summarizeBalances(balances) → { assetsCents, liabilitiesCents, netWorthCents }
```

**D4=A: the Spine headline stays assets-only, relabelled "Total" → "Cash."** The rail answers "can I afford this," and net worth cannot. The relabel makes the narrowing explicit instead of silently changing what the most-viewed number in the app means. Net worth appears on the dashboard and `/accounts`.

```
  ┌────────────────────────────────┐
  │ ASSETS       Checking     $2k  │
  │              Savings      $8k  │
  │              ─────────────────  │
  │              Cash        $10k  │  ← Spine headline, label changed
  │ LIABILITIES  Visa        -$2k  │
  │              Mortgage  -$300k  │
  │              ─────────────────  │
  │              Debt      -$302k  │
  │ NET WORTH               -$292k │
  └────────────────────────────────┘
```

## D9=A — extract `moneyTone` before touching the three call sites

The sign→color-token rule is currently written six times: `page.tsx:53-57`, `page.tsx:104-108`, `spine.tsx:92-95` (**already diverged** — emits `money-neg`, not `text-money-neg`), `envelope-card.tsx:109-112`, `_month-editor.tsx:44-46`, `summary-strip.tsx:14-16`.

PR1 edits three, and liability balances are always negative, so all three are about to grow the same "unless this is a liability, where negative is normal" clause. Extract `moneyTone(cents, { context: "asset" | "liability" })` into `src/lib/money.ts` (existing home of `formatCents`, already Vitest-covered) **as its own commit**, convert the three sites this PR touches, leave the rest to a TODO. Make the change easy, then make the easy change.

## D3=A — the mortgage is balance-only; it never gets a transaction row

Every spend query filters by category and date and **not** by account:

```
src/lib/budget.ts:254-259    categoryMonthPredicate — no account clause
src/lib/trends/loadMonthlyTrends.ts:80-83            — no account clause
src/components/ledger/spine.tsx:24-32  backlog count — no account clause
```

Importing mortgage transactions would put interest, escrow, and principal rows into the categorize backlog and, once categorized, into budget spend — double-counting the mortgage payment you already budget for on the checking side.

The mortgage payment therefore **stays exactly as it is today**: a categorized checking-account debit against its existing budget category. It is deliberately **NOT** paired to the mortgage account; pairing would set `transfer_pair_id` and drop it out of every spend sum, emptying the housing envelope.

## D7=B + D15=A — feed refresh, narrowed

Original D7=B was "refresh liability balances inside `/sync`." Codex found two problems, both real. The narrowed version:

**Scope: only accounts with ZERO transaction rows.** In practice, the mortgage. Rule 1 requires the anchor to be the balance at the **close** of `starting_balance_date`, and SimpleFIN's `balance-date` is a nullable *instant*, not an end-of-day figure (`src/lib/simplefin/types.ts:37`). Collapsing `2026-09-06T14:32Z` to `2026-09-06` and storing it as an anchor asserts a close-of-day balance the feed never claimed — every row later that same day is then dropped by the strict `>`. For an account with **no rows at all** the SUM is zero regardless, so the imprecision is unobservable. For a credit card carrying manual rows it is a silent-loss bug. **Credit cards get manual reconcile only.**

**Placement: before `syncSimpleFin`'s early return, and reported in the result.** `syncSimpleFin` returns `"up-to-date"` before any write when no transactions were inserted (`sync.ts:342`), and `syncNowAction` (`app/sync/actions.ts:95`) renders that as "nothing new to import." A balance pass hidden behind that return would mutate state while the UI claims it did not. The pass runs first and contributes to the result, so an anchor move is always reported. No new import batch, no undo entry — this is an anchor move, not an import, and `undoSyncBatch` (`undoSync.ts:79`) deletes rows only.

**Audit trail:** an anchor move writes the prior value the same way `anchorStartingBalance` does. `import_batches.prior_starting_balance_cents/_date` is batch-scoped and there is no batch here, so the prior value goes on the account row itself.

**Staleness is always visible.** Every liability tile renders `as of <date>` from `balance_as_of` (the provider's date), amber past 7 days, reusing the reasoning in `src/lib/simplefin/balanceFreshness.ts`. A balance-only account's number never moves on its own, so a failed refresh is indistinguishable from a real balance without this. Rule 1 documents the class (a SimpleFIN balance that stops refreshing "simply stops moving," measured once at +$893.84 of phantom drift).

All anchor writes reuse the shared bounds in `src/lib/import/accountAnchorFields.ts`. Nothing writes those columns with its own validation.

## Surfaces

- `/accounts` — new route. Assets / liabilities grouping, per-account balance, staleness label, inline reconcile, "Refresh balances". Needs `error.tsx` + `loading.tsx` (20 such files exist; match the convention).
- `/import` — the account-creation `<select>` gains `credit` and `loan` (`src/app/import/page.tsx:162-163`), and `validateCreateAccountInput.ts:18` gains the same two values.
- `/` and Spine — consume `summarizeBalances`.

---

# PR2 — Card activity and dashboard proximity

## D13=B — no paydown fund; the card balance IS the debt story

The original plan proposed a `kind='fund'` category per card. Codex killed it, correctly: `categorizeTransaction.ts:79` **rejects** `kind='fund'` for transaction categorization, fund rows in `loadMonthView` carry `plannedCents` and nothing else (`loadMonthView.ts:53,273,536`), and `categories` has no account foreign key (`schema.ts:41`). A "Visa paydown fund" would be a number you type that nothing can ever reconcile against the card.

What replaces it is simpler and actually correct double-entry:

```
  CHARGE   -$80 Costco on the Visa, categorized "Groceries"
             → counts as spend in the Groceries envelope, in the month charged
  PAYMENT  -$500 checking ↔ +$500 Visa, transfer pair
             → money-neutral, excluded from spend by the existing filter
  BALANCE  visible on /accounts and the dashboard LIABILITIES block
```

Your budget sees card spending through the **charges**, when they happen. The payment is just moving money and is correctly invisible to spend. Charge in September, pay in October, and September's budget carries the $400 — accrual, which is the right answer.

## D6=B — manual rows get a third write path, properly

Codex was right that this is more than a lazy batch reuse. Four things, not one:

1. `import_batches.source` and `transactions.import_source` both gain `'manual'` (both are closed enums; `schema.ts:184`).
2. `batchLabel.ts:19` hard-throws on any source besides `csv | simplefin` — it must learn `'manual'` or every batch-label render crashes.
3. `import_row_hash` is `NOT NULL` and unique within `(account_id, import_batch_id, import_row_hash)` (`schema.ts:236`). A manual row derives it from its own row id + fields, same spirit as the SimpleFIN path deriving it from `external_id`.
4. One manual batch is created lazily and reused forever.

**And `isLatestBatch` learns to ignore manual batches.** The trap this closes:

```
src/lib/simplefin/undoSync.ts:40-48
  function isLatestBatch(batchId, db) {
    const latest = db.select({id}).from(importBatches)
      .orderBy(desc(importBatches.id)).limit(1).get();   ← no source filter
    return latest?.id === batchId;
  }
```

`findLastSyncBatch:62` returns `null` when that fails, so syncing and then entering one card charge would make the sync's undo button silently disappear. Manual activity must never revoke a sync's undo. **This is a REGRESSION-class change and gets its test before its code (iron rule, no discussion).**

## D10=C — three ways card activity moves, all explicit

```
   ┌──────────────────────────────────────────────────────────────┐
   │ 1. PAYMENT  (from checking)          → transfer pair          │
   │    /transactions row of -$500, "Mark as payment to → Visa"    │
   │      · insert mirror row on Visa: +50000, same date,          │
   │        category NULL, source 'manual'                         │
   │      · UPDATE both rows: transfer_pair_id = each other's id   │
   │      · checking leg drops out of every spend sum and the      │
   │        categorize backlog automatically (no query changes)    │
   │      · Visa balance -2000 → -1500                             │
   │      · unlink = the existing unlinkTransferPair               │
   ├──────────────────────────────────────────────────────────────┤
   │ 2. CHARGE  (manual entry)            → ordinary transaction   │
   │    "$80 Costco on the Visa"                                   │
   │      · insert -8000 on Visa, source 'manual', user-categorized│
   │      · Visa balance -1500 → -1580                             │
   │      · counts as real spending in its envelope — this is what │
   │        keeps card spending visible to the budget (D13)        │
   ├──────────────────────────────────────────────────────────────┤
   │ 3. RECONCILE  (set the true balance) → anchor move            │
   │    updateLiabilityBalanceAction: "Current balance owed",      │
   │    date defaults to today                                     │
   │      · delegates to validateUpdateAnchorInput; does NOT       │
   │        reimplement bounds (accountAnchorFields.ts is the      │
   │        single definition of a legal anchor)                   │
   │      · sets balance_source='manual', balance_as_of=NULL       │
   └──────────────────────────────────────────────────────────────┘
```

### D12=B — a manual row dated on or before the anchor is REFUSED

Paths 2 and 3 both move the balance, and rule 1's `>` is strict (`loadAccountBalances.ts:56`). Reconcile on the 20th, then remember an $80 charge from the 3rd: `09-03 > 09-20` is false, the row lands in `/transactions` and in your budget envelope and contributes **nothing** to the card balance. Same on the boundary — a payment dated the same day as the anchor is excluded too.

Refuse the write rather than warn. Same posture `validateUpdateAnchorInput` takes with future dates and `resolveRowDisplay` takes with its split row types: make the bad state unrepresentable, not merely announced. Recovery is one action and it is the correct one anyway — reconcile again to the true balance, which already includes the charge. Cost: no back-filling card history before the anchor. Acceptable for an MVP that starts from "here's what I owe today."

### D11=A — manual rows are excluded from the automatic transfer matcher

`findAmbiguousTransfers`'s candidate query (`sync.ts:791-808`) has **no `import_source` filter and no account filter**:

```
    .from(schema.transactions)
    .where(and(
      gte(schema.transactions.date, sinceIso),
      isNull(schema.transactions.transferPairId),
    ))
```

Concrete failure it allows: you enter a $250 charge on the Visa dated 09-15; a $250 reimbursement lands in checking on 09-15. Next sync, the bucket `(2026-09-15, 25000)` holds one negative and one positive across two accounts — balanced 1-and-1, which rule 4 auto-links **without asking**. Neither leg has a `bank_transaction_number`, so the cross-source guard never fires. Both rows drop out of every spend sum, silently.

Fix: exclude `import_source = 'manual'` from candidacy, sitting alongside the existing `isAtmWithdrawal` exclusion (`matchTransfers.ts:99`) and for the same reason — a row class that collides on amounts and is never a legitimate auto-pair leg. It costs nothing: the only manual row that should ever be paired is the payment mirror, which is linked explicitly at creation and therefore already has a non-NULL `transfer_pair_id`.

The CSV ±1 matcher is safe by accident — it requires `bank_transaction_number` ±1, and manual rows have NULL there. Do not rely on that accident; it is noted, not depended on.

### D14=B — `/transactions` gains a "show transfers" toggle

`loadTransactions` excludes every paired row (`categorize/loadTransactions.ts:67`), and the only surface listing pairs is `/sync`'s review queue on a 240-day window (`sync.ts:725`). That is right for auto-detected bank transfers and wrong for a routine manual action: mark a checking debit as a card payment and it vanishes from the page you use to manage transactions.

`/transactions` already has a filter bar with search and account filtering as of v0.15.0. Add a "show transfers" checkbox. Note the `_filter-bar.tsx` `<select>` stale-id hazard already documented in this repo's learnings — a boolean checkbox sidesteps it, so keep it a checkbox rather than a tri-state select.

## Dashboard proximity tiles

`src/app/page.tsx:20` already calls `loadMonthView(db, year, month)` for the summary strip. The tiles read the same object. **No new query.**

Each `LeafRow` goes through the existing `resolveRowDisplay`, exactly as `_month-editor.tsx` does, rendering `barPct` / `barTone` / badges. Show the top N envelopes by `barPct` — the ones closest to blowing — not all of them.

## D8=A — delete `src/components/ledger/envelope-card.tsx`

Zero callers (the only hit outside the file is a comment at `_month-editor.tsx:763`) and it holds a **drifted second copy** of the rule the tiles need: `resolveState`/`FILL_COLORS` at lines 40-59 turn the bar redbrown when over, where `resolveRowDisplay.ts:145-155` deliberately keeps the bar amber and emits a separate overflow tick ("the bar's only red signal per row is that tick plus the Remaining figure"). It is precisely the component someone would import to build a dashboard tile.

The `.envelope` folded-flap CSS in `globals.css` loses its only consumer; the new tile either adopts the class or that CSS goes too.

---

# Design specification

Added by `/plan-design-review` (2026-09-06). 20 decisions, numbered `DS49`–`DS68` to continue
DESIGN.md's own sequence (which ends at DS48) rather than colliding with the eng review's D1–D15.
Calibrated against `DESIGN.md` — Ledger Paper: Newsreader / Geist / Geist Mono, `--paper-*` /
`--ink-*` / `--accent-*` tokens, 4/8/12/16/20/28/40/56 spacing (explicitly **not** shadcn's
24/48/64), whisper shadows, `--motion-quick` / `--motion-settle`.

**Approved visual reference:** `~/.gstack/projects/thehashrocket-my_money_manager/designs/accounts-page-20260906/variant-D-remix.png`
— grouped ruled row-lists with subtotals inside each panel, ledger double-rule above net worth.
Build from it, subject to the corrections below (it renders subtotals as clickable-looking
account rows and net worth oversized; both are wrong — see DS51 and the layout diagram).

## The layout — `/accounts`, and the dashboard's balance section in the same idiom

```
  Accounts                                    ← Newsreader, modest. Not a hero.

  ASSETS                                      ← mono uppercase, --ink-3, --text-xs
  ┌──────────────────────────────────────────────────────────────────┐
  │ Checking          updated Sep 6              $3,482.19           │  ← no icon (DS60)
  │ ──────────────────────────────────────────────────────────────── │
  │ Savings           updated Sep 6              $8,210.04           │
  │ ──────────────────────────────────────────────────────────────── │
  │ Cash                                        $11,692.23           │  ← recessed --bg-inset,
  └──────────────────────────────────────────────────────────────────┘     no date, no action

  LIABILITIES
  ┌──────────────────────────────────────────────────────────────────┐
  │ Visa                                       ($2,148.00)  Reconcile│
  │   ▬▬▬▬▬▬▬▬▬░░░░░░░░░░░  $2,148.00 of $5,000.00                   │  ← terracotta, no
  │   min. payment $50.00 · reconciled Sep 6                         │     threshold (DS62)
  │   paid down $500.00 this month                                   │  ← omitted at $0 (DS58)
  │ ──────────────────────────────────────────────────────────────── │
  │ LONG-TERM                                                        │  ← sr-only heading too
  │ Mortgage                                 ($302,480.11)   Refresh │  ← muted ink, no bar (DS59)
  │   as of Sep 6                                                    │
  │ ──────────────────────────────────────────────────────────────── │
  │ Debt                                     ($304,628.11)           │
  │   paid down $500.00 this month                                   │
  └──────────────────────────────────────────────────────────────────┘
  ════════════════════════════════════════════════════════════════════  ← ledger double rule
  NET WORTH                                   ($292,935.88)             ← SAME size as the two
                                                                           subtotals (DS51)
```

## DS49 — dashboard section order, and it stops being a card mosaic

Codex's outside-voice pass triggered two hard rejections — *#1 generic SaaS card grid as first
impression* and *#7 app UI made of stacked cards instead of layout* — against the dashboard, not
against `/accounts`. `page.tsx:41-46` renders balances as a `grid-cols-1 sm:grid-cols-2` tile grid;
adding liability tiles and proximity tiles on top is the mosaic. A card whose entire content is a
name and a number is a `<div>` with a border tax.

`AccountTile` is replaced by the same ruled row-lists as `/accounts` above, and the proximity
section is a ruled list, not tiles. Order:

```
  BacklogBanner (count > 0)
  April 2026                        ← page heading
  ASSETS list + Cash                ← was the AccountTile grid
  LIABILITIES list + Debt + net worth
  This month                        ← SummaryStrip, unchanged
  Closest to limit                  ← NEW, ruled list (DS53)
  Spending — last 6 months          ← demoted one slot: the only section read monthly, not daily
  BacklogTile (count > 0)
  Open budget → / View transactions →
```

This partially un-defers DS45 (`page.tsx:117-122` keeps `SummaryStrip variant="plain"` pending a
reviewed dashboard restyle). The summary strip itself is **not** touched — only the balance
section above it and the new list below it. `variant="plain"` stays.

**DESIGN.md §"Dashboard page" changes in the same PR** (layout ASCII + implementation note 4,
which documents the tile treatment).

## DS50 — the Spine peek is assets-only

`spine.tsx:80-85` renders one row per account unconditionally, then a subtotal. D4=A relabels the
subtotal to `Cash` but leaves the list, which produces a subtotal that visibly does not sum the
rows above it — a closure violation, on every page in the app:

```
  Checking      $3,482.19
  Savings       $8,210.04
  Mortgage   ($302,480.11)   ← would appear here
  ──────────────────────
  Cash         $11,692.23    ← short by $302,480, nothing on screen says why
```

The peek filters to `accountClass(type) === "asset"`. Liabilities never render in the rail. Debt
lives on `/` and `/accounts`, which you reach deliberately. Codex reached the same conclusion
independently. Side benefit: no truncation rule is needed in a 240px component, where
`($302,480.11)` in 13px mono against ~208px of content width leaves ~100px for a name and
`.peek-acct` has no `min-width` or ellipsis today.

**DESIGN.md §"Navigation — Spine" ASCII (line ~105) changes in the same PR.**

## DS51 — net worth renders at subtotal size

The ledger double-rule above it carries the "this is the bottom line" signal. Type size on top of
that is shouting, and the thing it shouts is a six-figure negative on a page you open when you are
already anxious about debt. `NET WORTH` matches `Cash` and `Debt`; the three read as one family,
which is what they are. The loudest thing on the page stays the per-account balances — the only
actionable content on it.

## DS52 — "Mark as payment to →" lives in a `⋯` row menu

`_transaction-row.tsx:116-193` already carries ten elements per row. Roughly one row in two hundred
is a card payment. An always-visible control on every row to serve that is the clutter source
Krug names; a row-level overflow menu is the conventional home for a rare per-row action and gives
the next one somewhere to go. See DS63 for the primitive.

## DS53 — "Closest to limit": count, sort, and why `barPct` alone is wrong

`resolveRowDisplay.ts:122-123` caps `barPct` at 100 **and** flattens zero-allocation overspend to
exactly 100:

```ts
const raw = effectiveCents > 0 ? (spentCents / effectiveCents) * 100 : spentCents > 0 ? 100 : 0;
const barPct = Math.min(100, Math.max(0, raw));
```

So an envelope at 100.0%, one at 400%, and one with no budget at all and $600 spent all sort
identically. The plan's "top N envelopes by `barPct`" would rank the section by nothing. Sort by
severity instead, all four keys readable off `RowDisplay` with no new query:

1. rows carrying an `overflow` badge first, descending by `badge.amountCents`
2. then `barPct` descending
3. then `effectiveCents - spentCents` ascending
4. then category name

Count: **5 desktop / 3 mobile.** Heading: **"Closest to limit"** — states what the area is, per the
App UI rule, rather than what it contains. The section is **omitted entirely** (not rendered empty)
when no leaf category has either an allocation or spend this month.

## DS54–DS57 — interaction states

The plan's only state specification was *"Needs `error.tsx` + `loading.tsx`"* plus three lines in
the test matrix. A test-matrix entry promises a state exists; it does not say what the user sees.

**Reuse, don't rebuild:** `StateCard` (`src/components/ledger/state-card.tsx`, variants
`empty|loading|error|success`) and `RouteErrorCard` (`src/app/_components/RouteErrorCard.tsx`,
always surfaces `error.digest`, optional `reassurance` slot). Nine of ten route error boundaries
already route through it. `/accounts` uses the `reassurance` slot — it writes anchors behind rule
5's snapshot guarantee, which is exactly what the slot is for.

```
FEATURE                  | LOADING          | EMPTY               | ERROR                | SUCCESS            | PARTIAL
-------------------------|------------------|---------------------|----------------------|--------------------|------------------
/accounts route          | StateCard        | StateCard "empty" — | RouteErrorCard +     | n/a                | n/a
                         | "loading"        | "No accounts yet",  | reassurance          |                    |
                         | (loading.tsx)    | → /import           |                      |                    |
LIABILITIES section      | —                | DS54: neutral row   | —                    | —                  | —
                         |                  | + "Add a credit     |                      |                    |
                         |                  | card or loan →"     |                      |                    |
Refresh (per row)        | "Refreshing…"    | —                   | inline on the row,   | as-of moves,       | DS55: cannot occur
                         | button disabled  |                     | ledger unchanged,    | --motion-settle    | — no bulk action
                         |                  |                     | retry available      | highlight          |
Reconcile (per row)      | "Saving…"        | —                   | field-level, form    | as-of → today,     | —
                         |                  |                     | keeps the input      | balance settles    |
Add a charge             | "Saving…"        | —                   | DS56 (D12 refusal)   | row + new balance  | —
Mark as card payment     | row dims,        | —                   | toast.error, row     | Sonner toast +     | double-submit →
                         | useTransition    |                     | restored             | 10s Undo           | no-op (F5 guard)
Show transfers toggle    | —                | "No transfers in    | —                    | paired rows appear |  —
                         |                  | this range"         |                      | with indigo chip   |
Closest to limit         | inherits         | section omitted     | —                    | —                  | —
                         | loading.tsx      | (DS53)              |                      |                    |
Staleness label          | —                | DS57                | —                    | —                  | —
```

**DS54 — zero liabilities keeps the section.** Not hidden. One neutral `--bg-inset` row reading
"No liabilities tracked yet" with "Add a credit card or loan →". Hiding it leaves the page named
Accounts with no path to the account type this PR exists to add, and nobody learns the
Cash / Debt / Net worth structure until they happen to trip over it.

**DS55 — Refresh and Reconcile are per-row and mutually exclusive.** Driven by `balance_source`:
a `feed` account offers Refresh, a `manual` one offers Reconcile, never both, never neither. This
does not merely style the partial-success problem — it **removes it**. D7/D15 scope the feed pass
to zero-transaction-row accounts, so a page-level "Refresh balances" button would silently do
nothing for the Visa and would owe the user a sentence like "1 refreshed, 1 skipped (has
transactions), 1 skipped (bank sent no balance date)". Eligibility is a per-account property, so
the control belongs on the account and is simply absent where it does not apply. A button that
mostly declines to act is the silent-no-op shape rule 5's `snapshot_warning` work exists to avoid.

**DS56 — the D12 refusal carries its own recovery.** D12 refuses a manual row dated on or before
the anchor, correctly. But the user typed a real charge and the app said no, and the plan specified
zero words of it. The message states the consequence, and an inline **"Reconcile instead →"** opens
the reconcile form prefilled with today's date. That recovery is genuinely the correct action — a
fresh reconcile to the true balance already includes the charge — so the refusal becomes a two-click
path instead of a dead end, and it teaches the anchor model by doing rather than in help text.

**DS57 — two staleness thresholds, off `balance_source`.** The plan's rule (`balance_as_of`, amber
past 7 days) covers the mortgage and leaves NULL on every credit card, because D10 path 3 sets
`balance_as_of = NULL` on a manual reconcile and cards are manual-only by D15. Staleness reads
`balance_as_of ?? starting_balance_date`, and the threshold splits:

| `balance_source` | Amber after | Why |
|---|---|---|
| `feed` | **7 days** | A live feed that stopped moving is broken. Rule 1 documents the measured case: a frozen SimpleFIN balance reading as +$893.84 of phantom drift. |
| `manual` | **35 days** | A hand-reconciled card is expected to be monthly. 35 rather than 30 gives a normal cadence a week of slack, so amber keeps meaning "attention needed" rather than "time has passed". |

## DS58 — the app shows debt *moving*, not just debt

D13=B correctly killed the paydown fund. The cost of that correct decision: you pay $500, the
payment is transfer-paired, it is properly invisible to every spend query, and the entire reward in
the app is that a red number is slightly less red. For a feature whose stated purpose is a
debt-payoff journey, that is the 5-minute behavioural layer with nothing above or below it.

`paidDownCents(accountId, year, month)` = `SUM(amount_cents) WHERE account_id = ? AND amount_cents > 0`
within the month. No schema change — card payments are already positive rows on the card account.
Rendered on each card row **and** under the dashboard's `Debt` subtotal (one function, two callers).

**Constraint, stated so it doesn't read as a bug:** the mortgage has zero transaction rows by D3=A,
so this figure is computable for credit cards only. The mortgage row shows no delta rather than a
false `$0`. The line is omitted entirely in a month with no payments — a `$0` reads as a reproach,
and omission is preferred even though it means the row height varies month to month.

## DS59 — a mortgage does not look like a credit card

The plan's founding insight — a card and a mortgage are the same data model — is right, and wrong
in the interface. A mortgage is a fact about your life; a card balance is a problem you are solving.
Rendered identically, the $302k sets the emotional register of a page whose real subject is the
$2,148 you can act on this month.

Cards get the active treatment (utilization bar, Reconcile, paid-down line). The mortgage renders
muted — lower-contrast ink on the balance, no bar, no Reconcile — under a quiet `LONG-TERM`
sub-label inside the same list. **All of it derived, none of it stored:** no `credit_limit_cents`
means no bar; `balance_source = 'feed'` means Refresh not Reconcile. Same principle as
`accountClass` — a stored column can disagree with `type`, a function cannot.

## DS60 — no icon badges

Every generated mockup put a circular tinted icon badge left of each account name. That is AI-slop
blacklist item 3 (icons in colored circles as section decoration), and it is not this app's icon
idiom: the Spine already established one, and it is bare monochrome text glyphs (`◇ ▣ ≡ ! ↻ ★ ⟳ ↥`)
with no circles and no tint. The account name is set in a serif display face and says "Checking";
a bank glyph beside it restates the label. Cut. The existing type chip carries the kind.

## DS61 — copy deck and register

| # | Where | String |
|---|---|---|
| 1 | `/import`, type `credit`/`loan` | Field label: **"Balance owed"** (replaces "Starting balance (USD)") |
| 2 | `/import` helper | **"What you owe on this account today, as a positive number. We'll record it as a debt."** |
| 3 | `/import` echo | **"You owe $2,000.00 as of September 6, 2026."** |
| 4 | `/import` date label | **"As of"** (replaces "Starting balance date") |
| 5 | `/import` date helper | **"Charges and payments dated after this day count toward the balance. Anything on or before it is already included in the figure above."** |
| 6 | `/accounts`, no liabilities | **"No liabilities tracked yet"** · **"Add a credit card or loan →"** |
| 7 | `/accounts`, no accounts | **"No accounts yet"** · **"Import a CSV to get started →"** |
| 8 | Staleness, feed, stale | **"as of Sep 2 · 31 days old"** (amber) |
| 9 | Staleness, feed, fresh | **"as of Sep 6"** (muted) |
| 10 | Staleness, manual, stale | **"reconciled Aug 2 · 35 days ago"** (amber) |
| 11 | Staleness, manual, fresh | **"reconciled Sep 6"** (muted) |
| 12 | D12 refusal | **"This is dated before your last reconcile (Sep 20), so it wouldn't count toward the balance."** · **"Reconcile instead →"** |
| 13 | Paid down | **"paid down $500.00 this month"** (line omitted at $0) |
| 14 | Utilization caption | **"$2,148.00 of $5,000.00"** |
| 15 | Row actions | **"Reconcile"** · **"Refresh"** · **"Add a charge"** · **"Mark as payment to →"** |
| 16 | Payment success toast | **"Recorded as a payment to Visa. Visa is now ($1,648.00)."** + 10s Undo |

**Register — three rules, so string 17 can be written without asking:**

1. **State the consequence, not the rule.** "it wouldn't count toward the balance", never
   "date must be after starting_balance_date".
2. **Never name a schema concept in user-facing text.** Banned: *anchor*, *starting balance*,
   *transfer pair*, *import batch*, *external id*, *row hash*. Use: *reconcile*, *balance owed*,
   *payment*, *as of*.
3. **Put the recovery in the same view as the refusal, as an action, not a sentence.**

Codex's framing, adopted verbatim as the test: the UI must not *leak storage conventions to the user*.
The most concrete application is DS64 — the user never types a negative number.

## DS62 — `resolveUtilizationDisplay`, and why the bar has no threshold

New pure module beside `accountClass` and `summarizeBalances`:

```
resolveUtilizationDisplay(balanceCents, creditLimitCents) → { pct, hasLimit }
```

Vitest-covered. Owns the three cases an inline ternary gets wrong: no limit (no bar at all),
over-limit (cap at 100), zero balance. Computing this inline in a component would recreate, in the
same PR, the exact duplication D8 and D9 exist to eliminate — and CLAUDE.md scopes tests to logic,
so a rule written in JSX is a rule this repo cannot test.

**The bar is always terracotta. There is no warn threshold.** A "your utilization is too high" line
is financial advice, which is the one thing deliberately deleted from the generated mockups (variant
C invented *"Your debt is 20.7% of your assets. A good rule of thumb is to keep this under 30%.
Learn more →"* — invented advice with an external link, in an app whose premise is that nothing
leaves the machine). `--accent-amber` also already carries five distinct meanings per DESIGN.md's
own amber inventory; 43% utilized is not a warning and must not add a sixth.

## DS63 — shadcn `DropdownMenu`, bought for its keyboard behaviour

TODOS.md locks the shadcn surface at four components (Table, Dialog, Sonner, Combobox). This is a
deliberate fifth. The reason is not convenience: a hand-rolled menu without Escape, arrow-key
roving, `aria-haspopup`, and focus return is an accessibility regression on the busiest surface in
the app. Base UI primitives are already this app's foundation (base-nova style), so it is the same
family, not a new one.

## DS64 — `/import` is where the sign convention can silently corrupt the ledger

The plan's entire treatment of `/import` was "the account-creation `<select>` gains `credit` and
`loan`". The live form (`src/app/import/page.tsx:145-200`) is written wholly for asset accounts:
label "Starting balance (USD)", helper text explaining that *"A CSV import re-derives this from the
file's running Balance column"* — which is false for a card, manual-only by D10 — and no sign
guidance anywhere. Type `2000` for a $2,000 Visa and the account is created with a **positive**
anchor, the dashboard adds $2,000 to **Cash**, and net worth is wrong by $4,000. No error, no
warning, and the number looks plausible.

**The user never types a negative number.** For `type ∈ {credit, loan}` the form takes a positive
"Balance owed", negates it internally, and echoes the confirmation (DS61 strings 1–5). Plus:
`credit_limit_cents` and `minimum_payment_cents` fields, both optional.

**And the form is restyled to Ledger Paper tokens.** `/import` is the app's most off-system surface
— measured 0 Ledger Paper tokens to 13 raw `zinc-*` usages (learning
`mm-design-system-documented-not-adopted`, 10/10, 2026-09-04), and that learning's own conclusion
is that adding one on-system component to an off-system page reads as careless where a consistent
default shell merely reads as plain. Scope is the `<form>` (~60 lines), **not** the page: the CSV
upload form and the anchor-repair section stay as they are, and the page is visibly half-converted
until a later PR finishes it. That is accepted.

## DS65 — mobile

Below 640px both row-list surfaces collapse using the `MobileCards` pattern
`/budget/[year]/[month]` already ships — this repo has exactly one mobile pattern and inventing a
second for the sibling page is how design systems fracture.

```
  ┌─────────────────────────────┐
  │ Visa                 credit │  ← name + type chip
  │                             │
  │              ($2,148.00)    │  ← right-aligned, large
  │  ▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░  │  ← full-width bar
  │  $2,148.00 of $5,000.00     │
  │  min. payment $50.00        │
  │  reconciled Sep 6           │
  │  paid down $500.00 this mo. │
  │  ┌───────────────────────┐  │
  │  │      Reconcile        │  │  ← full-width button, clears 44px
  │  └───────────────────────┘  │
  └─────────────────────────────┘
```

Nothing is hidden and nothing is truncated; every desktop field survives, re-flowed. `Closest to
limit` shows 3 rows on mobile instead of 5 (DS53). Cards on mobile after DS49 removed cards on
desktop is a real tension, stated deliberately: on desktop a card was a border around a name and a
number; on mobile the card *is* the row.

## DS66 — accessibility

The plan says "aria" zero times. The codebase does not: `_month-editor.tsx:360` runs
`role="status" aria-live="polite"` on an `sr-only` node, every progress bar is `aria-hidden`
because the figure beside it is the accessible value, every row combobox has an `sr-only` label,
and TODOS records a deliberate WCAG AAA pass on the money tokens. The practice exists; the plan
inherits none of it.

- **Parens are silent to a screen reader.** DESIGN.md mandates `($2,148.00)` for negatives — visually
  unambiguous, and read aloud as "dollar two thousand one hundred forty eight" with the entire
  meaning lost. Every liability figure gets
  `aria-label={`owed ${formatCents(Math.abs(cents))}`}`; a negative `NET WORTH` gets
  `aria-label={`negative ${…}`}`. Pre-existing gap, made much worse by figures that are *always*
  negative.
- **DS59's muted mortgage is invisible to a screen reader**, so `LONG-TERM` is a real grouping
  label (`sr-only` heading or group `aria-label`), never lower-contrast ink alone.
- **Muted ink is measured, not eyeballed:** ≥4.5:1 against `--paper-1` in both themes.
- **DS56's "Reconcile instead →" moves focus** to the reconcile form's balance field and announces
  via the existing `role="status" aria-live="polite"` pattern. A handoff that silently relocates
  the user is worse than the refusal it fixes.
- **Every new action is a real `<button>`/`<a>` with a 44px minimum touch target** — Reconcile,
  Refresh, `⋯`, "Add a charge", "Add a credit card or loan →". Today's 8px-padded text links do not
  meet it.
- **The utilization bar is `aria-hidden`**; `$2,148.00 of $5,000.00` beside it is the accessible value.
- **Type floor (DS66b):** uppercase letterspaced mono labels may stay at `--text-xs` (11px) — a
  legitimate typographic device, not body text. Every sentence-case body, helper, or error string
  uses `--text-base` (15px) minimum. This is a stated position, not compliance: Codex flagged the
  16px universal floor against this app's 15px base (`globals.css:92`). Re-scaling a system that has
  been through three review cycles does not belong in a liability-accounts PR — see TODOS.

## DS67 — "Add a charge" lives on the card row

D10 path 2 had a data model, a dedup key, a validation rule, and no interface. It gets an
"Add a charge" action on the card row opening a `Dialog` (already locked) with amount, date
(defaults today), merchant, and a **required** category via the shared `CategoryCombobox`.

The category is required because D13=B's whole argument is that card charges are how card spending
stays visible to the budget — a charge landing `category_id = NULL` goes to the backlog instead and
D13's claim quietly fails for that row.

Putting it here means all three D10 paths live on one page, which makes `/accounts` the single place
debt is managed, and the balance visibly moves as a direct result of what you just typed — the
feedback loop DS58 exists to close.

## DS68 — `/accounts` in the navigation

The plan adds a top-level route and never mentions navigation; `spine.tsx:45-61` hardcodes the tab
list, so without this the route is reachable only by typing the URL, which fails Krug's trunk test
by definition.

- New **"Accounts"** tab in the Spine, second position (after Dashboard) — the two "where do I
  stand" surfaces before the three "what do I do" ones. Nine tabs.
- The peek's "Peek · balances" header becomes a `<Link>` to `/accounts`, with a visible affordance
  (hover underline plus a `›` marker) — a header that merely happens to be clickable signals
  nothing, and there is no hover on touch. This also fixes a small existing oddity: those balances
  are a dead end today.

## Card charges and the trend chart — no change needed

`loadMonthlyTrends.ts:80-83` filters `amount_cents < 0` with no account clause, so a categorized
`-8000` on the Visa flows into the 6-month chart exactly like a categorized checking debit. That is
D13's accrual model working correctly, not a leak. Recorded here so nobody "fixes" it later.

---

---

# Second engineering review — E1–E22

Added by a second `/plan-eng-review` (2026-09-07), run after `/plan-design-review` had
layered 20 decisions and 12 tasks (DS49–DS68, T16–T27) onto a plan that was eng-cleared at
15 decisions and 15 tasks. **Those 12 tasks had never been through an engineering pass.**
That gap is where 16 of these 22 findings came from; Codex's outside voice found six more.
D1–D15, DS49–DS68, and the PR1/PR2 split are NOT reopened.

## E22 — the premise, restated (read this first)

The plan's founding sentence — *"a credit card and a mortgage are one feature"* — is right
about storage and wrong about behaviour, and the gap generated nine bugs. Codex named it
directly: *"one is zero-row feed balance state; the other is manual transactional bookkeeping."*

**Corrected premise:**

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │ IDENTICAL — build once                    DIVERGENT — never share    │
  ├─────────────────────────────────────────────────────────────────────┤
  │ negative-balance storage (rule 1)         write path                 │
  │ transfer-pair definition (rule 4)         refresh model              │
  │ every `transfer_pair_id IS NULL` filter   anchor-move surface        │
  │ formatCents parens                        row presentation           │
  │ accountClass / summarizeBalances          available row actions      │
  │ net worth, LIABILITIES section            transaction-row eligibility│
  │ Spine asset filter, moneyTone context                                │
  └─────────────────────────────────────────────────────────────────────┘
```

Every one of D3=A, D15=A, DS59, E4, E5, E7, E16, E17 is an instance of the right-hand
column. They read as exceptions under the old premise and as predictions under this one.
The shared column is the expensive half and is why the two still ship as one PR.

## E1 + E2 — D3=A had no enforcement, and the fix must partition, not exclude

`sync.ts:175-179` selects linked accounts with **no type filter**, and `sync.ts:210` loops
every one into transaction staging. Linking the mortgage therefore imports its transactions —
the exact outcome D3=A forbids — and once it has rows, D7/D15's zero-row-scoped balance pass
skips it forever. Self-disabling after one run, with an amber staleness label as the only symptom.

The fix cannot be a plain exclusion: dropping liability ids from `linked` also drops them from
`accountIds` at `sync.ts:197`, so the feed is never asked for the balance D7 exists to write.

```
                    linked = all accounts WHERE simplefin_account_id IS NOT NULL
                                          │
                          partitionLinkedAccounts(linked)
                                          │
                  ┌───────────────────────┴────────────────────────┐
                  ▼                                                ▼
          importAccounts (asset)                        balanceOnlyAccounts (liability)
                  │                                                │
   ┌──────────────┼──────────────┐                                 │
   ▼              ▼              ▼                                 ▼
latestDates   staging loop   accountIds ──────► ONE fetchAccounts ◄── accountIds
   │              │                                                │
   ▼              ▼                                                ▼
resolveStartDate  dedup + insert                       balance pass: anchor move,
   │                                                   balance_as_of, prior value,
   ▼                                                   NO rows, NO batch
45-day floor NOT pinned                                          │
by a zero-row liability  ◄── E2 / REGRESSION R1                  ▼
                                                    reported BEFORE the `up-to-date`
                                                    early return (sync.ts:342)
```

`resolveStartDate` reads `importAccounts` only. `sync.ts:136` (`known.length !== latestDates.length
→ floorIso`) means one permanently zero-row linked account would otherwise pin **every** sync to
the 45-day floor forever, re-running content dedup over six weeks of imported rows on every run.

The `SimpleFIN returned nothing for "X"` warning at `sync.ts:213-217` lives inside the staging
loop. The balance pass needs its own equivalent, or a mortgage the feed stops returning goes silent.

## E3 — `minimum_payment_cents` is created by no migration

Rendered at plan L300 (layout), L581 (DS64), L604 (mobile), L816 (NOT-in-scope), L942 (T15).
Absent from the data-model table and from T4. Added to migration 0018, validated through the
same shared bounds path as every other money column. **Open question this forces:** whether a
`loan` row renders a minimum payment at all (the copy deck only ever shows it on the Visa).

## E4 — `balance_source` is NULL on every new card, so DS55's "never neither" fails

Nothing in T15/DS64 sets the column at account creation, and DS57's threshold table has no NULL
row. A card created today renders with no Refresh and no Reconcile — and Reconcile is the *only*
way to update a card balance under D15.

DS55 was asking one column two questions. **Capability is derived; history is stored:**

```
  resolveBalanceAction(account, hasAnyRows)      ← what this row can DO
    simplefin_account_id != NULL && !hasAnyRows  → "refresh"
    otherwise                                    → "reconcile"
    (total over both inputs — no third state exists)

  balance_source: 'feed' | 'manual'              ← what LAST happened (DS57 staleness only)
    set to 'manual' at account creation: a hand-typed "Balance owed" IS a manual reconcile,
    and DS57's 35-day clock is the right one to start.
```

This also fixes a case DS55 only styled: a `feed` account that later grows rows kept offering
Refresh while D7/D15 silently skipped it.

## E5 — D12 is correct for charges and WRONG for payment mirrors

The anchor defaults to today at account creation (DS61 string 4), so under D12-as-written
**"Mark as payment to →" fails for 100% of existing history on day one.** Worse, each refusal
leaves the checking leg unpaired, so `transfer_pair_id` stays NULL and the payment keeps counting
as spend — the double-count D13=B exists to prevent.

```
  CHARGE  must (a) count as spend  (b) move the card balance
          pre-anchor: does (a), not (b)  → inconsistent  → REFUSE  ✓ D12 correct

  PAYMENT must (a) NOT count as spend (it is paired)
              (b) contribute nothing new to the balance — any anchor dated
                  after it ALREADY includes the payment
          pre-anchor: does exactly that     → CORRECT     → ACCEPT  ✗ D12 wrong
```

**D12 scopes to `createCardCharge` (and `createCardRefund`) only. `markAsCardPayment` accepts
any date.** DS56's "Reconcile instead →" recovery stays scoped to the charge dialog; it was never
the right recovery for a payment (reconciling fixes the card balance, which was not wrong, and
does nothing for the checking leg where the damage is).

Knock-on, stated so it does not read as a bug: `paidDownCents` has no anchor filter, so a
pre-anchor mirror shows "paid down $500.00 this month" beside a balance that did not move by $500.
Correct — you did pay it — but say so.

## E6 — `/import`'s CSV target picker would offer a credit card

`import/page.tsx:17` selects all accounts unfiltered and feeds the CSV target `<select>` at
`:105-116`. After T15 the Visa is a valid import destination: rows land with checking sign
conventions, and `deriveStartingBalance` **moves the card's anchor** off another account's balance
chain. Forward-only, silent.

Filter the picker to assets **and** reject a liability `accountId` in the import action. The
server-side half is what holds — a stale tab rendered before the card existed still posts.

## E7 — DS59 derived LONG-TERM from an optional column

`credit_limit_cents` is optional per DS64, so a card added without a limit would render muted,
unbarred, and grouped under `LONG-TERM`. DS59's own last sentence has the answer: *a stored column
can disagree with `type`, a function cannot.* Two independent derivations:

```
  utilization bar   ← credit_limit_cents present?     (absence = no utilization to show)
  LONG-TERM + muted ← isLongTermLiability(type)       (exhaustive switch, NOT NULL input)
```

## E8 — `src/components/ui/dropdown-menu.tsx` already exists

99 lines, Base UI `Menu`, written for DS20's budget-row `⋯`, **zero consumers** (verified by grep
across `src/`). DS63's "deliberate fifth component" premise is false in both directions: there is
nothing to acquire, and there is no hand-rolled menu to argue against. T21 called it `(new)`.

Wire the existing component. **Spend the saved budget exercising the keyboard behaviour DS63
names — Escape, arrow-key roving, `aria-haspopup`, focus return — because a component with zero
consumers has never rendered.** This repo has the precedent: `applyRuleAtImport` was written,
tested and documented as auto-categorizing every import and had zero production callers, which is
how a 498-row backlog accumulated (CLAUDE.md rule 6). With `envelope-card.tsx` (D8 deletes it) this
is the third built-then-never-wired file found in this repo; this PR clears two of the three.

## E9 — T12 and T26 were the same feature, twice, with contradictory placement

D14=B and T12 said "checkbox in the filter bar"; T26 said "beside the result summary, **not**
inside the filter slab." Both live. Split on the seam every other task in this plan uses:

- **T12** → `loadTransactions`'s `includeTransfers` predicate only. `Verify: pnpm test`.
- **T26** → all UI: placement, `--accent-indigo` paired chip, partner-account name, and the
  `filterValuesToSearchParams` round-trip (`_filter-bar.tsx:204`, consumed at
  `_transactions-ui.tsx:132`) without which page 2 silently drops the toggle.

## E10 — F5's "idempotency guard" named no key

Guarding on `transfer_pair_id IS NOT NULL` alone silently succeeds on a row the matcher already
auto-paired elsewhere (rule 4 auto-links balanced buckets without asking). Three-way, re-read
**inside** the write transaction — same pattern `undoSyncBatch` uses for a stale tab or resubmit:

```
  transfer_pair_id IS NULL                        → proceed
  paired to a row on the TARGET card account      → no-op, report SUCCESS
  paired to anything else                         → REFUSE, name the partner
```

Also stated: `markAsCardPayment` writes its two-way link directly rather than through
`linkTransferPairManually`. Deliberate — the mirror is new and carries no rejection marker, and
CLAUDE.md rule 4 clears a marker only when it points at the row being relinked.

## E11 — `resolveStalenessDisplay`, not `classifyBalanceStaleness`

The reuse table claimed `balanceFreshness.ts` was reused by T20. It is not: `classifyBalanceFreshness`
compares the bank date against the *ledger* date to decide whether a difference is real drift; T20
compares one date against *today* to decide whether to paint a label amber. Different inputs,
different outputs, nothing calls the old function. Two near-homonyms in one codebase is a
wrong-import waiting to typecheck. Renamed to match `resolveRowDisplay` / `resolveUtilizationDisplay`.

## E12 — `unlinkTransferPair` is the wrong inverse for a synthetic mirror

It was built for two real bank rows the matcher wrongly joined. A payment mirror exists only
because the user said "this is a payment to Visa." Unlinking it strands a `category_id = NULL`,
`transfer_pair_id = NULL` row that (a) enters the categorize backlog (`spine.tsx:24-32` counts
exactly that state), (b) still inflates the card balance by the payment, (c) has no correct
category — a positive amount in an expense category produces negative `spentCents`, which
`resolveRowDisplay`'s `looksLikeIncome` flag exists to complain about, and (d) is now
rejection-marked against the checking row, blocking automatic re-pairing.

**New `unmarkCardPayment`: clear both `transfer_pair_id`s and DELETE the mirror. No rejection
marker.** This is the same operation the DS61 string-16 10s Undo already has to perform, so the
marginal cost is a second entry point. The delete is clean: `transfer_pair_id` is
`ON DELETE SET NULL`, and a category-less mirror has no `import_batch_categorizations` row.

## E13 — refunds are unrepresentable, and `paidDownCents` is correct only because of that

"Add a charge" writes negatives only, so a $200 return to Costco has nowhere to go — the Groceries
envelope keeps money you got back, and after E5 a reconcile also blocks back-dating charges you
have not entered. `paidDownCents = SUM(amount_cents > 0)` is right today solely because the payment
mirror is the only positive row a card can have; it silently becomes wrong the day refunds exist.

- **DS67's dialog gains a charge/refund choice.** Sign flips; category stays required.
- **`paidDownCents` narrows to `transfer_pair_id IS NOT NULL AND amount_cents > 0`** — literally
  "payments," which is what the figure is named for. Correct today, refund-proof tomorrow.

Everything downstream already handles a positive card row: `spentCents = 0 - SUM(amount_cents)`
reduces envelope spend correctly, D11 keeps it out of matcher candidacy, and D12 refuses a
pre-anchor refund for the same reason it refuses a pre-anchor charge.

## E14 — the coverage artifact was stale (see the regenerated Test plan below)

`TARGET COVERAGE: 41/41 paths (100%)` predates T16 (`resolveUtilizationDisplay`), T17
(`paidDownCents`) and T20 (`resolveStalenessDisplay`) — three modules that name a `.test.ts` in
their own task body and appear in neither the coverage diagram nor the Test files table. E1–E22
add roughly 40 more paths. The plan's verdict leans on that artifact (*"Zero remaining critical
gaps"*), so a diagram certifying 100% while forty paths sit outside it is worse than none.

## E15 — `listAccounts` is in the enum widening's blast radius

`src/lib/accounts/listAccounts.ts:17` selects every account with no type filter and feeds the
`/transactions` account filter. The Visa appearing there is **good** and unplanned. The mortgage
appearing there is a permanently-empty option — zero rows by D3=A, now enforced on both write
paths by E1 and E6. Filter long-term liabilities out; cards stay. `listAccounts.ts` + its existing
test file join the plan's file list.

## E16 — "accounts with ZERO transaction rows" was undefined, and the cheap reading is the wrong one

D7/D15's scope rule, E1's partition, and E4's action derivation all need this predicate.
`loadAccountBalances` already scans an **anchor-filtered** set (`gt(date, startingBalanceDate)`),
so `COUNT(*)` there is free — and wrong. Reconcile a card to today and every row it owns now sits
*before* the anchor, making it "zero rows" and therefore eligible for a feed balance refresh, which
is exactly what D15 forbids.

**Definition: zero rows at all. A dedicated `EXISTS` against `transactions(account_id)`, no anchor
filter, one helper serving all three call sites.** D15's safety argument is "the SUM is zero
regardless," and that only holds with no rows to drop.

## E17 — nothing stopped a manual charge or payment landing on the mortgage

E1 closed the sync door and E6 closed the CSV door; `manualTransaction.ts` was the third. The
`/accounts` UI only offers those actions on card rows, but a server action does not care what the
UI offered. **Reject `type='loan'` at the shared entry of `manualTransaction.ts`**, covering charge,
refund, and payment targeting. One guard, not one per action. The zero-row premise is load-bearing
under D3, D7, D15, and E16 and was guaranteed by nothing but button placement.

## E18 — `/import`'s anchor-repair form is a raw twin of Reconcile

`import/page.tsx:29` renders a per-account anchor form posting to `updateAccountAnchorAction`
(`import/actions.ts:62`). T15 fixes the *creation* form so a liability takes a positive "Balance
owed" and negates it — then forty lines down, the repair form offers the same Visa a raw signed
field with no relabelling and no negation. Same page, same bug, second form.

**Scope the anchor-repair form to asset accounts.** Liabilities get `/accounts` Reconcile and
nothing else — one anchor surface per account class. (`TODOS.md:1163` already noted that DS56
promotes this form from repair hatch to mainline flow.)

## E19 — the prior-anchor columns are missing, and the reassurance copy claims a guarantee that does not exist

D7 says an anchor move persists the prior value "on the account row itself." T4's column list does
not include those columns. Added to 0018 alongside E3's.

Separately: DS54–57 justifies `/accounts` using `RouteErrorCard`'s `reassurance` slot because *"it
writes anchors behind rule 5's snapshot guarantee."* Verified false — `createSnapshot` has exactly
two production callers, `importBatch.ts:305` and `sync.ts:351`, and `updateAccountAnchorAction`
writes the anchor with a bare `db.update(...)`. **The reassurance copy describes the real
mechanism instead: the previous balance and date are kept and the change is one click to reverse.**
A whole-database `VACUUM INTO` before a reversible single-column update was considered and rejected
as over-engineering that would also churn the retention-of-10 snapshot pool.

## E20 — every `/accounts` error state needs returned action state; the code T6 delegates to throws

DS54–57 promises inline row errors, a form that keeps your input, a toast with the row restored,
and DS56's focus handoff. A thrown server action unmounts the route into `error.tsx`, so **none of
those survive a throw.** T6 says `updateLiabilityBalanceAction` delegates to
`validateUpdateAnchorInput` — whose existing caller, `updateAccountAnchorAction`
(`import/actions.ts:66-91`), is throw-and-redirect, forty lines from where you would copy. The path
of least resistance is the wrong pattern and the plan points at it.

**Every `/accounts` server action returns its outcome as state, `/sync`-style; `error.tsx` is the
backstop only.** CLAUDE.md already wrote the rationale for the same reasons: *"a throw would take
out the undo button and the balance check along with the page."* `/accounts` has four independent
per-row actions live at once. E10's "paired elsewhere, refuse and name the partner" and E17's loan
rejection are values the UI renders, not exceptions.

## E21 — one batch per manual operation, not one batch reused forever

Every `import_batches` column is scoped to one atomic write: `transactionCount`, `snapshotPath`,
`snapshotWarning`, `anchoredStartingBalance*`, `priorStartingBalance*`, `importedAt`. Reusing one
row forever freezes `importedAt`, requires a read-modify-write increment on every charge for a
count nobody reads, and permanently falsifies four columns.

**One batch per manual operation.** `transactionCount: 1` written once, truthful `importedAt`, no
increment path. At ~20 manual entries a month that is ~240 small rows a year in a local SQLite file
with no batch-list UI to clutter. This is *less* code than the lazy-reuse design D6=B specified.
The `isLatestBatch` source filter (T9) is required under either design.

Codex's third option — make `import_batch_id` nullable so manual rows are not batches at all — is
the honest model and is deferred to TODOS: it reworks the
`(account_id, import_batch_id, import_row_hash)` unique index CLAUDE.md rule 3 depends on, which
does not belong in the same PR as migration 0018 and five new write-path guards.

# Test plan

Framework: Vitest (`pnpm test`), `vitest.config.mts`. CLAUDE.md scopes tests to logic, not UI components, so page-level items below are manual-verify.

**Regenerated 2026-09-07 (E14).** The prior artifact read `41/41 paths (100%)`; it predated
T16/T17/T20 and all of E1–E22.

## Coverage diagram

```
CODE PATHS                                              USER FLOWS
[+] src/lib/accounts/accountClass.ts                    [+] Add a credit card
  └── accountClass(type)                                  ├── create acct, type=credit
      ├── checking|savings → asset                        ├── enter 2000 → stored anchor is -200000
      ├── credit|loan     → liability                     │        and dashboard Cash is UNCHANGED
      └── exhaustive switch (new enum = compile error)    ├── balance_source='manual' at create (E4)
                                                          ├── row offers Reconcile, never neither (E4)
[+] src/lib/accounts/isLongTermLiability.ts   ← E7        ├── no credit limit → no bar, but NOT
      ├── loan → true, credit → false                     │        under LONG-TERM (E7)
      └── exhaustive switch                               └── appears under LIABILITIES, not ASSETS

[+] src/lib/accounts/summarizeBalances.ts               [+] Link + track the mortgage
  └── assets-only | liabilities-only | mixed | empty       ├── zero rows STAGED for the loan (E1)
                                                          ├── loan id still IN the fetch (E2)
[+] src/lib/money.ts  moneyTone()                         ├── [REGRESSION R1] a zero-row loan does
      ├── pos/neg/zero in asset context                   │      NOT pin the 45-day floor for the
      └── negative in liability context is NOT alarm-red  │      asset accounts (E2)
                                                          ├── balance pass: anchor + balance_as_of
[+] src/lib/accounts/resolveBalanceAction.ts  ← E4        │      + prior value, NO rows, NO batch
      ├── feed link + no rows → "refresh"                 ├── result reports the anchor move (never
      ├── feed link + rows    → "reconcile"               │      "nothing new" while state changed)
      ├── no feed link        → "reconcile"               ├── feed drops the loan → its own warning
      └── TOTALITY: never returns neither                 └── mortgage payment STILL counts as
                                                                 Housing spend (not paired)
[+] src/lib/accounts/hasAnyTransactionRows.ts ← E16
      ├── EXISTS, NO anchor filter                      [+] Pay the card
      ├── card reconciled to today (rows all before      ├── [→E2E] mark -$500 as payment to Visa
      │   the anchor) is NOT "zero rows"                 ├── PRE-ANCHOR payment ACCEPTED (E5)
      └── one helper, three call sites                   ├── checking leg leaves spend sums
                                                          ├── checking leg leaves categorize backlog
[+] src/lib/accounts/resolveUtilizationDisplay.ts        ├── Visa balance -2000 → -1500
      ├── no credit limit → hasLimit false, no bar       ├── visible via "show transfers" (D14)
      ├── over limit → pct capped at 100                 ├── double-submit → no-op SUCCESS (E10)
      ├── zero balance                                   ├── row paired ELSEWHERE → REFUSE (E10)
      └── normal case                                    └── unmark → mirror DELETED, balance and
                                                                 backlog restored, re-markable (E12)
[+] src/lib/accounts/resolveStalenessDisplay.ts ← E11
      ├── feed   < 7d  / >= 7d  (both sides)           [+] Enter a card charge
      ├── manual < 35d / >= 35d (both sides)             ├── -$80 → balance -1500 → -1580
      └── balance_as_of NULL → falls back to the         ├── categorized charge counts in envelope
             starting_balance_date                       ├── dated <= anchor → REFUSED (D12)
                                                          ├── refund: +$200, category required (E13)
[+] src/lib/accounts/paidDownCents.ts                    ├── refund REDUCES envelope spend
      ├── transfer_pair_id IS NOT NULL AND > 0  ← E13    ├── pre-anchor refund → REFUSED (E13)
      ├── unpaired positive (refund) EXCLUDED            └── NOT auto-paired with a same-day,
      ├── zero-payment month → line omitted                    same-amount checking deposit (D11)
      └── mortgage / no rows
                                                        [+] Reconcile the true balance
[+] src/lib/accounts/manualTransaction.ts                 ├── set balance, date=today
      ├── createCardCharge → 1 row, own batch (E21)      ├── forward and backward moves
      ├── createCardRefund → positive row      (E13)     ├── prior anchor persisted on the acct (E19)
      ├── markAsCardPayment → mirror + 2-way link        ├── balance_source / balance_as_of updated
      ├── unmarkCardPayment → DELETE mirror     (E12)    └── same-day payment + reconcile ordering
      ├── type='loan' target → REJECT          (E17)
      ├── payment to a non-liability → reject           [+] Import a CSV
      ├── CHARGE dated <= anchor → reject      (D12)     ├── Visa NOT in the target picker (E6)
      ├── PAYMENT dated <= anchor → ACCEPT     (E5)      └── liability accountId POSTed directly
      └── idempotency, three-way, in-txn       (E10)            → REFUSED server-side (E6)

[~] src/lib/accounts/loadAccountBalances.ts             [+] Read the Spine on any page
      ├── [★★★ TESTED] existing asset paths               └── shows Cash, not net worth, with a
      ├── liability acct, negative anchor                       mortgage present
      ├── `class` on every row
      └── liability with zero rows == anchor exactly    [+] Dashboard proximity tiles
                                                          ├── 79% → ledger bar
[~] src/lib/accounts/listAccounts.ts          ← E15       ├── 80% → amber
      ├── credit account INCLUDED                         ├── 120% → amber + overflow tick
      └── loan account EXCLUDED (permanently 0 rows)      │        (NOT a redbrown bar)
                                                          └── no allocation + spend → over
[~] src/lib/simplefin/undoSync.ts:40 isLatestBatch
      ├── [★★ TESTED] existing sync-undo               [+] /accounts error + empty states  (E20)
      └── [REGRESSION R2] manual batch must NOT            ├── every action RETURNS state, never
                suppress a sync's undo   ← IRON RULE      │      throws — error.tsx is backstop only
                                                          ├── Reconcile error keeps the input
[~] src/lib/simplefin/sync.ts                 ← E1/E2     ├── Refresh error is inline on the row
      ├── partitionLinkedAccounts: asset vs liability     ├── D12 refusal + "Reconcile instead →"
      ├── liability EXCLUDED from staging                 │      moves focus, announces (DS66)
      ├── liability INCLUDED in accountIds (one fetch)    ├── zero liabilities → DS54 neutral row
      ├── balancesOnly pass, zero-row accounts only       └── /accounts error.tsx + loading.tsx
      ├── runs BEFORE the "up-to-date" early return
      ├── writes anchor + balance_as_of + prior value   [+] Keyboard the ⋯ menu       (E8, manual)
      ├── writes NO transaction rows, NO batch            └── Escape, arrow roving, aria-haspopup,
      ├── provider omits balance-date → skip, warn               focus return to trigger. The
      ├── feed omits a liability → its own warning              component has NEVER RENDERED.
      └── feed unreachable → stale label, not a crash

[~] src/lib/simplefin/resolveStartDate.ts     ← E2      [+] /transactions              (E9)
      └── [REGRESSION R1] fed the ASSET partition          ├── includeTransfers=false excludes
             only; a zero-row liability must not           ├── includeTransfers=true  includes
             widen the window   ← IRON RULE                └── toggle survives pagination via
                                                                 filterValuesToSearchParams
[~] src/lib/simplefin/sync.ts:791 candidate query
      └── excludes import_source='manual'  (D11)

[~] src/lib/categorize/loadTransactions.ts    ← E9/T12
      └── includeTransfers predicate, both states

[~] src/lib/batchLabel.ts:19
      └── 'manual' source renders, does not throw

[~] src/lib/import/validateCreateAccountInput.ts
      ├── credit|loan accepted; junk still rejected
      ├── minimum_payment_cents negative → rejected (E3)
      └── minimum_payment_cents NULL accepted        (E3)

[~] src/app/import/actions.ts
      ├── CSV import to a liability → REFUSED        (E6)
      └── anchor-repair form scoped to assets        (E18)

TARGET COVERAGE: 81/81 paths (100%)  |  1 E2E, 0 eval, 2 REGRESSION, 2 manual-only
```

## Test files

| File | New/extend | Must assert |
|---|---|---|
| `src/lib/accounts/accountClass.test.ts` | new | all four types; exhaustiveness |
| `src/lib/accounts/isLongTermLiability.test.ts` | new | **E7:** loan true, credit false; exhaustiveness |
| `src/lib/accounts/summarizeBalances.test.ts` | new | assets-only, liabilities-only, mixed, empty |
| `src/lib/accounts/resolveBalanceAction.test.ts` | new | **E4:** all three branches + totality (never neither) |
| `src/lib/accounts/hasAnyTransactionRows.test.ts` | new | **E16:** a card whose rows all predate its anchor is NOT zero-row |
| `src/lib/accounts/resolveUtilizationDisplay.test.ts` | new | no limit, over-limit, zero balance, normal |
| `src/lib/accounts/resolveStalenessDisplay.test.ts` | new | **E11:** both sources, both sides of each boundary, NULL `balance_as_of` |
| `src/lib/accounts/paidDownCents.test.ts` | new | **E13:** paired positives only; unpaired refund excluded; zero-payment month; mortgage |
| `src/lib/accounts/manualTransaction.test.ts` | new | every branch above, incl. **E5** (pre-anchor payment accepted, pre-anchor charge refused), **E10** three-way idempotency, **E12** unmark deletes the mirror, **E13** refund, **E17** loan rejected |
| `src/lib/money.test.ts` | extend | `moneyTone` in both contexts, incl. negative-is-normal for liabilities |
| `src/lib/accounts/loadAccountBalances.test.ts` | extend | negative anchor; `class` field; zero-row liability returns the anchor exactly |
| `src/lib/accounts/listAccounts.test.ts` | extend | **E15:** credit included, loan excluded |
| `src/lib/simplefin/undoSync.test.ts` | extend | **REGRESSION R2:** a manual batch newer than a sync batch does not suppress that sync's undo |
| `src/lib/simplefin/resolveStartDate.test.ts` | extend | **REGRESSION R1:** a zero-row liability does not force the 45-day floor for the asset accounts |
| `src/lib/simplefin/matchTransfers.test.ts` | extend | **D11:** manual charge + same-day same-amount deposit are NOT auto-paired |
| `src/lib/simplefin/sync.test.ts` | extend | **E1/E2:** partition (liability not staged, still fetched); balance pass zero-row-only; reported through the early return; no rows/batch written; missing `balance-date` skips; feed omits a liability → warning |
| `src/lib/categorize/loadTransactions.test.ts` | new | **E9/T12:** `includeTransfers` both states |
| `src/lib/batchLabel.test.ts` | extend | `'manual'` renders instead of throwing |
| `src/app/import/actions.test.ts` | extend | `credit`/`loan` accepted by account creation; **E3** min-payment bounds; **E6** CSV import to a liability refused |

## Failure modes

| # | Codepath | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|---|
| F1 | matcher candidate pool | Manual charge auto-paired with an unrelated deposit | D11 test | excluded from candidacy | n/a — prevented |
| F2 | reconcile + back-dated charge | Charge before the anchor never counts | D12 test | write refused | clear refusal + "Reconcile instead →" |
| F3 | `isLatestBatch` | Manual row revokes a sync's undo | REGRESSION R2 | source filter | n/a — prevented |
| F4 | `/sync` balance pass | Feed down; mortgage balance freezes | sync test | staleness label | "as of" goes amber |
| F5 | `markAsCardPayment` | Double-submit creates two mirrors | manualTransaction test | three-way in-txn guard (E10) | second submit is a silent success |
| F6 | `accountClass` | A future enum value defaults to asset | exhaustiveness test | exhaustive switch | compile error |
| F7 | `batchLabel` | `'manual'` source throws on render | batchLabel test | enum handled | n/a — prevented |
| F8 | `/sync` contract | State mutated while UI says "nothing new" | sync test | pass runs before early return, reported in result | anchor move always reported |
| **F9** | **`syncSimpleFin` linked loop (E1)** | **Linking the mortgage imports its transactions, poisons the backlog and Housing spend, and permanently disables its own balance refresh** | sync partition test | liability partitioned out of staging | n/a — prevented |
| **F10** | **`resolveStartDate` (E2)** | **A permanently zero-row liability pins every sync to the 45-day floor forever** | REGRESSION R1 | fed the asset partition only | n/a — prevented |
| **F11** | **`markAsCardPayment` date rule (E5)** | **Pre-anchor payment refused → checking leg unpaired → payment double-counts as spend** | manualTransaction test | D12 scoped to charges only | n/a — prevented |
| **F12** | **`/import` CSV target (E6)** | **CSV imported into a credit card moves its anchor off another account's balance chain, forward-only and silent** | actions test | picker filtered + server-side reject | refusal on the import action |
| **F13** | **`resolveBalanceAction` (E4)** | **A new card renders with neither Refresh nor Reconcile and can never be updated** | totality test | derived from capability, total | n/a — prevented |
| **F14** | **`manualTransaction` target (E17)** | **A charge or payment lands on the mortgage, breaking the zero-row premise under D3/D7/D15/E16** | manualTransaction test | `type='loan'` rejected at the shared entry | refusal |
| **F15** | **`unlinkTransferPair` on a mirror (E12)** | **Unlink strands an uncategorized +$500 row in the backlog, inflates the card balance, and blocks re-pairing** | manualTransaction test | dedicated `unmarkCardPayment` deletes the mirror | balance and backlog restored |
| **F16** | **`hasAnyTransactionRows` (E16)** | **Anchor-filtered count makes a freshly reconciled card eligible for a feed refresh, which D15 forbids** | hasAnyTransactionRows test | `EXISTS`, no anchor filter | n/a — prevented |
| **F17** | **`/accounts` server actions (E20)** | **A thrown action unmounts the route, losing typed input and every inline error DS54–57 specifies** | manual | returned action state, `/sync` pattern | inline error, input preserved |
| **F18** | **`/import` anchor-repair form (E18)** | **A raw signed anchor field lets a positive number be typed for a Visa — the bug T15 was raised to P1 to prevent, in the second form on the same page** | actions test | form scoped to asset accounts | liability rows absent from the form |

**Zero remaining critical gaps.** Every failure mode has a test, error handling, and a visible
outcome. F1, F2, F3, F8 were critical before the first eng review; **F9–F18 were critical before
the second one** (E1–E22) — no test, no handling, and every one of them silent.

# Worktree parallelization

| Step | Modules touched | Depends on |
|------|-----------------|------------|
| S0 **action-shape decision (E20)** | — (spec only) | — |
| S1 `moneyTone` extraction | `src/lib/` (money) | — |
| S2 account class + long-term + summarize + utilization + staleness | `src/lib/accounts/` | — |
| S3 migration 0018 + schema enums (+ E3 min payment, + E19 prior anchor) | `src/db/`, `drizzle/` | — |
| S4 dashboard + Spine rewire | `src/app/page.tsx`, `src/components/ledger/` | S1, S2 |
| S5 `/accounts` route + reconcile | `src/app/accounts/`, `src/lib/import/` | S0, S2, S3 |
| S6 sync partition + balance pass | `src/lib/simplefin/` | S2, S3 |
| S7 manual write path + matcher guard | `src/lib/accounts/`, `src/lib/simplefin/`, `src/lib/batchLabel.ts` | S0, S3, S5, S6 |
| S8 dashboard tiles + delete envelope-card | `src/app/page.tsx`, `src/components/ledger/` | S4 |
| S9 `/transactions` predicate + toggle + `⋯` menu | `src/app/transactions/`, `src/lib/categorize/` | S7 |
| S10 `/import` liability onboarding + guards | `src/app/import/`, `src/lib/import/` | S2, S3 |

```
Lane A:  S1 → S4 → S8          (shared: components/ledger, app/page.tsx)
Lane B:  S2 → S5               (shared: lib/accounts)
Lane C:  S3 → S6 → S7 → S9     (shared: lib/simplefin)
Lane D:  S10                   (shared: app/import, lib/import)

S0 is spec-only and must land FIRST — it decides the server-action shape every
/accounts and manual-write task in lanes B, C and D is written against (E20).
S3 is the only true code bottleneck — land it second, alone.
Launch A + B + C + D after S3 lands (all four need the schema).
```

**Conflict flags:**
- Lanes A and B both end up touching `src/components/ledger/` (S4's Spine edit, S8's tile). Same lane already — kept sequential on purpose.
- Lane B's S5 and Lane C's S7 both touch `src/lib/accounts/`. **Real conflict risk.** S7 depends on S5, so run C's tail after B completes rather than truly in parallel.
- **Lane B's S2 and Lane D's S10 both consume `accountClass` (E6, E15, E18).** S2 only creates it and S10 only imports it, so this is a dependency rather than a conflict — but S10 cannot start before S2 lands.
- **Lane C's S6 and Lane B's S2 both need `hasAnyTransactionRows` (E16).** One helper, three call sites — it belongs in S2, not duplicated into S6.

# NOT in scope

- **Importing credit card transactions from any feed.** Manual charge entry (D10=C) covers the MVP; automated card sync brings its own dedup, pending-row, and `external_id` questions.
- **A per-card detail page.** Explicitly deferred by the user. `/accounts` lists cards; it does not drill in.
- **A reconciled paydown envelope** (`categories.account_id` + fund behavior). Killed for this PR by D13=B — funds are plan-only by construction today. TODO.
- **Payoff modeling** — avalanche/snowball ordering, payoff dates, interest forecasting. Wants a month of real data first.
- **Fixing `TODOS.md` P2** (fund progress = money planned, not moved). Pre-existing; D13=B routes around it.
- **`loadAccountBalances`' N+1** (one aggregate per account inside `.map`, `loadAccountBalances.ts:41-63`, called by the Spine on every render). Real, but better-sqlite3 is synchronous and local and N is 4; the fix touches correctness-critical comments for microseconds of gain. TODO.
- **The other three `moneyTone` call sites** (`_month-editor.tsx`, `summary-strip.tsx`; `envelope-card.tsx` is deleted by D8). Untouched `/budget` code that just shipped through three review cycles. TODO.
- **Back-filling card history before the anchor date.** Direct consequence of D12=B, accepted.
- **Multi-currency, interest accrual, statement periods, minimum-payment *tracking*.** Not V1.
  `minimum_payment_cents` (added by DS64) is static reference data you type once — not tracked,
  not reconciled, not compared against payments made. That distinction is the whole reason it
  dodges this exclusion rather than violating it.

Added by the design review:

- **A per-account detail page, and clickable `/accounts` rows.** The generated mockups all put a
  `>` chevron on every row; it was cut. A drill-in page has almost nothing to show — a card carries
  a handful of manual rows and the mortgage has literally zero by D3=A — so it would be a route
  that renders an empty list. Rows are inert.
- **A debt-ratio advisory.** One mockup invented *"Your debt is 20.7% of your assets. A good rule of
  thumb is to keep this under 30%. Learn more →"*. Invented financial advice with an external link,
  in a local-first app with no such content and no such link. Named here so it cannot wander back in.
- **A 6-month debt trend line.** The right answer to "am I actually getting out of debt", and
  unbuildable today: there is no historical balance series, and the mortgage has no transaction rows
  to reconstruct one from. Revisit alongside payoff modeling, which is deferred for the same reason.
- **A first-run acknowledgement when net worth first goes negative.** Adding a mortgage flips the
  figure from +$11,692 to −$292,935 with no warning. Real, but DS51 defuses most of it by demoting
  net worth to subtotal size, and a one-time interstitial needs per-user state this app has nowhere
  to put.
- **Restyling the rest of `/import`.** DS64 converts the account form only. The CSV upload form and
  the anchor-repair section stay raw `zinc-*`, so the page is visibly half-converted. Accepted —
  a full-page restyle touches the most correctness-critical code in the app for visual reasons.
- **Raising the global type scale to a 16px base.** DS66b sets a prose floor on the new surfaces
  only. The system-wide re-scale is a real finding with a real fix and belongs in its own PR — TODO.
Added by the second engineering review (E1–E22):

- **Making `transactions.import_batch_id` nullable so manual rows are not batches at all.**
  Codex's preferred model and the honest one — a hand-typed row is not an import. Deferred
  because it reworks the `(account_id, import_batch_id, import_row_hash)` unique index CLAUDE.md
  rule 3 depends on for CSV dedup, which does not belong in the same PR as migration 0018 and
  five new write-path guards. E21 ships one batch per manual operation instead. TODO.
- **Snapshotting the database before every anchor-moving write on `/accounts`.** Considered under
  E19 and rejected as over-engineering: a `VACUUM INTO` of the whole ledger before a reversible
  single-column update buys nothing over the persisted prior anchor value, and reconciles are
  routine enough to churn the retention-of-10 pool. Revisit only if `/accounts` ever writes more
  than the anchor.
- **Keeping `/import`'s anchor-repair form available for liability accounts.** E18 scopes it to
  assets. `/accounts` Reconcile is the single anchor surface for liabilities — one per account
  class. Making the repair form liability-aware would duplicate DS64's negate-and-echo logic in
  the most correctness-critical form in the app.
- **Back-filling a mortgage's transaction history.** D3=A is now a server invariant (E1, E6, E17)
  rather than an intention. Un-deferring it means undoing three guards and revisiting D7/D15's
  zero-row scoping, not just flipping a filter.

- **Splitting liabilities into separate "Credit cards" and "Loans" sections.** Three subtotals plus
  net worth is more scaffolding than content at three accounts. DS59's derived muting achieves the
  same hierarchy without the boxes.

# What already exists (reused, not rebuilt)

| Need | Existing code | Reused how |
|---|---|---|
| Envelope proximity rule (item 1) | `src/lib/budget/resolveRowDisplay.ts` | Called directly by the new tile. Zero new logic. |
| Month read model for the tiles | `loadMonthView`, already called at `page.tsx:20` | Same object, no new query. |
| Liability balance from the feed | `listRemoteAccounts` (`link.ts:35-64`), `balancesOnly: true` | Called by the sync balance pass. |
| Balance staleness reasoning | `src/lib/simplefin/balanceFreshness.ts` | Second consumer of the same rule. |
| Legal-anchor bounds | `src/lib/import/accountAnchorFields.ts` | `updateLiabilityBalanceAction` delegates; never reimplements. |
| Manual anchor edit | `updateAccountAnchorAction`, `validateUpdateAnchorInput` | Wrapped with card-appropriate labels, not duplicated. |
| Payment exclusion from spend | `transfer_pair_id IS NULL`, in every spend query | Payments become real pairs. No query changes. |
| Unlinking a wrong payment | `unlinkTransferPair` + `transfer_rejected_partner_id` | Works unchanged. |
| Non-candidate row exclusion | `isAtmWithdrawal` (`matchTransfers.ts:99`) | D11's manual exclusion sits beside it, same rationale. |
| Balance math | `loadAccountBalances` + rule 1 | Unchanged; `STARTING_BALANCE_DOLLARS_MIN = -1_000_000` already admits a mortgage. |
| Transaction filter bar | `src/app/transactions/_filter-bar.tsx` (v0.15.0) | D14's toggle is one more control, not a new bar. |
| Month boundary helpers | `src/lib/budget/monthOfIso.ts` | Any new month math imports from here. Do not write a fifth `monthBoundary`. |

Design reuse — the original table was ten rows of logic reuse and zero rows of design reuse, in a
repo with a 222-line maintained `DESIGN.md` the plan never named:

| Need | Existing code | Reused how |
|---|---|---|
| Design system of record | `DESIGN.md` + `src/app/globals.css` (~50 tokens) | Every DS49–DS68 decision calibrates against it. Three DESIGN.md sections change in the same PR as the code that invalidates them (DS49, DS50, T14). |
| Empty / loading / error / success | `StateCard` (`src/components/ledger/state-card.tsx`) | `/accounts`' four states. No one-off markup. |
| Route error boundary | `RouteErrorCard` (`src/app/_components/RouteErrorCard.tsx`) | `/accounts/error.tsx`, using the `reassurance` slot — the route writes anchors behind rule 5's snapshot guarantee, which is what the slot is for. |
| Mobile collapse of a wide row layout | `MobileCards` (`/budget/[year]/[month]/page.tsx`) | DS65's pattern for both row-list surfaces. The app's only mobile pattern; do not invent a second. |
| Warning surface treatment | `BacklogTile`'s `color-mix(in oklch, var(--accent-amber) …)` | DS57's amber staleness label. Same formula, not a new one. |
| Transfer-paired row color | `--accent-indigo` (DESIGN.md assigns it exactly this meaning) | The rows revealed by D14's transfers toggle. |
| Category picker | `CategoryCombobox` (shared by `/transactions` + `/categorize`) | DS67's required category on the charge dialog. |
| Modal shell | shadcn `Dialog`, proven in `_allocate-form.tsx` (Track D) | DS67's charge dialog. Already a locked component. |
| Toast + 10s Undo | Sonner, as used by `_transaction-row.tsx` | DS61 string 16 — the payment confirmation and its undo. |
| Live-region announcement | `role="status" aria-live="polite"` + `sr-only` (`_month-editor.tsx:360`) | DS66's focus handoff on "Reconcile instead →". |
| Nav glyph idiom | Spine's bare monochrome `◇ ▣ ≡ ! ↻ ★ ⟳ ↥` | DS68's new tab. DS60 cut the tinted circular badges rather than start a second icon system. |
| Money formatting | `formatCents` — parens for negatives | Every liability figure, plus the `aria-label` DS66 adds because parens are silent to a screen reader. |

Found by the second engineering review — existing code the plan had NOT accounted for:

| Need | Existing code | Status |
|---|---|---|
| `⋯` row menu primitive | `src/components/ui/dropdown-menu.tsx` — 99 lines, Base UI `Menu`, built for DS20 | **Already exists, ZERO consumers.** T21 called it `(new)`. Wire it; do not rebuild (E8). |
| Account picker list | `src/lib/accounts/listAccounts.ts` | In the enum widening's blast radius and named in no task. Cards stay, loans filtered out (E15). |
| Sync-window derivation | `src/lib/simplefin/resolveStartDate.ts` + its own `resolveStartDate.test.ts` | Named nowhere in the plan. Its input changes under E2; carries REGRESSION R1. |
| Server-action shape | `/sync`'s returned-state pattern (`src/app/sync/actions.ts`) vs `/import`'s throw+redirect (`src/app/import/actions.ts:66-91`) | `/accounts` uses the `/sync` pattern. The plan pointed at the throwing one (E20). |
| Anchor-repair form | `updateAccountAnchorAction` + `validateUpdateAnchorInput` | Reused for assets; **scoped away from liabilities** so Reconcile is their only anchor surface (E18). |
| Pre-write snapshot | `createSnapshot` — exactly two production callers, `importBatch.ts:305` and `sync.ts:351` | **Not** called by any anchor write. DS54–57's reassurance copy corrected (E19). |
| Anchor rollback record | `import_batches.prior_starting_balance_cents/_date` | The pattern D7 mirrors; the equivalent account-row columns were missing from T4 (E19). |

---

## Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding above.

- [x] **T1 (P1, human: ~3h / CC: ~15min)** — `src/lib/money.ts` — extract `moneyTone(cents, {context})`, own commit, before any liability work
  - Surfaced by: Code Quality D9 — the sign→token rule exists six times and `spine.tsx:92-95` already diverged
  - Files: `src/lib/money.ts`, `src/lib/money.test.ts`
  - Verify: `pnpm test money`
- [x] **T2 (P1, human: ~2h / CC: ~10min)** — `src/lib/accounts/` — `accountClass.ts` with an exhaustive switch + test
  - Surfaced by: Architecture — failure mode F6, a new enum value silently defaulting to asset
  - Files: `src/lib/accounts/accountClass.ts`, `.test.ts`
  - Verify: `pnpm test accountClass`
- [x] **T3 (P1, human: ~3h / CC: ~15min)** — `src/lib/accounts/` — `summarizeBalances.ts` + test
  - Surfaced by: Step 0 — `page.tsx:63` and `spine.tsx:40` flat-sum every account
  - Files: `src/lib/accounts/summarizeBalances.ts`, `.test.ts`
  - Verify: `pnpm test summarizeBalances`
- [x] **T4 (P1, human: ~4h / CC: ~20min)** — `src/db/` — migration 0018: three enum widenings + `credit_limit_cents`, `balance_as_of`, `balance_source`, **`minimum_payment_cents` (E3)**, **`prior_starting_balance_cents` / `prior_starting_balance_date` on `accounts` (E19)**
  - Surfaced by: Architecture D6/D15 — enums need no SQL, the columns do. **E3: `minimum_payment_cents` is rendered in four places (DS61 #14, DS65, the mockup, T15) and was created by no migration. E19: D7 says the prior anchor 'goes on the account row itself' and T4 never added those columns.** Six columns, not three — 0018 is this PR's only migration.
  - Files: `src/db/schema.ts`, `drizzle/0018_*.sql`
  - Verify: `pnpm db:migrate` then `pnpm test`
- [x] **T5 (P1, human: ~1d / CC: ~35min)** — `src/app/page.tsx`, `src/components/ledger/spine.tsx` — segment totals; relabel "Total" → "Cash"; **convert the dashboard balance section from the `AccountTile` grid to ruled row-lists (DS49)**; **Spine peek filters to assets only (DS50)**; **update DESIGN.md §Navigation ASCII + §Dashboard layout in this PR**
  - Surfaced by: D4=A — the rail silently becomes net worth on every page; DS49/DS50 — Codex hard rejections #1 + #7, and a `Cash` subtotal that visibly excludes the mortgage row above it
  - Files: `src/app/page.tsx`, `src/components/ledger/spine.tsx`, `src/app/globals.css`, `DESIGN.md`
  - Verify: manual — dashboard + rail with a mortgage present, at 1280px and 375px
- [x] **T6 (P1, human: ~2d / CC: ~1h)** — `src/app/accounts/` — new route + `updateLiabilityBalanceAction` delegating to `validateUpdateAnchorInput`; **grouped ruled row-lists per the approved mockup**; per-row Reconcile/Refresh, mutually exclusive (DS55); zero-liabilities row (DS54); staleness labels (DS57); muted long-term treatment (DS59); `StateCard`/`RouteErrorCard` boundaries; `MobileCards` collapse (DS65)
  - Surfaced by: D10=C path 3 — reconcile needs its own labelled home; DS54–DS59 — the plan specified one line of UI for this whole route
  - Files: `src/app/accounts/{page,actions,error,loading}.tsx`, `src/app/accounts/_account-row.tsx`
  - Verify: manual against `variant-D-remix.png` + `pnpm test` on the validator
- [x] **T7 (P1, human: ~1d / CC: ~30min)** — `src/lib/simplefin/sync.ts` — **`partitionLinkedAccounts` (E1/E2)** + balance pass, zero-row accounts only, before the early return
  - Surfaced by: D15=A + Codex — `balance-date` is an instant, and `sync.ts:342` returns "up-to-date" before writes. **E1/E2: `sync.ts:175-179` has no type filter, so linking the mortgage imports its transactions and then permanently disables this very pass. Must PARTITION not exclude — liability ids stay in `accountIds` at `sync.ts:197` or there is no balance to write — and `resolveStartDate` reads the asset partition only.**
  - Files: `src/lib/simplefin/sync.ts`, `sync.test.ts`, `src/lib/simplefin/resolveStartDate.test.ts`, `src/app/sync/actions.ts`
  - Verify: `pnpm test sync resolveStartDate` — incl. **REGRESSION R1**
- [x] **T8 (P1, human: ~1d / CC: ~35min)** — `src/lib/accounts/manualTransaction.ts` — charge + payment write path, `'manual'` source end to end
  - Surfaced by: D6=B + D10=C + Codex — third write path, `batchLabel.ts:19` throws on unknown source
  - Files: `src/lib/accounts/manualTransaction.ts`, `.test.ts`, `src/lib/batchLabel.ts`, `src/db/schema.ts`
  - Verify: `pnpm test manualTransaction batchLabel`
- [x] **T9 (P1, human: ~2h / CC: ~10min)** — `src/lib/simplefin/undoSync.ts` — **REGRESSION:** `isLatestBatch` ignores manual batches; test first
  - Surfaced by: D6 — `undoSync.ts:40-48` has no source filter, so one manual row kills a sync's undo silently
  - Files: `src/lib/simplefin/undoSync.ts`, `undoSync.test.ts`
  - Verify: `pnpm test undoSync`
- [x] **T10 (P1, human: ~2h / CC: ~10min)** — `src/lib/simplefin/sync.ts:791` — exclude `import_source='manual'` from matcher candidacy + test
  - Surfaced by: D11 — a manual charge can be silently auto-paired with an unrelated same-day, same-amount deposit
  - Files: `src/lib/simplefin/sync.ts`, `matchTransfers.test.ts`
  - Verify: `pnpm test matchTransfers`
- [x] **T11 (P1, human: ~3h / CC: ~15min)** — `src/lib/accounts/manualTransaction.ts` — refuse rows dated on/before the anchor
  - Surfaced by: D12=B — rule 1's strict `>` silently drops a back-dated charge from the balance
  - Files: `src/lib/accounts/manualTransaction.ts`, `.test.ts`
  - Verify: `pnpm test manualTransaction`
- [x] **T12 (P2, human: ~2h / CC: ~10min)** — `src/lib/categorize/` — `includeTransfers` predicate on `loadTransactions` **(data layer only — T26 owns all UI)**
  - Surfaced by: D14=B + Codex — `loadTransactions.ts:67` excludes paired rows, so a marked payment vanishes. **E9: T12 and T26 were the same feature with contradictory placement, both live. Split on the lib/UI seam this plan uses everywhere else; the predicate has two states and one of them has never been exercised.**
  - Files: `src/lib/categorize/loadTransactions.ts`, `loadTransactions.test.ts`
  - Verify: `pnpm test loadTransactions` — both states
- [x] **T13 (P2, human: ~6h / CC: ~30min)** — `src/app/page.tsx` — "Closest to limit" **ruled list** (not tiles) via `resolveRowDisplay`, severity sort, 5 desktop / 3 mobile, section omitted when empty (DS53)
  - Surfaced by: Step 0 — item 1's rule already exists; DS53 — `barPct` is capped at 100 *and* zero-allocation overspend flattens to exactly 100, so sorting by it ranks nothing
  - Files: `src/app/page.tsx`
  - Verify: manual — 79% / 80% / 120% / no-allocation-with-spend must produce four distinct positions
- [x] **T14 (P2, human: ~2h / CC: ~10min)** — `src/components/ledger/` — delete `envelope-card.tsx` and its dead `.envelope` CSS if unadopted; **remove DESIGN.md §"Envelope card"** (it documents the deleted file as "the signature component")
  - Surfaced by: D8=A — zero callers, drifted copy of `resolveRowDisplay`'s tone rule
  - Files: `src/components/ledger/envelope-card.tsx`, `src/app/globals.css`, `DESIGN.md`
  - Verify: `pnpm build`
- [x] **T15 (P1, human: ~1d / CC: ~40min)** — `src/lib/import/`, `src/app/import/` — `credit`/`loan` in the create-account enum and `<select>`; **"Balance owed" positive-input-negated-internally flow, replaced helper copy, confirmation echo, `credit_limit_cents` + `minimum_payment_cents` fields (DS64)**; **restyle the account form to Ledger Paper tokens**
  - Surfaced by: Architecture — the enum needs no SQL, but three TypeScript sites gate it; DS64 + Codex F1 — the live form is asset-worded with no sign guidance, so `2000` for a Visa adds $2,000 to Cash, silently. **Priority raised P2 → P1: this is a ledger-corruption path, not a polish item.**
  - Files: `src/lib/import/validateCreateAccountInput.ts`, `src/app/import/page.tsx`, `src/app/import/actions.ts`, `src/app/import/actions.test.ts`
  - Verify: `pnpm test import` + manual — create a `credit` account entering `2000`, assert the stored anchor is `-200000` and the dashboard `Cash` is unchanged. **See T36 for the two guards on the same page (E6 CSV target, E18 anchor-repair form).**

### Design review tasks (DS49–DS68)

- [x] **T16 (P1, human: ~3h / CC: ~15min)** — `src/lib/accounts/` — `resolveUtilizationDisplay(balanceCents, creditLimitCents) → {pct, hasLimit}` + test; always terracotta, no threshold
  - Surfaced by: DS62 — computing pct inline would recreate, in this PR, the duplication D8/D9 exist to delete; a rule in JSX is untestable here
  - Files: `src/lib/accounts/resolveUtilizationDisplay.ts`, `.test.ts`
  - Verify: `pnpm test resolveUtilizationDisplay` — no limit, over-limit, zero balance
- [x] **T17 (P1, human: ~4h / CC: ~20min)** — `src/lib/accounts/` — `paidDownCents(accountId, year, month)` + test; two callers (card row, dashboard `Debt`)
  - Surfaced by: DS58 — D13=B correctly makes a payment invisible to spend, leaving no feedback anywhere that you paid down debt
  - Files: `src/lib/accounts/paidDownCents.ts`, `.test.ts`, `src/app/accounts/page.tsx`, `src/app/page.tsx`
  - Verify: `pnpm test paidDownCents` — zero-payment month omits the line; mortgage (no rows) returns null, not 0
- [x] **T18 (P1, human: ~4h / CC: ~20min)** — `src/app/accounts/` — "Add a charge" `Dialog`: amount, date, merchant, **required** category via `CategoryCombobox`
  - Surfaced by: DS67 — D10 path 2 had a data model and no interface; a NULL-category charge silently breaks D13's argument for that row
  - Files: `src/app/accounts/_charge-dialog.tsx`, `src/app/accounts/actions.ts`
  - Verify: manual — charge appears in its envelope on `/budget` in the month charged
- [x] **T19 (P1, human: ~4h / CC: ~20min)** — `src/app/accounts/` — D12 refusal message + inline "Reconcile instead →" prefilled with today, focus moved to the balance field and announced
  - Surfaced by: DS56 + DS66 — the plan specified the refusal and none of its words or its recovery
  - Files: `src/app/accounts/_charge-dialog.tsx`, `src/app/accounts/_reconcile-form.tsx`
  - Verify: manual — enter a charge dated before the anchor; refusal appears, the link opens reconcile focused
- [x] **T20 (P1, human: ~3h / CC: ~15min)** — `src/lib/accounts/` — staleness classifier: `balance_as_of ?? starting_balance_date`, amber at 7d (`feed`) / 35d (`manual`) + test
  - Surfaced by: DS57 — the plan's 7-day rule reads `balance_as_of`, which D10 path 3 sets to NULL on every manual reconcile, i.e. on every credit card
  - Files: `src/lib/accounts/classifyBalanceStaleness.ts`, `.test.ts`
  - Verify: `pnpm test classifyBalanceStaleness` — both sources, both sides of each boundary, NULL `balance_as_of`
- [x] **T21 (P1, human: ~2h / CC: ~10min)** — `src/app/transactions/` — wire the **EXISTING** `DropdownMenu` into a `⋯` row menu holding "Mark as payment to →"
  - Surfaced by: DS52 + DS63 — the row already carries ten elements. **E8: `src/components/ui/dropdown-menu.tsx` ALREADY EXISTS (99 lines, Base UI `Menu`, built for DS20) with ZERO consumers, verified by grep across `src/`. It is not new. DS63's "deliberate fifth component" premise is false in both directions. Spend the halved budget exercising the keyboard behaviour instead — the component has never rendered.**
  - Files: `src/components/ui/dropdown-menu.tsx` (**existing — import, do not create**), `src/app/transactions/_transaction-row.tsx`
  - Verify: manual — keyboard only: open, arrow, Escape, focus returns to the trigger
- [x] **T22 (P1, human: ~4h / CC: ~20min)** — a11y sweep on every new always-negative figure: `aria-label` for parens, `sr-only` LONG-TERM heading, `aria-hidden` on the utilization bar, 44px touch targets
  - Surfaced by: DS66 — DESIGN.md mandates parens for negatives, and parens are silent to a screen reader
  - Files: `src/app/accounts/`, `src/app/page.tsx`, `src/components/ledger/spine.tsx`
  - Verify: manual — VoiceOver reads "owed two thousand one hundred forty eight dollars", not "dollar 2,148"
- [x] **T23 (P2, human: ~6h / CC: ~30min)** — `src/app/accounts/`, `src/app/page.tsx` — `MobileCards`-style collapse below 640px on both row-list surfaces
  - Surfaced by: DS65 — the approved row packs seven fields into 880px and is unusable at 375px
  - Files: `src/app/accounts/_account-row.tsx`, `src/app/page.tsx`
  - Verify: manual at 375px — nothing truncated, action button ≥44px
- [x] **T24 (P2, human: ~2h / CC: ~12min)** — `src/components/ledger/spine.tsx` — "Accounts" tab in position 2; peek header becomes a `<Link>` with a visible affordance
  - Surfaced by: DS68 — a top-level route with no nav entry is reachable only by URL and fails the trunk test
  - Files: `src/components/ledger/spine.tsx`, `src/app/globals.css`, `DESIGN.md`
  - Verify: manual — tab highlights on `/accounts`; peek header is obviously clickable without hover
- [x] **T25 (P2, human: ~3h / CC: ~12min)** — apply the DS61 copy deck + register across every new string; prose floor at `--text-base`
  - Surfaced by: DS61 + DS66b — twelve unwritten strings, three of which leak the storage model at the user
  - Files: `src/app/accounts/`, `src/app/import/page.tsx`, `src/app/transactions/`
  - Verify: manual — grep the new surfaces for `anchor`, `starting balance`, `transfer pair`; expect zero user-visible hits
- [x] **T26 (P2, human: ~4h / CC: ~20min)** — `src/app/transactions/` — "show transfers" toggle **beside the result summary**, not inside the filter slab; revealed rows carry the `--accent-indigo` paired chip and name their partner account
  - Surfaced by: D14=B + Codex F5 — the filter card already holds eight controls, and a visibility switch on the result set is not a filter narrowing it
  - Files: `src/app/transactions/_transactions-ui.tsx`, `src/app/transactions/_filter-bar.tsx`, `src/lib/categorize/loadTransactions.ts`
  - Verify: manual — toggle survives pagination (must be carried by `filterValuesToSearchParams`, or page 2 silently drops it)
- [x] **T27 (P3, human: ~2h / CC: ~10min)** — `DESIGN.md` — document the three new visual concepts: the terracotta utilization bar, the muted long-term money weight, and `DropdownMenu` as the fifth locked shadcn component
  - Surfaced by: Pass 5 — DESIGN.md defines exactly three money states and TODOS locks exactly four shadcn components; this PR adds one of each and a bar variant
  - Files: `DESIGN.md`, `TODOS.md`
  - Verify: read-through — no undocumented token or component introduced by this PR


### Second eng-review tasks (E1–E22)

- [x] **T28 (P1, human: ~3h / CC: ~15min)** — `docs/plans/` + `src/app/accounts/` — **decide and record the server-action shape BEFORE any `/accounts` action is written: returned state, `/sync`-style; `error.tsx` is the backstop only**
  - Surfaced by: E20 (Codex #4) — DS54–57 promises inline row errors, a form that keeps your input, a toast with the row restored, and DS56's focus handoff. A thrown action unmounts the route and none of those survive. T6 delegates to `validateUpdateAnchorInput`, whose existing caller `updateAccountAnchorAction` (`import/actions.ts:66-91`) is throw-and-redirect — the path of least resistance is the wrong pattern.
  - Files: this plan (S0 in the parallelization table), then `src/app/accounts/actions.ts`
  - Verify: read-through — no `throw` in any `/accounts` action; every one returns a typed result
- [x] **T29 (P1, human: ~3h / CC: ~15min)** — `src/lib/accounts/` — `resolveBalanceAction(account, hasAnyRows)`, total over both inputs; set `balance_source='manual'` at account creation
  - Surfaced by: E4 — `balance_source` is nullable and nothing set it at creation, so DS55's "never both, never neither" failed for every new card, and DS57's threshold table had no NULL row. Capability is derived; history is stored.
  - Files: `src/lib/accounts/resolveBalanceAction.ts`, `.test.ts`, `src/app/import/actions.ts`
  - Verify: `pnpm test resolveBalanceAction` — three branches + totality
- [x] **T30 (P1, human: ~2h / CC: ~10min)** — `src/lib/accounts/` — `hasAnyTransactionRows(accountId)`: `EXISTS`, **no anchor filter**, one helper for D7's scope, E1's partition and T29
  - Surfaced by: E16 — "zero transaction rows" was undefined. `loadAccountBalances`'s existing anchor-filtered aggregate makes the count free and wrong: reconcile a card to today and every row it owns sits before the anchor, making it "zero-row" and therefore eligible for a feed refresh, which D15 forbids.
  - Files: `src/lib/accounts/hasAnyTransactionRows.ts`, `.test.ts`
  - Verify: `pnpm test hasAnyTransactionRows` — a card reconciled to today is NOT zero-row
- [x] **T31 (P1, human: ~2h / CC: ~10min)** — `src/lib/accounts/` — `isLongTermLiability(type)` exhaustive switch; rewire DS59 so the bar reads `credit_limit_cents` and LONG-TERM/muted reads `type`
  - Surfaced by: E7 — DS59 derived the muted LONG-TERM treatment from the absence of `credit_limit_cents`, which DS64 makes optional, so a card added without a limit rendered as a mortgage. DS59's own last sentence has the answer.
  - Files: `src/lib/accounts/isLongTermLiability.ts`, `.test.ts`, `src/app/accounts/_account-row.tsx`
  - Verify: `pnpm test isLongTermLiability` + manual — a credit account with no limit shows no bar and is NOT under LONG-TERM
- [x] **T32 (P1, human: ~5h / CC: ~25min)** — `src/lib/accounts/manualTransaction.ts` — three guards in the shared write path: **D12 scoped to charges/refunds only (payments accept any date)**, **three-way in-transaction idempotency**, **`type='loan'` rejected**
  - Surfaced by: E5 — the anchor defaults to today, so D12-as-written failed "Mark as payment" for 100% of existing history AND left each checking leg unpaired, double-counting the payment as spend. E10 — "idempotency guard" named no key, and guarding on `transfer_pair_id IS NOT NULL` alone silently succeeds on a row the matcher already auto-paired elsewhere. E17 (Codex #1) — nothing stopped a charge or payment landing on the mortgage, which is the premise D3/D7/D15/E16 all rest on.
  - Files: `src/lib/accounts/manualTransaction.ts`, `.test.ts`
  - Verify: `pnpm test manualTransaction` — pre-anchor payment ACCEPTED, pre-anchor charge REFUSED, all three idempotency branches, loan target rejected
- [x] **T33 (P1, human: ~4h / CC: ~20min)** — `src/lib/accounts/` + `src/app/accounts/` — `unmarkCardPayment`: clear both `transfer_pair_id`s and **DELETE** the synthetic mirror; no rejection marker. Two entry points — the DS61 10s Undo and the row menu.
  - Surfaced by: E12 — `unlinkTransferPair` was built for two real bank rows the matcher wrongly joined. Applied to a synthetic mirror it strands a category-NULL row in the backlog (`spine.tsx:24-32` counts exactly that state), leaves the card balance inflated, and rejection-marks the pair so re-pairing is blocked.
  - Files: `src/lib/accounts/manualTransaction.ts`, `.test.ts`, `src/app/accounts/actions.ts`
  - Verify: `pnpm test manualTransaction` — mirror deleted, balance restored, backlog count unchanged, row re-markable to another card
- [x] **T34 (P1, human: ~4h / CC: ~20min)** — `src/app/accounts/` + `src/lib/accounts/` — charge/refund sign choice in DS67's dialog (category still required); narrow `paidDownCents` to `transfer_pair_id IS NOT NULL AND amount_cents > 0`
  - Surfaced by: E13 — a return has nowhere to go, so the envelope keeps money you got back; and `paidDownCents = SUM(> 0)` is correct today only because the payment mirror is the only positive row a card can have. Everything downstream already handles a positive card row.
  - Files: `src/app/accounts/_charge-dialog.tsx`, `src/lib/accounts/paidDownCents.ts`, `.test.ts`
  - Verify: `pnpm test paidDownCents` — an unpaired positive row is EXCLUDED
- [x] **T35 (P1, human: ~4h / CC: ~20min)** — `src/app/import/` — two guards on one page: **filter the CSV target `<select>` to assets AND reject a liability `accountId` in the import action (E6)**; **scope the anchor-repair form to asset accounts (E18)**
  - Surfaced by: E6 — `import/page.tsx:17` selects all accounts unfiltered and feeds the CSV target at `:105-116`, so after T15 a CSV imported into the Visa moves its anchor off another account's balance chain, forward-only and silent. E18 (Codex #2) — the anchor-repair form at `:29` is a raw signed twin of Reconcile, reintroducing the exact bug T15 was raised to P1 to prevent, in the second form on the same page.
  - Files: `src/app/import/page.tsx`, `src/app/import/actions.ts`, `actions.test.ts`
  - Verify: `pnpm test import` — liability `accountId` POSTed directly to the CSV action is refused
- [x] **T36 (P1, human: ~2h / CC: ~10min)** — `src/app/accounts/error.tsx` — reassurance copy states the **real** guarantee: the previous balance and date are kept and the change is one click to reverse
  - Surfaced by: E19 (Codex #3) — DS54–57 justified the `reassurance` slot on "rule 5's snapshot guarantee." Verified false: `createSnapshot` has exactly two production callers, `importBatch.ts:305` and `sync.ts:351`, and no anchor write is one of them. A reassurance shown at the moment something broke must not be a false one.
  - Files: `src/app/accounts/error.tsx`
  - Verify: read-through — the string names the prior-anchor mechanism, not a snapshot
- [x] **T37 (P2, human: ~1h / CC: ~5min)** — `src/lib/accounts/listAccounts.ts` — filter long-term liabilities out of the picker; credit cards stay
  - Surfaced by: E15 — `listAccounts.ts:17` selects every account with no type filter and feeds the `/transactions` account filter. The Visa appearing is good and unplanned; the mortgage appearing is a permanently-empty option, since D3=A is now enforced on both write paths by E1 and E6.
  - Files: `src/lib/accounts/listAccounts.ts`, `listAccounts.test.ts`
  - Verify: `pnpm test listAccounts` — credit included, loan excluded
- [x] **T38 (P2, human: ~2h / CC: ~10min)** — `src/lib/accounts/manualTransaction.ts` — one `import_batches` row **per manual operation**, not one reused forever
  - Surfaced by: E21 (Codex #5) — every column on that table is scoped to one atomic write. Reuse freezes `importedAt`, requires a read-modify-write increment on `transaction_count` for a number nobody reads, and permanently falsifies four columns. This is *less* code than the lazy-reuse design D6=B specified.
  - Files: `src/lib/accounts/manualTransaction.ts`, `.test.ts`
  - Verify: `pnpm test manualTransaction` — two charges produce two batches, each `transaction_count: 1`
- [x] **T39 (P1, human: ~1h / CC: ~5min)** — this plan — restate the founding premise: identical storage and aggregation, divergent write paths and refresh models
  - Surfaced by: E22 (Codex, "main miss") — "a credit card and a mortgage are one feature" is right about storage and wrong about behaviour, and the gap generated nine divergence bugs (D3, D15, DS59, E4, E5, E7, E16, E17, and Codex #1). The remedy is a paragraph, not a re-architecture: the shared column is the expensive half and is why they still ship as one PR.
  - Files: `docs/plans/liability-accounts-and-budget-signals.md` (§"The insight that shapes this plan")
  - Verify: read-through — the opening section names both columns of the E22 table

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| `/accounts` | `~/.gstack/projects/thehashrocket-my_money_manager/designs/accounts-page-20260906/variant-D-remix.png` | Grouped ruled row-lists, subtotal as the last row inside each panel, ledger double-rule above net worth. Variant A's layout + variant B's inline utilization bar + variant C's MIN. PAYMENT / UPDATED columns. | **Corrections that override the image:** subtotal rows get no icon, no chevron, no timestamp and a recessed surface (the mockup renders `Cash`/`Debt` as clickable-looking accounts); net worth at subtotal size, not oversized (DS51); no icon badges at all (DS60); no chevrons — rows are inert (D2=C); mortgage muted under a `LONG-TERM` sub-label (DS59). Variants A/B/C are in the same directory for reference; `design-board.html` is the comparison board. |

**The ASCII layout diagram at the top of the Design specification is the authoritative reference, not the PNG.** A clean regeneration was attempted (`variant-E-final.png`) and **rejected** — do not use it and do not re-run it expecting better. It honored the negative constraints (no icons, no chevrons, recessed subtotals, net worth not oversized) but invented an entirely different product around them: "Personal Ledger" branding, a five-cell KPI strip (NET WORTH / ASSETS / LIABILITIES / MONTHLY DELTA / YTD DELTA), brokerage / retirement / real-estate / vehicle accounts that this app does not model and V1 explicitly excludes, account numbers, minus-sign negatives instead of DESIGN.md's mandated parens, no utilization bar, no per-row actions, no paid-down line, no `LONG-TERM` grouping — and an amber advisory note reading *"Credit Card – Visa balance is 81% of your $3,000.00 credit limit"*, which is the exact invented-financial-advice pattern DS62 and the NOT-in-scope list both rule out. Kept in the directory as a record of the failure, not as a reference.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 3 | ISSUES_FOUND | 17 findings, 17 folded into the plan |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR (PLAN) | 35 issues, 0 critical gaps remaining |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score: 3/10 → 9/10, 20 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** Three runs across three review stages. *Eng stage 1:* 6 issues; three changed the plan materially — SimpleFIN `balance-date` is an instant, not a close-of-day anchor (D15 narrowed the feed refresh); `categorizeTransaction.ts:79` rejects `kind='fund'` so a paydown fund could never reconcile (D13 dropped it); `loadTransactions.ts:67` hides every paired row (D14 added a toggle). *Design stage:* hard rejection on two counts (#1 generic SaaS card grid, #7 stacked cards instead of layout), both closed by DS49; it also caught that `barPct` is capped at 100 *and* flattens zero-allocation overspend to exactly 100, which invalidated the design review's own proposed sort and produced DS53. *Eng stage 2:* 5 findings plus a challenge to the founding premise, all real and all folded — the manual write path never rejected `type='loan'` (E17), `/import`'s anchor-repair form is a raw signed twin of the reconcile flow T15 exists to fix (E18), D7's prior-anchor columns were missing from the migration and `/accounts`' reassurance copy claimed a snapshot guarantee that does not exist (E19, verified: `createSnapshot` has exactly two production callers), DS54–57's entire error spec requires returned action state while the code T6 delegates to throws (E20), and "one manual batch reused forever" falsifies four columns of a table scoped to atomic writes (E21).

**CROSS-MODEL:** 13 + 22 eng findings, 20 design decisions, 17 Codex findings across three passes. Codex overturned three eng recommendations across the two eng stages (D5's paydown fund, D7's unscoped feed refresh, D6's reused manual batch) and corrected one design recommendation (the proximity sort). One tension was resolved against Codex on the merits: its "main miss" — that `loan` and `credit` are not one feature — is correct about behaviour and wrong about remedy, since the shared storage and aggregation half is the expensive half; E22 restates the premise rather than splitting the feature, and names the nine divergences the old wording produced. All findings revised rather than defended. No unresolved tension.

**Second-review shape.** The 22 E-findings are concentrated where you would predict: **12 of them land on the design review's 12 previously-uninspected tasks** (T16–T27) or on decisions those tasks introduced. The other 10 are things two reviews and two Codex passes walked past — most sharply E1, where D3=A's load-bearing "the mortgage never gets a transaction row" was asserted in prose across four decisions and enforced by no code, and would have self-disabled D7 after one sync.

**VERDICT:** ENG + DESIGN CLEARED — ready to implement. 15 + 20 + 22 decisions locked, 39 implementation tasks, **10 further critical gaps (F9–F18) closed before any code was written** — every one of them previously had no test, no handling, and a silent outcome. Two IRON-RULE regression tests folded (R1 `resolveStartDate` must not let a zero-row liability pin the 45-day floor; R2 `isLatestBatch` must ignore manual batches). Coverage artifact regenerated from a stale `41/41` to `81/81`. One priority change beyond T15's earlier P2 → P1: **T28 (server-action shape) must land before any `/accounts` action is written** — it is spec-only, and getting it wrong invalidates most of DS54–57.

NO UNRESOLVED DECISIONS