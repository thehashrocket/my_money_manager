# Plan — zero-based (EveryDollar-style) budgeting

Status: **reviewed, ready to implement**
Branch: `thehashrocket/envelope-budgeting-plan`
Scope decided 2026-09-04 (decision `0e52e0af`): **PR1 + PR2 now, PR3 deferred.**
Scope refined 2026-09-04 (eng review round 2, decisions `D1` and `X6`):
**PR1 → PR1a + PR1b · PR2 → PR2a + PR2b.** Nothing cut; four merges instead of two.
Design review round 2 (`DS25`–`DS48`) re-checked the four-merge split for screens
that are only half-built when the first half ships. **Rebase onto `origin/main`
before starting: `0016` is taken** (see §4.1).
Eng review round 3 (`E1`–`E15`) re-ran that same seam check one merge earlier, at
PR1a↔PR1b, and read the migration SQL against the live schema. **PR1a is no longer
claimed to be invisible** (`E1`), `0017` now creates the two columns it was already
writing to (`E2`, `E7`), and migration `0018` is deleted — `archived_at` moves
forward with it, so PR2a ships no schema change at all.

Goal: make `my_money_manager` a zero-based budget in the EveryDollar sense — every
dollar of expected income is assigned a job before the month starts, and the app
tells you when the assignment is complete.

## Decision ID key (read this before grepping)

Three review rounds wrote decisions into this plan and the first two collided:
`D2A`–`D14A` each meant one thing in the eng pass and a different thing in the
design pass. Round 2 (`A3`) renumbered them. Current scheme:

| Prefix | Round | Example | Meaning |
|---|---|---|---|
| `D1B`, `D2A`–`D14A` | eng review round 1 | `D9A` | kind changeable only on an unused category |
| `DS1`–`DS24` | design review round 1 (was `D1A`–`D24A`) | `DS9` | restyle the whole budget surface |
| `A1`–`A8`, `C1`–`C5`, `TS1`–`TS5`, `P1`–`P3`, `X1`–`X6` | eng review round 2 | `P1` | rollover is a clamped prefix scan |
| `DS25`–`DS48` | design review round 2 | `DS31` | every PR1b CTA must be backed by PR1b machinery |
| `E1`–`E15` | eng review round 3 | `E2` | `0017` must create `sort_order` before inserting into it |
| `TC1`–`TC41` | tests (was `T1`–`T29`) | `TC7` | B1 regression |
| `T1`–`T34` | implementation tasks | `T3` | read model |

`T` is now unambiguously a task and `TC` unambiguously a test. Before round 2,
task `T29` and test `T29` were different things and several `Verify:` fields
pointed at the wrong one.

---

## 1. What already exists

The schema is about 70% of the way there. This plan reuses it rather than
building a parallel budgeting engine.

| EveryDollar concept | Already implemented by | Reused as-is? |
|---|---|---|
| Budget group → line item | `categories.parent_id`; parents are header-only, leaves carry allocations | **structure yes, data no — see below** |
| Planned amount, per line, per month | `budget_periods (category_id, year, month, allocated_cents)` | yes — **also used for planned income** |
| Spent per line | `computeMtdSpent` (`src/lib/budget.ts:135`) | refactored, not replaced |
| Remaining per line | `LeafRow.remainingCents` (`loadMonthView.ts:115`) | yes |
| Fund / sinking fund | `categories.carryover_policy = 'rollover'` + `getEffectiveAllocation` | yes — PR3 surfaces it |
| Fund target | `categories.target_cents` | yes — PR3 |
| Transaction lands on a budget line | `buildRuleMatcher` / `applyRuleAtImport`, wired into both write paths | yes, **plus a sign guard (X2)** |
| Rollover cache invalidation | `invalidateForwardRollover` | kept, documented as inert (P3) |
| Group / line rendering, mobile cards, money formatting | `/budget/[year]/[month]/page.tsx`, `formatCents` | yes |
| Set-based per-category month aggregate | `loadPendingByCategory` (`loadMonthView.ts:129`) | **yes — copy this shape for T11** |
| Month key parsing | `src/lib/budget/monthOfIso.ts` (`parseIsoMonth`) | yes — becomes the home for all four helpers (D4A) |
| Decimal-string → cents, with a safe-integer guard | `parseAmountToCents` (`src/lib/simplefin/parseAmount.ts:18`) | **yes — moves to `src/lib/money.ts` (C4)** |

**Category groups exist in the schema and in zero rows.** Measured against the
seeded database on 2026-09-04:

```
sqlite> select count(*), sum(parent_id is not null) from categories;
50|0
sqlite> select count(*) from categories where is_savings_goal = 1;
0
```

The only `insert(schema.categories)` in `src/` is `createGoalAction`
(`goals/actions.ts:18`), which writes no `parentId`; no migration writes
`parent_id`. So today `loadMonthView` renders exactly one synthetic section
whose header is the literal string `"Ungrouped"` (`page.tsx:192`, `:324`) over
all 50 categories, and nothing in the app can create a group until PR2b.
**A1 fixes this in migration `0017`** — see §4.1.

**What is genuinely missing:** the word `income` does not appear anywhere in
`src/`, `drizzle/`, or `docs/`. Zero-based budgeting is
`planned income − planned allocations = 0`; the left operand does not exist yet.

---

## 2. Defects this plan fixes

B1–B5 found reading `main` at `266884d`. B6–B9 found in eng review round 2.
All nine are live today.

**B1 — income categories corrupt the spend math.** `computeMtdSpent`
(`src/lib/budget.ts:135`) returns `0 - SUM(amount_cents)` with no sign filter.
Migration `0002` seeds `Paycheck`, `Interest`, `Reimbursement` (lines 34-36) as
ordinary spend categories. A $2,000 paycheck categorized as `Paycheck` yields
`-200000`, which `loadMonthView.summarize` adds straight into
`summary.spentCents` — the dashboard understates total spend by every income
dollar categorized, and the row renders "$2,000.00 remaining" against a $0
allocation. `loadMonthlyTrends` (`:89`) filters `amount_cents < 0` and is
correct, so the codebase holds two contradictory definitions of "spend" and the
budget page has the wrong one. **Fixed by PR1a's kind dispatch.**

**B2 — `/goals` counts money planned, not money saved.** `loadGoals`
(`src/lib/goals/loadGoals.ts:37`) computes `totalContributed` from
`SUM(budget_periods.allocated_cents)`. An allocation is an intention, not a
transfer. **PR1b relabels AND hides the progress bar / percent-complete (DS11)
so the page asserts nothing false; PR3 fixes the math.**

**B3 — rollover silently forgives overspending.** `src/lib/budget.ts:82`:
`Math.max(0, prior.effectiveCents - priorSpent)`. Overspend a rollover envelope
by $300 and next month opens clean. Defensible as a product call, but
undocumented, untested, and unrecorded. **PR1a documents it and pins it with a
test; the semantics change (if any) is PR3.** Note that this clamp is also what
makes the rollover recurrence non-decomposable — see P1 in §4.3.

**B4 — budget rows reorder as you spend.** `loadMonthView.ts:195` sorts leaves
`spentCents DESC, name ASC`. Correct for a "biggest drains" report, hostile for
a grid you fill in top to bottom. **Fixed by PR2a's `sort_order`.**

**B5 — `budget_periods.effective_allocation_cents` has zero production writers.**
The only writer is `getEffectiveAllocation({ persist: true })` (`budget.ts:88`)
and no production code passes it. The column is permanently NULL, so the
rollover recursion at `budget.ts:77` runs on every `/budget` render for every
rollover category, walking backward one query per month. Latent today because
every seeded category is `carryover_policy: 'none'`; it becomes real the moment
funds are used. Same shape as the `applyRuleAtImport` zero-callers bug that
produced the 498-row backlog. **Addressed in PR1a (D7A′) by fixing the READ, not
the cache** — Codex showed categorization NULLs the column, so a write-on-upsert
cache would spend most of its life empty. **P1 corrects how the read is fixed.**

**B6 — archiving a category does not stop it receiving transactions.**
`buildRuleMatcher` (`src/lib/rules.ts:44`) selects every row of `category_rules`
with no join to `categories` and no archived filter, and both import paths
auto-apply the matched category id on insert. PR2b's archive hides a category
from pickers while its trained rules keep filing new transactions into it —
money leaving the budget silently, the same class as F4. **Fixed by X3 in PR2b.**

**B7 — archiving breaks historical category labels.** `transactions/page.tsx:67`
feeds `listLeafCategories(db)` into `CategoryCombobox`, whose
`labelFor` (`CategoryCombobox.tsx:48-49`) resolves a value by searching that same
list: `items.find((i) => i.value === v)?.label ?? ""`. Hide archived categories
from the list and every historical row pointing at one renders a blank label.
**Fixed by X3 in PR2b (`listLeafCategories({ includeArchived })`).**

**B8 — `kind` has no enforcement, so one merchant rule can poison income.**
`categorizeTransaction.ts:77` and `bulkCategorize.ts:96` reject only savings-goal
and parent categories; `rules.ts:44` matches on `normalized_merchant` alone.
Categorize one refund into `Paycheck` with "remember this merchant" and every
future charge from that merchant lands in income, inflating `received` and
deflating `spent` forever. **Fixed by X2 in PR1a** — automatic categorization
never files a negative row into an income category. Manual categorization still
may: a clawback is a real negative income row and `TC3` requires it to net down.

**B9 — `Uncategorized` renders as a budgetable line.** `drizzle/0001:2` seeds it
as a real category with a no-delete trigger; `loadMonthView.ts:86` filters only
`isSavingsGoal = false`, so it comes through as an ordinary leaf with an Allocate
control. In a zero-based budget you can plan $300 for "I have not decided" and
that $300 counts as having a job. **Fixed by X5 in PR1b** — the row stays visible
(so overridden spend is not hidden) but is read-only and excluded from the
planned side.

---

## 3. Target model

```
              ┌──────────────────────────────────────────────────┐
              │  categories.kind   (PR1a, new column — D1B)      │
              │  'income' | 'expense' | 'fund'                   │
              │  all three values ship in ONE migration;         │
              │  'fund' backfills from is_savings_goal = true    │
              │  and BEHAVES exactly as today until PR3          │
              └───────────────┬──────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  ┌───────────┐        ┌────────────┐        ┌────────────┐
  │  INCOME   │        │  EXPENSE   │        │   FUND     │
  │  Paycheck │        │  Groceries │        │  Car Repair│
  │  Interest │        │  Rent      │        │            │
  └─────┬─────┘        └──────┬─────┘        └──────┬─────┘
        │                     │                     │
        │  budget_periods.allocated_cents           │
        │  = "planned", for ALL THREE kinds ────────┤  ← no new table
        ▼                     ▼                     ▼
  planned income      planned spending      planned funding
        │                     │                     │
        └──────────┬──────────┴─────────────────────┘
                   ▼
    ┌──────────────────────────────────────────────────┐
    │  LEFT TO BUDGET                                  │
    │    Σ income.allocated_cents                      │
    │  − Σ expense.allocated_cents   (excl. B9 row)    │
    │  − Σ fund.allocated_cents      ← D3A             │
    │  ────────────────────────────────                │
    │  target: exactly $0.00                           │
    │  success requires plannedIncome > 0 (DS6′)       │
    └──────────────────────────────────────────────────┘

  ACTUALS — same predicate, two sign conventions (one shared builder):

    categoryMonthPredicate(cat, y, m) =
          category_id = cat
      AND transfer_pair_id IS NULL
      AND date >= 'y-m-01' AND date < next-month

    expense → spent    = −SUM(amount_cents)      pending INCLUDED  (existing)
    income  → received = +SUM(amount_cents)      pending EXCLUDED  (TS2)
                                                  └─ fixes B1
```

**Load-bearing decision: Left to Budget uses `allocated_cents`, never
`effective_allocation_cents`.** Rollover money was budgeted in a prior month
against that month's income. Counting it again would let a fund balance
manufacture budgeting capacity out of nothing. The envelope row still shows
effective (allocated + rollover) as its spendable figure; only the zero-out
equation uses allocated.

**DS27 — the equation above must be visible on the page, not just true in the
read model.** Nothing in the design as reviewed summed to the headline. The user
is asked to trust `$0.00 — every dollar has a job` with no on-screen arithmetic,
on an app whose stated premise (`CLAUDE.md`) is that the user owns every sign on
every row. DS3 makes it worse than unhelpful: for a rollover category the
`Planned` column deliberately shows **effective**, so the column a user would
naturally add up is not the column the headline subtracted, and the plan's answer
was "the caption plus the chip keep that legible." A chip cannot explain
arithmetic.

Each band therefore ends with a **`Σ planned` subtotal row**, always
allocated-only:

```
  INCOME          Σ planned income      ← summary.plannedIncomeCents
  EXPENSES        Σ planned spending    ← summary.allocatedCents  (excl. X5 row)
  FUNDS           Σ planned funding     ← summary.plannedFundCents  (A6: only if shown)
  ───────────────────────────────────
  headline        = income − spending − funding = leftToBudgetCents
```

No new query and no new math: all three figures already exist on
`MonthViewSummary` because `leftToBudgetCents` could not be computed without
them. `TC36` pins the identity. The one visible seam this leaves is a rollover
row whose `Planned` cell (effective, per DS3) does not add into an allocated-only
subtotal — the `Rollover` chip carries that, and today it never fires, because
all 50 seeded categories are `carryover_policy: 'none'`. Revisit when PR3 makes
funds real.

**TS2 — pending rows are asymmetric, deliberately.** `computeMtdSpent` includes
pending rows and `budget.test.ts:179` pins that. `computeMtdReceived` excludes
them: `CLAUDE.md` rule 1 already decided pending money is not yours yet for
every balance in the app, and a pending paycheck counted as received makes
variance report a missing paycheck as arrived. Both directions are conservative
— pending inflates spend and suppresses income, so Left to Budget never flatters
you. Each convention is a caller-side predicate with a comment naming it (D5A).

### Page structure after PR1b

```
┌─ SPINE (240px, unchanged) ─┐┌─ MAIN ────────────────────────────────────┐
│ my money manager           ││  ‹ August 2026   September 2026   Oct ›   │
│ ‹ September 2026 ›         ││                                           │
│ ◇ Dashboard                ││  LEFT TO BUDGET          ← DS1: the ONLY  │
│ ▣ Budget      ← active     ││  $0.00  ✓                  hero here      │
│ ≡ Transactions             ││  every dollar has a job                   │
│ ! Categorize [12]          ││  planned, not your bank balance           │
│ ↻ Subscriptions            ││ ─────────────────────────────────────────  │
│ ★ Goals                    ││  DS2 — five stat cells, subordinate:      │
│ ⟳ Sync   ↥ Import          ││  Planned income · Received ·              │
│ ─────────                  ││  Planned spending · Spent · Remaining     │
│ Checking  $3,482           ││ ─────────────────────────────────────────  │
│ Savings   $8,210           ││  INCOME            ← band from `kind` (A1) │
│ total   $11,692            ││   category   planned  received  variance  │
└────────────────────────────┘│   Paycheck   4,000.00 3,000.00 (1,000.00) │
                              │   Σ planned income     4,000.00   ← DS27  │
                              │ ─────────────────────────────────────────  │
                              │  EXPENSES          ← band from `kind` (A1) │
                              │   ▸ GIVING         ← group from parent_id  │
                              │   ▸ HOUSING          ordered by sort_order │
                              │     Rent    1,800.00 1,800.00   0.00  [–]  │
                              │   ▸ BILLS ...        (DS25, DS29)          │
                              │   ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈  ← hairline, DS26 │
                              │   Uncategorized  —    412.09     —  (X5)  │
                              │   Σ planned spending   3,660.00   ← DS27  │
                              │ ─────────────────────────────────────────  │
                              │  FUNDS   read-only, ONLY IF a fund exists │
                              │   Car Repair              200.00      →   │
                              │   Σ planned funding      200.00   ← DS27  │
                              └───────────────────────────────────────────┘
```

**This diagram is a *populated* month, not the first render.** On the day PR1b
merges there are 50 categories, zero allocations and zero funds, so the headline
is the `plannedIncome === 0` state ("Start by planning your income") — never the
`$0.00 ✓` success drawn above. DS6′ forbids success at zero planned income and
§5.1 says so explicitly, so this block and §5.1 contradicted each other. Approving
this diagram as "the screen" is how an implementation drifts toward a
false-success first impression. The first-render screen is specified in §5.3.

**DS26 — `Uncategorized` renders last in the EXPENSES band, below a
`--rule-strong` hairline, and only when it has month spend or backlog to
explain.** Two corrections to X5. First, position: A1's rule ("categories with no
parent render directly under the band heading") plus §4.1's "`Uncategorized` gets
no parent" put the one row the user *cannot act on* at the head of the section
they fill in top to bottom — while §3 drew it last. Pin it last with an explicit
sort clause rather than letting it fall out of the parentless rule. Second,
presence: render it conditionally, exactly as A6 does for FUNDS. An inert,
read-only, zero-spend row in the middle of the screen whose job is entering intent
is dead chrome, and the plan already accepted "do not render a section with
nothing to say" as a principle. Note it sits *above* the subtotal: X5 excludes it
from `Σ planned spending`, and the hairline is what says so without copy.

**A1 — top-level bands come from `kind`; groups come from `parent_id`.** These
are different axes and the plan previously conflated them. `"Ungrouped"` is never
a visible header: within a band, categories with no parent render directly under
the band heading.

**A6 — the FUNDS section renders only when at least one fund category exists,
and the `+ $X to goals →` sub-line is dropped.** DS19's argument was that the
headline must not subtract money the page body cannot show. With zero funds it
subtracts nothing, so there is nothing to explain and two mechanisms explaining
it is one too many.

---

## 4. PR1a — data and math (no *designed* surface yet)

Everything here is `src/lib/`, `src/db/` and `drizzle/`. No file under `src/app/`
or `src/components/` is touched.

**E1 — PR1a changes what `/budget` renders. It does not change what any figure
means.** This section previously opened *"`/budget` renders identically before and
after this merge. `TC2` and `TC7` prove it."* That was false in four ways, and the
two tests named as proof are unit tests on functions that cannot observe a page:

```
page.tsx:193   const label = section.parentName ?? "Ungrouped";
               → 0017 parents 46 leaves, so one section becomes ten named
                 headers (GIVING, HOUSING, BILLS …) through unmodified JSX.

T7 bands by kind
               → Paycheck / Interest / Reimbursement move to `incomeSections`,
                 which page.tsx does not render. Three rows leave the table.

DS29 sort_order lands here
               → order flips `spentCents DESC` → `sort_order ASC, name ASC`.
                 Every row moves.

T7 returns Uncategorized as its own MonthView field (DS26)
               → it leaves `sections`; the old page never renders it.
```

`src/app/page.tsx:64` renders the **dashboard** from the same `MonthViewSummary`,
so `B1`'s correction moves a figure there too. Two pages, not one.

The honest claim, and the one to hold this merge to: **PR1a reorganizes the budget
page and corrects its figures; PR1b then designs the page around that structure,
and the two land back to back.** Every number PR1a produces is proven by
`TC2`/`TC7`/`TC31`; what PR1a does *not* have is a designed surface, which is
precisely what PR1b is. `TC2b` pins the structural change so it is a reviewed
consequence rather than a discovery. This is `DS30`/`DS31`'s seam sweep run one
merge earlier than design round 2 ran it — that pass only swept forward, from PR1b
into PR2a, and never looked back at PR1a↔PR1b.

### 4.1 Migration `0017_category_kind.sql`

**Numbering (design review round 2, verified against the remote).** This plan
said `0016` throughout. `origin/main` already carries
`drizzle/0016_tired_thing.sql` (`transfer_rejected_partner_id`, shipped in
v0.12.4 / PR #34), and this branch is one commit behind it. So the kind migration
is **`0017`**. Rebase onto `origin/main` before generating it —
`scripts/migrate.mjs` orders by filename, and two files claiming `0016` is not a
conflict git will show you.

**`0017` is now the only migration in the plan (E7).** Design round 2 renumbered
§6.4's second migration to `0018`; `E7` then moved its one remaining column
(`archived_at`) into this file, so there is no `0018` to generate and PR2a ships
no schema change. Prior learning `mm-check-remote-before-numbering-a-migration`
(10/10) still applies to whatever lands next.

**E2 + E7 — this block previously wrote to two columns it never created.** `DS29`
moved `sort_order` into `0017` in prose and left the SQL adding only `kind`, so the
group `INSERT` below died on `no such column: sort_order` — the first statement of
the first task in the plan. `E7` then moves `archived_at` forward for the same
class of reason (see below), which deletes migration `0018` entirely. All three
are `ADD COLUMN` with a constant default or nullable, so this stays in-place with
no table rebuild — but it still runs through `scripts/migrate.mjs` per
`CLAUDE.md` rule 7.

```sql
ALTER TABLE `categories` ADD COLUMN `kind` TEXT NOT NULL DEFAULT 'expense';
ALTER TABLE `categories` ADD COLUMN `sort_order` INTEGER NOT NULL DEFAULT 0;  -- DS29 / E2
ALTER TABLE `categories` ADD COLUMN `archived_at` INTEGER;                    -- §7.2 / E7

UPDATE `categories` SET `kind` = 'income'
  WHERE `name` IN ('Paycheck', 'Interest', 'Reimbursement');

-- D1B: all three enum values land in ONE migration. `fund` backfills from the
-- existing boolean so the model is correct immediately; fund BEHAVIOR is
-- untouched until PR3, which is what lets this ship without answering O2.
UPDATE `categories` SET `kind` = 'fund' WHERE `is_savings_goal` = 1;

-- A1 + DS25: seed the group taxonomy. Every one of the 50 seeded categories has
-- parent_id NULL today and no code path can create a group before PR2b, so
-- without this the page renders one flat 50-row list and the approved mockup
-- is not renderable.
INSERT OR IGNORE INTO `categories` (`name`, `kind`, `sort_order`) VALUES
  ('Giving','expense',1),   ('Housing','expense',2), ('Bills','expense',3),
  ('Food','expense',4),     ('Transportation','expense',5),
  ('Health','expense',6),   ('Family','expense',7),  ('Personal','expense',8),
  ('Entertainment','expense',9), ('Travel','expense',10);
-- ...followed by one UPDATE per group setting parent_id for its members,
-- per the DS25 mapping table below. `Uncategorized` gets NO parent
-- (B9 / X5 / DS26 make it read-only and conditionally rendered, not grouped).

-- E2: leaf sort_order backfill, alphabetical WITHIN each parent. Runs after the
-- parent_id UPDATEs above, or every leaf is still parentless and lands in one
-- bucket. The 10 group parents keep the explicit 1-10 set in the INSERT.
UPDATE `categories` SET `sort_order` = (
  SELECT COUNT(*) FROM `categories` AS `sib`
   WHERE `sib`.`parent_id` IS `categories`.`parent_id`
     AND `sib`.`name` <= `categories`.`name`
) WHERE `parent_id` IS NOT NULL;

-- Reclassifying a category changes what its month math returns, which changes
-- every downstream rollover computed from it. Clearing globally is cheap (one
-- UPDATE over a few hundred rows) and cannot be wrong; a targeted clear can be.
UPDATE `budget_periods` SET `effective_allocation_cents` = NULL;
```

`kind` is `text('kind', { enum: ['income','expense','fund'] })` in
`src/db/schema.ts` so Drizzle type-narrows, per the project convention.

**DS25 — the complete 50 → 10 mapping.** A1 named eight groups and left the
membership as `-- ...followed by one UPDATE per group`. That ellipsis was the
single most user-visible decision in PR1b, and it was also **unsatisfiable**:
read against the real seed set (`0001` seeds 6, `0002` seeds 43, `0005` seeds 1
= the 50 the probe counted), eight groups leave `Hotels`, `Flights`, `Vacation`,
`Childcare`, `School`, `ATM`, `Bank Fees` and `Misc` with nowhere to go — while
`TC24a` asserts zero orphaned expense categories. The migration and its own test
disagreed. `Travel` and `Family` are added; every leaf now has a parent.

| Group (`sort_order`) | Members |
|---|---|
| **Giving** (1) | Gifts · Charity |
| **Housing** (2) | Rent · Home Maintenance · Renter's Insurance · Home Goods |
| **Bills** (3) | Utilities · Electric · Water · Internet · Phone · Streaming · Software · News & Magazines · Subscriptions · Bank Fees |
| **Food** (4) | Groceries · Dining · Coffee · Fast Food · Alcohol |
| **Transportation** (5) | Gas · Car Insurance · Car Maintenance · Parking · Rideshare · Public Transit |
| **Health** (6) | Doctor · Dentist · Pharmacy · Health Insurance · Gym |
| **Family** (7) | Childcare · School |
| **Personal** (8) | Haircut · Clothing · Amazon · Electronics · ATM · Misc |
| **Entertainment** (9) | Movies & Events · Hobbies · Books & Music |
| **Travel** (10) | Hotels · Flights · Vacation |

46 expense leaves + 10 new group parents + 3 income leaves (`Paycheck`,
`Interest`, `Reimbursement`, ungrouped under the INCOME band per A1) +
`Uncategorized` = the 50 that exist plus 10. `TC24a` becomes satisfiable and
`TC35` pins the coverage exactly.

Three notes the implementer must not re-decide:

- **`Bills` is the recurring-obligation group, not just utilities.** `Streaming`,
  `Software`, `News & Magazines` and `Subscriptions` live here rather than under
  Entertainment because the app already has a first-class concept for this class
  of charge (`/subscriptions`, `drizzle/0005`), and the budget page should not
  disagree with it about what a recurring charge is. It is the largest group at
  ten rows; that is the truthful shape, not an error to even out.
- **Leaf-vs-group name collisions are resolved by keeping the leaf inside the
  group, never by naming a group after a leaf.** `Utilities` (a pre-`0002`
  catch-all) sits inside `Bills` beside `Electric`/`Water`/`Internet`/`Phone`;
  `Dining` sits inside `Food` beside `Fast Food`. Both leaves are redundant and
  may hold historical rows, so they are rename/merge candidates for PR2b's
  `renameCategoryAction`, not deletions here. A group named `Utilities` holding
  a leaf named `Utilities` is the version that reads as a bug.
- **Group order is needs-first, EveryDollar's convention** (`Giving` leads).
  It is one `UPDATE` to change and PR2b's reorder actions (T29) make it a UI
  operation, so this is a starting position, not a commitment.

**DS29 — `sort_order` ships here, not in PR2a.** `categories.sort_order INTEGER
NOT NULL DEFAULT 0` moves out of §6.4's migration into this one, backfilled
alphabetically within each parent, and `loadMonthView` switches from
`spentCents DESC, name ASC` to `sort_order ASC, name ASC` in PR1a. Without it
PR1b ships the groups A1 seeds *and* B4's reshuffle-as-you-spend behavior in the
same merge: an organized page whose rows move between visits, on the one screen
whose value depends on muscle memory. The plan already argues this at B4; DS29
just stops PR1b from being the merge that contradicts it. **The reorder UI
(`moveCategoryUpAction` / `moveCategoryDownAction`, T29) stays in PR2b** — the
column and the sort are visible UX, the controls are editor garnish.

**E2 — the backfill's partition, stated so it is not re-decided.** `sort_order`
numbers *siblings*, and siblings are rows sharing a `parent_id`. After this
migration the top level holds 10 group parents (explicit 1-10), 3 income leaves
and `Uncategorized` — all `parent_id IS NULL`, all nominally one ordering space.
That is safe only because `A1` bands by `kind` before ordering (so the groups and
the income leaves are never compared) and `DS26` pins `Uncategorized` last with an
explicit clause rather than by number. Do not "fix" the apparent collision by
renumbering across bands. `TC35` asserts `sort_order` is non-null on all 60 rows
and unique within each parent.

**E7 — `archived_at` moves here too, and migration `0018` is deleted.** `DS31`
moved `copyPreviousMonth` into PR1b, but §6.3's pipeline joins
`WHERE categories.archived_at IS NULL` (`DS12`) and `TC24` asserts an archived
category is skipped and counted — against a column §6.4 scheduled for PR2a. So
`DS31` reproduced, on itself, the exact defect it was written to catch: PR1b
machinery standing on a later merge. The column is nullable with no backfill, so
moving it costs one `ALTER` in a migration already being written; the filter
matches nothing until PR2b's `archiveCategoryAction` exists, which is correct
rather than a stub. `T21` folds into `T1`, §6.4's migration disappears, and PR2a
ships no schema change at all — which collapses §12's S9 lane. Same reasoning
`DS29` used for `sort_order`, applied to the column `DS29` explicitly left behind
(it was written before `DS31` moved copy forward).

**`is_savings_goal` is not dropped in PR1a, and nothing reads it after PR1a.**
D10A repoints every reader to `kind` (§4.5). `createGoalAction` keeps writing
`isSavingsGoal: true` alongside `kind: 'fund'` so the column stays truthful for
anything not yet migrated. PR3 drops it with a table rebuild and no behavior
change — a claim that is only true because A2 repoints **all seven** readers,
not the four this plan originally listed.

**Open question O1 (§10):** is `Reimbursement` income, or an expense-kind
category whose positive rows net against its own spending? The seed assumes
income (EveryDollar's model). Tracked in `TODOS.md`, decide after a real month.

### 4.2 `src/lib/budget.ts` — one predicate, two sign conventions

```
BEFORE                          AFTER
computeMtdSpent()               categoryMonthPredicate()  ← shared WHERE clause
  └─ builds query                 ├─ computeMtdSpent()    = −sum, pending IN
  └─ returns −sum                 └─ computeMtdReceived() = +sum, pending OUT
```

`computeMtdSpent` keeps its exported signature and its current behavior for
expense categories, so every existing caller and test is untouched.

**D5A — share the predicate, not the semantics.** Five sites compute a
category-month total and they do **not** agree about refunds:

| Site | Transfer excluded | Date window | Refund handling | Pending |
|---|---|---|---|---|
| `budget.ts:135` `computeMtdSpent` | yes | yes | signed sum — refund reduces spend | included |
| `loadMonthView.ts:129` pending | yes | yes | signed sum | only pending |
| `loadMonthlyTrends.ts:89` | yes | yes | `amount_cents < 0` — refund invisible | included |
| `loadGoals.ts` withdrawals | yes | no | `amount_cents < 0` | included |
| *new* `computeMtdReceived` | yes | yes | signed sum — clawback nets down | **excluded (TS2)** |

Extract only the genuinely identical half — `categoryMonthPredicate(categoryId,
year, month)` returning the `transfer_pair_id IS NULL` + date-window SQL. Each
caller keeps its own sign and pending handling **at the call site**, with a
one-line comment naming its convention. A shared helper with a `mode` flag would
silently unify behaviors that should stay different; what "spent" means is a
product question and it goes to `TODOS.md`, not here.

**D4A — month helpers get one home.** `monthBoundary` is copy-pasted verbatim
four times (`budget.ts:174`, `loadMonthView.ts:244`, `loadMonthlyTrends.ts:35`,
`loadTransactions.ts:116`); `nextMonth`/`nextMonthOf` three times;
`previousMonth` and `nMonthsBack` once each. `src/lib/budget/monthOfIso.ts`
already exists and its docstring already promises to be this home. Move all four
there and update every call site — imports only, no logic change. Filename stays
`monthOfIso.ts`; it now under-describes its contents, which is cheaper than
churning four importers over a rename.

Also in this file:

- `getEffectiveAllocation` gains a guard: **rollover is meaningless on an income
  category.** If `kind = 'income'`, `rolloverCents` is forced to 0 regardless of
  `carryover_policy`, with a comment saying why.
- **TS1 — `getEffectiveAllocation` survives as the single-row API; `persist` is
  deleted.** T11's set-based read removes its only production caller, but the
  allocate dialog genuinely wants a single-row read for its three-field
  breakdown, and its 11 existing tests (`budget.test.ts:251-422`) become the
  oracle for the set-based rewrite via `TC30`. Deleting `persist` retires B5's
  write path for good, matching D7A′.
- The `Math.max(0, ...)` floor at `:82` gets the comment it never had: this is a
  deliberate forgive-overspend choice (B3), reconsidered in PR3.
- **C2 + E9 — stale JSDoc. It is FIVE blocks, not four.** `C2` enumerated four and
  stepped over the one sandwiched between two of them. **`loadMonthView.ts:63-66`**
  — *"Synthetic `"Ungrouped"` section renders at the top whenever any leaf has
  `parent_id = NULL` (per review decision 1 / T3A)"* — documents the exact
  behavior `A1` deletes (*"`"Ungrouped"` is never a visible header"*) and cites a
  superseded decision id. Rewrite it to describe `A1`'s two axes: bands from
  `kind`, groups from `parent_id`, unparented rows directly under the band
  heading. Same shape as `DS42` (*"the plan named 2 `DESIGN.md` edits and
  invalidates 5"*) — design round 2 caught that one by counting; nobody re-counted
  the JSDoc. The other four, rewritten here and not deferred:
  `loadMonthView.ts:67` (savings-goal exclusion → `kind`),
  `loadMonthView.ts:70` (`getEffectiveAllocation({persist:false})` is no longer
  called per leaf), `loadMonthView.ts:75` (sorting, changed in PR2a), and
  `upsertAllocation.ts:28` ("the cache rebuilds lazily on the next read" —
  nothing reads it). `invalidateForwardRollover`'s contract JSDoc is rewritten to
  say the read branch is unreachable (P3), **not** to add a fourth trigger.
- **C4 — one money parser.** `parseAmountToCents` moves from
  `src/lib/simplefin/parseAmount.ts` to `src/lib/money.ts`, beside `formatCents`,
  and gains `$`/`,` stripping. `upsertBudgetAllocationAction` uses it instead of
  `Math.round(Number(dollars) * 100)` (`budget/actions.ts:27-29`), which violates
  `CLAUDE.md` rule 1's "never `parseFloat(x) * 100`" and would otherwise become
  the primary money input path in PR2a. `SimpleFinAmountError` is renamed to a
  generic `AmountParseError`; the simplefin importers update.

### 4.3 `src/lib/budget/loadMonthView.ts`

New exported types:

```ts
export type IncomeLeafRow = {
  categoryId: number;
  name: string;
  parentId: number | null;
  plannedCents: number;    // budget_periods.allocated_cents, 0 when no row
  receivedCents: number;   // computeMtdReceived — pending EXCLUDED (TS2)
  varianceCents: number;   // received − planned (negative = short)
};

export type MonthViewSummary = {
  allocatedCents: number;     // expense-kind only, excludes Uncategorized (X5)
  effectiveCents: number;
  spentCents: number;
  remainingCents: number;
  plannedIncomeCents: number;
  receivedIncomeCents: number;
  plannedFundCents: number;
  leftToBudgetCents: number;  // plannedIncome − allocated − plannedFund
  fundCount: number;          // A6 — FUNDS section renders only when > 0
};
```

`MonthView` gains `incomeSections`, `fundRows`, and `bands`.

**D6A — `groupIntoSections` goes generic with an injected comparator:**

```ts
function groupIntoSections<T extends { parentId: number | null; name: string }>(
  rows: T[],
  parentNameById: Map<number, string>,
  compare: (a: T, b: T) => number,   // sorting stays at the call site
): SectionGroup<T>[]
```

Bucketing (parent grouping, unparented rows first, named parents by name ASC) is
identical for both row kinds and gets one implementation. Sorting is not — expense
rows by `sort_order` after PR2a, income rows by planned amount DESC — so it is
passed in rather than hidden behind a `kind` flag. **A1: the unparented bucket no
longer renders a `"Ungrouped"` header.**

**P1 — rollover is a clamped prefix scan, not a prior-month lookup.** This is the
correction to how T11 fixes B5. The recurrence is:

```
effective(N) = allocated(N) + max(0, effective(N−1) − spent(N−1))
                              └─ B3's clamp. This is what makes it
                                 non-decomposable: you CANNOT express it
                                 as one running SUM in SQL, because every
                                 month's clamp depends on the one before.

WRONG (what §5.5 originally said):        RIGHT (P1):
  read the prior month's row                load the full range in 2 queries
  ↓                                         ↓
  gives allocated(N−1), NOT                 budget_periods for the category
  effective(N−1) — that column              from its earliest month → target
  is permanently NULL (B5)                  + spend sums GROUP BY (cat,y,m)
  ↓                                         ↓
  correct for a 2-month chain,              clamped prefix scan in JS,
  silently short for anything               O(months) per category,
  longer. Fund $100/mo for 6                O(1) queries.
  months, spend nothing: real
  answer $600, this answers $200.
```

Only categories with `carryover_policy = 'rollover'` need the range, so today it
fetches nothing. The scan is a dozen lines of pure code, unit-tested against
`getEffectiveAllocation` via `TC30`.

**E4 — the scan's base case, which `P1` never stated: a month with no
`budget_periods` row terminates the chain.** `getEffectiveAllocation` returns
`null` when the target month has no row (`budget.ts:56`), and the recursion's
`if (prior)` guard (`:80`) therefore contributes `rolloverCents = 0` when the
prior month is missing. So the scan starts at the earliest **contiguous** row
before the target, not the earliest row in the table:

```
Jan $200 · Feb (no row) · Mar $200        effective(Mar) = 200, NOT 400
                └─ chain terminates here. Jan does not reach Mar.
```

**This was an untested behavior change, and `TC30`'s oracle set did not cover
it.** `budget.test.ts:311` (*"contributes 0 rollover when no prior month row
exists"*) seeds one row and reads that same month — a chain-*start* case. A scan
that iterates existing rows and carries across a gap passes it and still wrongly
carries January into March. `TC30` gains an explicit skip-month fixture.

The *product* question this exposes — should skipping a month's funding erase a
fund's accumulated balance? — is **`O5` in §10**, not something this review
decides. It is `B3`'s structural twin: `B3` (the `Math.max(0, …)` overspend
forgiveness) got a documented rationale, a pinning test, an inline comment and
`O2`; this got the JSDoc phrase *"a natural floor"*, which reads as intentional
design rather than as an unexamined consequence. `T10` writes `O5`'s comment
beside `B3`'s, at the `if (prior)` guard.

**T11 — the set-based read.** `loadMonthView` currently issues 2 queries per leaf
(`getEffectiveAllocation` + `computeMtdSpent`) plus unbounded backward recursion.
Rewrite to a bounded set of queries for the whole month:

```
1. categories                        (all, with kind / sort_order / parent_id)
2. budget_periods WHERE year,month   → planned, per category
3. transaction sums GROUP BY category_id, over the month window:
     SUM(amount_cents)                              → spent  (pending IN)
     SUM(CASE WHEN is_pending THEN amount_cents END) → pending, per category
   ← E13 folds the old #5 (loadPendingByCategory) in here: same window, same
     grouping, two aggregates. `received` = total − pending (TS2) is then a
     subtraction over ONE snapshot rather than across two separate reads.
4. rollover range queries (P1)       ← only when a rollover category exists
                                       (two statements)
```

**Not in this list, deliberately:**

- **Fund rows and the fund total.** Derivable from (1 ∩ `kind='fund'`) joined
  against (2) — everything they need is already in memory. `E13` deletes the
  separate query; `plannedFundCents` and `fundCount` are computed, not fetched.
- **`loadUncategorizedBacklog`.** Moved out of this function entirely by `E5`
  (below); the budget page calls it directly.

**TS5 + E13 — the plan said four, `TS5` corrected it to six, and six was still
two too many. It is four, plus two when a rollover category exists.** `TC29`
asserts *invariance* (identical statement count for a 5-category and a 50-category
fixture), never a constant — which is why none of this recounting breaks a test,
and why it is cleanup rather than a bug. **Do not update this sentence when you
add a query; update nothing.** A constant gets bumped by whoever adds the next
query, which is exactly the person not thinking about N+1.

`effective_allocation_cents` stays as-is: it may remain NULL forever and nothing
depends on it. Closes `TODOS.md:197`.

**D3A — fund allocations are subtracted; fund rows render only when funds exist
(A6).** `leftToBudgetCents` must not ignore them or the headline double-counts
money already assigned to a goal. **`allocated_cents`, never
`effective_allocation_cents`** — same reason as expenses.

**X4 + E5 — the backlog moves to its own module, and *then* becomes
month-scopable.** Without a scope, September can show a short `received` with no
local explanation while an all-time banner reports 498 uncategorized rows from
every month. `received` is the one column reporting real money (`DS21`) and it
must not be silently wrong.

`X4` alone could not express itself. `loadUncategorizedBacklog` is a **private**
function inside `loadMonthView.ts:161` whose result rides out on `MonthView`, and
two routes call the whole month view for nothing else:

```
categorize/page.tsx:23    const { uncategorizedBacklog } = loadMonthView(db, year, month);
transactions/page.tsx:69  const { uncategorizedBacklog } = loadMonthView(db, year, month);
                                └─ everything else — every allocation, every
                                   spend sum, the rollover scan — is built and
                                   thrown away, for one COUNT(*) and one SUM.
```

After `T8` that is the app's heaviest read (`DS34`: *"six-to-eight queries"*), paid
twice for a count — and `DS47` is about to add a `loading.tsx` to both routes,
which would be building a spinner for a wait you can delete instead.

So: extract to `src/lib/budget/loadUncategorizedBacklog.ts`, exported, with the
optional `(year, month)` scope. `loadMonthView` imports it and keeps returning the
field for the budget page. `/categorize` and `/transactions` call it directly and
stop constructing a month view. The dashboard keeps calling `loadMonthView` — it
genuinely uses the summary. This is smaller than threading a
`{ backlogScope: 'all-time' }` option through `loadMonthView`'s signature for three
callers that never wanted a month view, and it closes `TODOS.md:430` (`TD2`) more
completely than `X4` did. `TC27` moves to the new module's test file.

**X5 — `Uncategorized` is excluded from the planned side.** Its row renders
read-only, spent shown, no Allocate control, so manually-overridden spend is not
hidden, but it contributes nothing to `allocatedCents` or to the Left to Budget
denominator. **DS26 amends where and whether it renders:** last in the band under
a hairline, and only when `spentCents !== 0` or the month-scoped backlog (X4) is
non-empty. `loadMonthView` returns it on `MonthView` as its own field rather than
inside a section, so the renderer never has to special-case a row out of a list
it is mapping over.

**DS29 — leaf and group ordering both move here from PR2a.** `sort_order` lands
in `0017` (§4.1), so `loadMonthView` sorts leaves `sort_order ASC, name ASC`
instead of `spentCents DESC, name ASC` (B4), **and** sorts groups by the parent's
`sort_order ASC, name ASC` instead of `parentName.localeCompare`
(`loadMonthView.ts:216`) — both halves of DS12's ordering rule, minus its UI.
This is the same query `T7`/`T8` are already rewriting, so the marginal cost is
a clause. Without it PR1b ships A1's groups with rows that reshuffle every time
you spend, which is the behavior B4 calls "hostile for a grid you fill in top to
bottom" — the plan would otherwise create the grid and contradict itself about it
in the same merge. `TC10` and `TC26` move to PR1a with it.

### 4.4 `src/lib/budget/resolveRowDisplay.ts` (new — C1)

Every display *decision* moves out of JSX into one pure, tested function.

```
resolveRowDisplay(row, kind, phase) →
  { tone, barPct, barTone, amountPlaceholder, badges }
                     └─ E12: `phase` is 'future' | 'open' | 'closed', from
                        monthPhase() in monthOfIso.ts. It REPLACES the pair
                        (monthHasStarted, monthHasEnded), which DS35 arrived
                        at incrementally and which admits a fourth state that
                        cannot exist: started=false + ended=true.

                        DS35 widened the signature because DS21 ("neutral
                        while the month is open, --money-neg only after it
                        closes") was uncomputable inside it -- one of the four
                        rules this function was created to own had been pushed
                        back into JSX, the one place CLAUDE.md forbids this
                        repo from testing it. E12 finishes that move: the
                        booleans had no producer. src/lib/now.ts exports
                        currentMonth / todayIso / toLocalIso / daysAgoIso /
                        formatLocalDateTime and NONE of them answers "has
                        month (y, m) started or ended, locally, relative to
                        now" -- so the caller computed it inline, and C1 had
                        relocated the tone rule while leaving the DATE rule
                        behind. TC39 asserts behavior GIVEN the booleans; it
                        never asserted that September is closed on October 1st.

                        That comparison is exactly what now.ts exists for
                        (".toISOString() renders the UTC date, off by one for
                        any local evening") and why CLAUDE.md makes the
                        container refuse to boot without TZ set. A hand-rolled
                        new Date().getMonth() + 1 > month in a component is
                        the shape that module was written to prevent.

                        monthPhase(year, month, now = new Date()) lands in
                        monthOfIso.ts beside the four helpers D4A/T3 is
                        already moving there, reads the clock through now.ts,
                        and is pinned by TC41.

  WHY THIS EXISTS: CLAUDE.md limits tests to "categorization logic only" —
  UI component tests are out of scope. So a rule living in JSX is a rule
  this repo is not allowed to test. Today the same rule is written FIVE
  times (E11 — C1 listed four) across TWO color systems:

    envelope-card.tsx:41    raw > 100 → "over"
    envelope-card.tsx:50-54 FILL_COLORS: --accent-ledger / --accent-amber
                            / --accent-redbrown          ← Ledger Paper tokens
    page.tsx:293            RemainingCell text tone:
                            text-destructive / muted / emerald-800
    page.tsx:292-296        E11 — the desktop table's OWN bar, missed by C1:
                              leaf.isOverspent ? "bg-destructive"
                              : pct >= 80      ? "bg-amber-500"
                                               : "bg-emerald-500"
                            ← raw Tailwind palette, the exact class of value
                              DS9 is converting away and the copy DS40 must
                              change. The PREDICATES agree (isOverspent and
                              raw > 100 are equivalent at every value of
                              effective, including zero); the color systems
                              do not.
    DS8′ / DESIGN.md:151    over 100% → AMBER, not red; "same logic as
                            RemainingCell"

  PR1b adds income and fund rows; PR2a adds editors. 3 kinds × 2 layouts
  = 6 render paths. One function, six dumb renderers.

  E11: resolveRowDisplay returns `barTone` as a TOKEN NAME. Neither renderer
  writes a color. TC40 pins that the returned barTone is never
  --accent-redbrown, and that the table row and the mobile row get an
  identical value from identical inputs — which is F8 ("a tone rule drifts
  between the table and the mobile card") tested rather than asserted.
```

Rules it owns, each a test case: DS8′ (amber bar over 100%, one red signal per
row, no row background), DS12 (income fill always ledger-green, capped at 100%,
`+$X over plan` chip in `--money-pos`), DS21 (variance neutral while the month is
open, `--money-neg` only after it closes), DS14 (`—` for unbudgeted vs literal
`0.00` for budgeted-at-zero — `formatCents` cannot express the difference), and:

**DS40 — amber carried five meanings and two of them rendered identically.**

| Amber | Means | Where |
|---|---|---|
| surface tint 18% | uncategorized transactions exist | `BacklogBanner.tsx:32` |
| foreground mix 55% | you are late assigning | Left to Budget, `> 0` + month started |
| cell border | another tab wrote (`stale`) | DS4, PR2a |
| bar fill | ≥80% spent (`warn`) | `envelope-card.tsx:52`, live today |
| bar fill | over 100% spent | DS8′ |

The last two are the same token on the same 6px bar. Today `resolveState`
(`envelope-card.tsx:41`) sends `raw > 100` to `--accent-redbrown`; DS8′ moves it to
amber to satisfy "one red signal per row," which would make **80% and 120% render
identically** on the element whose only job is showing how far through an envelope
you are. §4.4 listed DS8′ and never said what happens to `warn`, so C1 — the
function built to stop exactly this drift — inherited the collision.

Resolution: distinguish them by **fill behavior, not hue.** `warn` (≥80%) stays
amber and fills proportionally. `over` (>100%) is amber, **capped at 100%**, plus
a 2px `--accent-redbrown` overflow tick at the bar's end. The row's single red
signal is that tick and the Remaining figure; the bar itself never turns red.
DS8′'s intent was to stop the whole row shouting, not to erase the distinction
between nearly-done and over. On mobile the Remaining figure carries it, since a
2px tick is a small target for a meaningful state.

**DS35 — a closed month reads as record, not verdict.** DS21 said variance goes
`--money-neg` once the month closes and stopped there, so nobody designed what
closing does. On October 1st, September retroactively fills with red — every short
income row at once — and you reach it in one click from a month picker that has
already moved on. That is the app delivering a judgment on a month you can no
longer change, every month, forever, as its first act.

A closed month renders variance in `text-ink-2` with the figure intact.
`--money-neg` is reserved for **expense overspend only**, in any month. The two
things red could mean are not the same: *you spent more than you planned* is
actionable and keeps its red; *your income came in under plan* is a fact about the
past. Red that marks every historical month stops meaning "attention here" and
starts meaning "this is the past" — the same signal dilution the plan already
fought over amber. Norman's reflective level is the horizon this decides:
reviewing last month is the core act of budgeting, and it should not feel like
reading a report card.

**DS33 — income rows disclose pending money the same way expense rows already
do.** TS2 deliberately excludes pending from `received`. Nothing surfaced that
decision on the row, so on the day a pending paycheck lands via CSV the row reads
`received $0.00` and `variance ($4,000.00)` with no explanation — the app's
most-watched figure rendering the most common income event as a missing paycheck.
The expense side already solved this with the `+p` badge (`page.tsx:249-256`).
Income rows get the same affordance carrying the pending amount, and **variance
stays neutral when pending covers the gap**, regardless of DS21's month-open rule.
`loadPendingByCategory` (`loadMonthView.ts:129`) already returns per-category
pending and is already set-based, so the figure costs nothing. One pending
vocabulary across both bands, not two: the asymmetry TS2 chose is defensible, and
silent is what makes it read as a bug.

### 4.5 Every read moves to `kind`; `is_savings_goal` becomes inert

**A2 — there are SEVEN read sites, not four.** The plan originally listed four.
The three it missed are the guards that stop a transaction being categorized into
a fund, and PR3's "drop the boolean, no behavior change" would have deleted them
silently.

| # | Site | Today | After PR1a |
|---|---|---|---|
| 1 | `loadMonthView.ts:86` | `eq(isSavingsGoal, false)` | `ne(kind, 'fund')` |
| 2 | `loadGoals.ts:44` | `eq(isSavingsGoal, true)` | `eq(kind, 'fund')` |
| 3 | `loadMonthlyTrends.ts:61` | `eq(isSavingsGoal, false)` | `ne(kind, 'fund')` |
| 4 | `categories.ts:40,43` | `eq(isSavingsGoal, false)` ×2 | `ne(kind, 'fund')` |
| 5 | `categorizeTransaction.ts:71,77` | `if (category.isSavingsGoal) throw` | `if (category.kind === 'fund') throw` |
| 6 | `bulkCategorize.ts:90,96` | same guard | same change |
| 7 | `goals/actions.ts:41` | `if (!category.isSavingsGoal) throw` | `if (category.kind !== 'fund') throw` |

`classifyCategory` / `LeafLookup` (`categories.ts:50-61`) exposes `isSavingsGoal`
as an eighth surface and has **zero non-test callers**. Removal tracked as a TODO
rather than folded into this sweep (TD3).

**D9A + X1 — kind is changeable only on an unused category, with one narrow
exception.** `setCategoryKindAction` refuses any category with ≥1 transaction or
≥1 `budget_periods` row, because reclassifying a used category retroactively
rewrites every past month's summary, the trend chart, goal inclusion and
categorize eligibility — a blast radius that cannot be enumerated honestly in a
dialog.

The exception exists because without it the plan's remedy for its own top failure
mode is a button that always refuses:

```
F1 fires  →  the name-based backfill matched nothing
          →  your income lives in a renamed category
          →  that category is full of paychecks
          →  it is "used"
          →  D9A refuses
          →  the banner's CTA (DS22) cannot ever work.

X1: allow expense → income on a USED category iff every transaction in it is
    positive, behind a confirmation naming what recomputes. That direction is
    the one where "retroactively rewrites every past month" is the REPAIR, not
    the damage — those months are wrong today, and that is literally B1.
    Decidable by one query, so it is testable rather than a judgment call.
    Every other transition stays absolute.
```

Changing kind on an unused category still invalidates forward rollover.

**X2 + E8 — automatic categorization never files a sign-mismatched row, and the
guard goes INSIDE `buildRuleMatcher`, not in its callers.** A rule must not file a
negative row into `kind='income'`, or a positive row into a fund.

`X2` originally put this at the two consumers (`importBatch.ts:318`,
`sync.ts:357`). `E8` moves it into the matcher, because `X3` — the same idea, the
same table, in PR2b — already made that call: *"`buildRuleMatcher` joins
`categories` and skips archived. It already reads the table once per batch, so the
join costs nothing per row."* Every word of that applies here. Two decisions
adding a `categories` lookup to rule matching should not pick two different seams
and then add a third read in PR2b. `CLAUDE.md` says it directly: *"one guard in
the shared function beats a guard in every caller — grep the callers, fix it once
where they all route through."*

```
BEFORE (X2 as written)                  AFTER (E8)
  importBatch.ts  guard  ─┐               buildRuleMatcher(merchant, amountCents)
  sync.ts         guard  ─┤                 └─ ONE categories join, in the query
  rules.ts   +categories join (X3, PR2b)       it already runs once per batch
  = 3 touches, 2 copies of one rule           ├─ X2: kind vs sign        (PR1a)
                                              └─ X3: archived_at IS NULL (PR2b)
```

`buildRuleMatcher`'s returned matcher takes the amount:
`(normalizedMerchant: string, amountCents: number) => RuleMatch | null`. Both call
sites already hold the amount. **`TC32` moves to `rules.test.ts` and becomes
runnable** — as filed it asserted a sign rule against a module whose matcher never
saw a sign (`rules.ts:47`: `(normalizedMerchant: string) => …`), so it could only
ever have been written as something weaker.

Manual categorization is unaffected: it does not go through the matcher at all
(`categorizeTransaction.ts` has its own path), which is what keeps `TC3`'s clawback
case working — a clawback is a real negative income row and `TC3` requires it to
net down `received`. The vector `B8` describes is the automatic one: one remembered
merchant poisoning every future import. A skipped row lands uncategorized and shows
up in the backlog, which is the correct place for a human to look at it.

---

## 5. PR1b — the surface

Everything user-visible. `src/app/`, `src/components/`. The numbers this renders
were proven correct by PR1a's tests before a pixel moved.

### 5.0 The arc (DS38)

The plan carried 34 design decisions and nothing describing what using this feels
like over a month. Both of design round 2's earlier passes found defects a
storyboard would have caught for free — an empty state keyed to a condition that
can never occur (DS30), three CTAs pointing at the next merge (DS31). States are
not a sequence, and the four-way split made sequence the thing most likely to go
wrong. Every future review of this plan checks against this table.

| # | User does | User feels | Plan specifies | Merge |
|---|---|---|---|---|
| 1 | Opens `/budget` for the first time | *"It knows my categories."* 10 groups, 46 rows, all blank | DS25 taxonomy, DS29 stable order | PR1a+b |
| 2 | Reads the headline | *"OK, income first."* Not false success | DS6′ zero-income state, DS30 first-run card | PR1b |
| 3 | Notices `Spent` looks low | *"Can I trust this?"* — answered before it is asked | **DS36** second line + `/categorize` link | PR1b |
| 4 | Plans a paycheck | *"That was one dialog, not a page reload"* | `AllocateFormTrigger` (exists), DS31 retargeted CTA | PR1b |
| 5 | Assigns down the list | *"Slow but working."* 46 dialogs is the honest cost of PR1b | — this is what PR2a fixes | PR1b |
| 6 | Hits `$0.00` | *"Done."* 240ms settle, ✓ draws in, one motion in the whole app | DS6′ | PR1b |
| 7 | Glances left | *"Wait — which number is mine?"* — answered in the caption | **DS37** names the rail | PR1b |
| 8 | Comes back next month | *"One click."* Copy last month, fill blanks only | DS7 + **DS31** (T16c moved forward) | PR1b |
| 9 | A paycheck posts as pending | *"It's there, just not cleared"* — not a missing paycheck | **DS33** `+p` badge, neutral variance | PR1b |
| 10 | Month rolls over | *"That's the record."* Not a report card | **DS35** closed month is `text-ink-2`, red reserved for overspend | PR1b |
| 11 | Budgets month three | *"Three minutes."* Type, Tab, Enter, total moves as you go | §6.1 `<MonthEditor>`, DS14 | PR2a |
| 12 | Wants a category the seed lacks | *"I can shape this."* Inline creation in the row it belongs to | DS20, T26 | PR2b |

Two things this table makes visible that the decision list does not. **Step 5 is
the deliberate cost of the split** — PR1b is honest about being slow rather than
promising fast and delivering modal, which is what DS31 fixed. And **steps 3, 7,
9 and 10 are all the same move**: the app naming a thing it already knows before
the user has to discover it. That is the throughline; if a future decision
violates it, it is probably wrong.

### 5.1 Left to Budget card

`src/components/ledger/left-to-budget.tsx` — new. **Five states (DS6′)**, per
`DESIGN.md` money rules:

| Condition | Rendering |
|---|---|
| `plannedIncome === 0` | **"Start by planning your income."** Neutral `text-ink-1`, no check. **CTA opens the Allocate dialog on the first income category (DS31)** — *not* "focuses the income section's first input", which was written against PR2a's inline editor and would have shipped a CTA with no target in PR1b |
| `> 0`, month not started | **Neutral progress, not a warning (DS8′)**: `text-ink-1` numeral + a thin `--accent-terracotta` meter showing assigned ÷ planned |
| `> 0`, month started (`src/lib/now.ts`) | `--accent-amber`, "$X still unassigned" — the only amber on the card, meaning "you are late", not "you are working" |
| `< 0` | `text-money-neg` with parens, "($X) over-budgeted" |
| `plannedIncome > 0 && leftToBudget === 0` | **Success.** `text-money-zero`, `--accent-ledger` check, "every dollar has a job" |

**The `plannedIncome === 0` state is not a nicety.** `leftToBudget =
plannedIncome − allocated − plannedFund` is satisfied by `0 − 0 − 0`, so without
it a fresh October renders ledger green with "every dollar has a job" before the
user types anything — on the exact screen the ritual starts from. F1's banner
does not catch it either: F1 tests for zero income *categories*, and a seeded
`Paycheck` with no allocation passes that test while contributing $0. **Success
is never `leftToBudget === 0` alone.**

- **Motion (DS6′ + DS41):** on *transition into* success, the numeral settles to
  ledger green over `--motion-settle` and the ✓ draws in. Never on page load.

  **DS41 — the plan claimed one motion and specified four.** §8 defers "motion
  beyond the single zero-transition" on the grounds that `DESIGN.md` has no motion
  vocabulary. But the plan already specifies four: this settle, DS4's `saving`
  border animating to terracotta, DS4's `saved` border returning to hairline over
  400ms, and DS7's one-shot copied-row highlight. Two durations pulled from
  nowhere, no easing, and `prefers-reduced-motion` remembered once out of four
  times. A vocabulary is being written whether or not it is written down.

  Add a motion section to `DESIGN.md` with two durations and one easing:

  | Token | Value | Use |
  |---|---|---|
  | `--motion-quick` | 160ms | state feedback (DS4 borders, DS7 highlight) |
  | `--motion-settle` | 240ms | completion (DS6′'s zero transition) |
  | `--motion-ease` | `cubic-bezier(0.2, 0, 0, 1)` | both |

  Plus **one** global `@media (prefers-reduced-motion: reduce)` rule disabling all
  four, rather than four remembered opt-outs. The accessibility win is the larger
  half of this decision. §8's deferral is rescoped to *new* motion beyond these.
- **Amber must be mixed toward foreground, not used raw.** `--accent-amber` is
  `oklch(0.72 0.09 75)`; on `--paper-1` that is ≈**2.4:1**, under the 3:1
  large-text floor. Use `color-mix(in oklch, var(--accent-amber) 55%, var(--fg))`,
  matching `globals.css:474`. Reserve the amber *surface* tint for
  `BacklogBanner`, which renders directly above this card (`page.tsx:51-53`) —
  two amber alarms with unrelated meanings on one screen is how amber stops
  meaning anything.
- **DS2 caption, always shown**, amended by **DS37**: *"Planned for the month.
  Your $11,692 balance is in the rail."* in `--text-sm text-ink-2`, with the
  figure read from `loadAccountBalances`. This is EveryDollar's model, so `$0.00`
  means *the plan is complete*, not *your accounts are fully assigned*. Without
  the caption the number reads like a reconciliation and will be trusted as one.
  **Not `--text-xs`/`text-ink-3`** — that is 11px at ≈4.1:1, under AA, and a
  disclaimer nobody can read is not a disclaimer.

  DS37's change is the word "rail." The original caption ("planned, not your bank
  balance") argues against a number that is **on screen while it argues**: the
  Spine renders `total $11,692` in `--money-pos` permanently (`DESIGN.md:76`), so
  at the moment of success the viewport holds a big green "you have $11,692" and a
  big green-checked "$0.00" 240px apart. `--money-pos` is correct in both places
  and now carries two meanings — "here is your money" and "your plan adds up."
  Naming the rail answers the question the user is actually asking ("which number
  is my money?") instead of repainting a token that is right in both places, and
  turns a disclaimer into an orientation line, which is the App-UI copy rule:
  orientation, status, action. The coupling cost is real and accepted: the card
  now needs `loadAccountBalances`, a query it did not otherwise want.

### 5.2 Page structure and restyle

**DS1 — one hero.** The existing `Hero` ("Total Remaining", `text-5xl`,
`page.tsx:107-119`) is removed; Left to Budget takes that slot. Two 5xl money
figures 40px apart is a tie, not a hierarchy. "Total Remaining" moves into the
stat row where it still answers "what can I still spend."

**DS2 — five stat cells**, in this order, reading as two matched pairs plus the
outcome: `Planned income · Received · Planned spending · Spent · Remaining`.
Same component on the dashboard.

**DS28 — the grid is `grid-cols-2 lg:grid-cols-5`; the 3-column step is dropped.**
DS2's justification for five cells is the pairing, and Gestalt proximity is what
carries it. At `sm:grid-cols-3` the pairs break across rows and `Received` lands
beside `Planned spending` — a plan figure next to an actuals figure with nothing
saying they are unrelated. Two columns is the layout that *preserves* the pairs
(income/received, planned spending/spent, remaining), so the intermediate
breakpoint was strictly worse than the one below it. The tablet range is also
where a budget actually gets reviewed. This matters beyond one page because DS10
extracts `SummaryStrip` and the dashboard renders the same component.

**DS3 — four money columns, not six.** The table becomes
`Category · Planned · Spent · Remaining · progress · Allocate`. `Rollover` and
`Effective` leave; they are derivation steps, not facts about the month, and the
three-field breakdown already lives in the Allocate dialog. All three generated
mockups independently cut these two columns without being asked. The `Rollover`
chip on the category name stays. **The one rule DS3 needs:** for a rollover
category the `Planned` column shows **effective** (allocated + rollover), because
that is what is spendable and `Remaining = Planned − Spent` must stay true on
screen. Left to Budget still subtracts `allocated_cents` only — the table and the
headline deliberately answer different questions, and the caption plus the chip
are what keep that legible. **DS27's subtotal is the third thing keeping it
legible, and the load-bearing one:** each band closes with a `Σ planned` row
(always allocated-only) so the headline is derivable on screen rather than
asserted — see §3. Today no seeded category is `carryover_policy: 'rollover'`, so
the effective-vs-allocated seam this leaves does not render at all until PR3.

Subtotal row styling: `font-mono`, `text-ink-2`, `--text-sm`, right-aligned, in
the `Planned` column only — the other money columns stay blank. It is a
reconciliation device, not a summary; totalling `Spent` as well would invite
reading the band footer as a second dashboard, and DS1 already spent the page's
one hero.

**DS9 — restyle the whole budget surface, do not bolt one card onto a default
shell.** `page.tsx` today uses **zero** Ledger Paper tokens against 35 shadcn
defaults: `bg-card`, `border-border`, `bg-muted`, `text-primary`,
`text-muted-foreground`, `rounded-md`, raw `text-emerald-800`, and a 24px
(`p-6`/`space-y-6`) rhythm `DESIGN.md:48` explicitly says to avoid. Adding one
branded card to that shell reads as careless where a consistent default shell
merely reads as plain. PR1b converts the whole file: month nav, stat strip, table
chrome, links, status tones, spacing. Mechanical token substitution, no logic
change. The dashboard's own card-stack problem is a separate surface (§8).

**DS10 — named tokens.** No new component ships with an unnamed size.

| Element | Spec |
|---|---|
| Left to Budget numeral | `--text-3xl`, `font-mono`, `font-semibold`, tabular-nums |
| Kicker "LEFT TO BUDGET" | `--text-xs`, `font-mono`, uppercase, `tracking-wide`, `text-ink-2` |
| Caption | `--text-sm`, `text-ink-2` |
| Card | `--radius-lg`, `--shadow-soft`, 20px padding, 12px gap |
| Row inputs | `h-9` desktop, `text-base sm:text-sm` |
| Band / section headings | `font-display` (Newsreader), `--text-sm`, `text-ink-2` |

`SummaryStrip` extracts to `src/components/ledger/summary-strip.tsx` with the
contract `cells: {label, cents, tone?}[]`, grid computed from `cells.length`.
**Update `DESIGN.md:144`, which currently instructs the opposite** ("don't extract
a shared component yet") — `DESIGN.md`'s own two-use threshold is now exceeded.

**DS39 — the strip is one ruled surface, not five cards.** `page.tsx:130-140`
renders each cell as `rounded-md border border-border bg-card`; DS9 would have
restyled five bordered boxes into five Ledger Paper bordered boxes. Five read-only
figures in bordered rounded rectangles under a headline is the dashboard-card
mosaic App UI rules name explicitly, and Codex's litmus check "are cards actually
necessary?" came back NO. Cards earn their existence when the card *is* the
interaction; these are figures. One `--bg-raised` strip with `--rule-faint`
vertical dividers, no per-cell border and no per-cell radius — which is both
calmer and more literally ledger paper, and uses `--rule-*` tokens this page
currently ignores entirely. It also makes the strip subordinate to the hero by
construction rather than by font size, which is what DS1 was reaching for. At the
2-column breakpoint the vertical rules become horizontal ones.

**DS46 — close the type scale; it costs one line.** The `Hero` being removed uses
`text-5xl` = 48px, which only resolves because Tailwind v4's `@theme` **merges**
with its defaults rather than replacing them — so any size above `--text-3xl`
leaks through despite `globals.css:77`'s comment claiming the scale "replaces
Tailwind defaults for consistency." `--text-3xl` (44px) is the real top.

Measured blast radius: **exactly one call site in `src/`** —
`src/app/budget/[year]/[month]/page.tsx:115`, the `text-5xl` Hero that DS1 already
deletes in T12. So adding `--text-*: initial` to `@theme` after T12 breaks
nothing, and turns "someone used an off-system size" from something a design
review catches by hand into a build-visible error. Do it in the same merge, while
the count is zero.

**DS45 — `SummaryStrip` takes a `variant`, so the dashboard is not half-restyled.**
T13 extracts the strip and renders it on the dashboard too. After DS39 that strip
is Ledger Paper, while the dashboard remains an untouched shadcn card stack whose
redesign §8 defers on Codex's separate information-architecture grounds. Shipping
one on-system component into an off-system page is precisely what DS9 argues
against, and prior learning `mm-design-system-documented-not-adopted` (10/10) puts
it plainly: that reads as *careless*, where a consistent default shell merely reads
as *plain*. `variant="ledger" | "plain"` keeps T13's actual goal — both pages
rendering identical **figures** from one component — without importing a
half-restyle onto a surface nobody reviewed. The dashboard's eventual restyle
becomes a one-word change. This is debt with a name on it; delete the `plain`
variant when the dashboard lands.

**DS18 — income stays a table section, with the boundary marked.** Codex argued
income (`planned/received/variance`) and expenses (`planned/spent/remaining`) are
two tools sharing one table zone and that scanning degrades where column meaning
changes silently. The approved mockup renders income as a section, so it stays —
with `--bg-inset`, a heavier rule beneath it, and its own column header row
rather than inheriting the table's.

**DS13 — contrast, type floor, dark mode, iOS.** No critical copy below 13px or
below AA. **Cross-model note:** Codex asked for a 16px floor on all explanatory
copy; that is a generic universal and would break this app's type scale
(`globals.css:78-85`, where `--text-sm` is the body size), so 13px + AA is a
deliberate rejection of it. Dark mode: every color here has a different `.dark`
value (`globals.css:201-207`) and amber/ledger invert their contrast
relationship, so verification is "all five Left to Budget states, both themes."
iOS: `text-base sm:text-sm` on **every** editor input, with a comment pointing at
`_allocate-form.tsx:36-37` — that autozoom fix was traced to a v0.3.0 ship review
and PR2a scales one input to forty.

### 5.3 Interaction states

Every state describes what the user SEES.

| Surface | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| Page (route) | **`loading.tsx` → `◐` StateCard (DS34, moved into PR1b)** | — | `error.tsx` → `!` StateCard (A7) | — | — |
| **First run (DS30)** | — | **`plannedIncome === 0 && allocatedCents === 0` → `∅` StateCard above the table: "Nothing is planned for September yet. Start with your income — everything else is assigned from it." PRIMARY action opens the Allocate dialog on the first income category** | — | dismissed by the first allocation | — |
| Left to Budget card | server-rendered, no loading state | no income categories → amber banner replaces the number + link | any cell failed → number renders `text-ink-3` with "unsaved changes" instead of ✓ **(PR2a only — PR1b has no cells to fail; do not build it in PR1b)** | `$0.00`, ledger green, ✓ | `> 0` per the state table above; `< 0` red-brown parens |
| Income section | — | `∅` StateCard: "Income is where a zero-based budget starts. Add your paycheck." + primary action | — | rows with planned + received + variance | received < planned → **neutral while the month is open (DS21)**; **pending covers the gap → `+p` badge with the pending amount, variance stays neutral (DS33)**; `--money-neg` only after the month closes |
| Expense bands | — | ~~`∅` StateCard: "No categories yet."~~ **Deleted (DS30): `sections.length === 0` is unreachable once `0017` seeds 10 groups and 46 leaves. The live day-one condition is the First run row above.** The developer text at `page.tsx:145-152` still goes | — | grouped rows | unallocated → `—` in Planned, never `$0.00` |
| FUNDS section | — | **not rendered at all when `fundCount === 0` (A6)** | — | read-only rows linking to `/goals` | — |
| `Uncategorized` row | — | **not rendered when it has no month spend and no month-scoped backlog (DS26)** | — | last in band, under a hairline, read-only | — |
| Reclassify confirmation (DS32) | button → `pending`, dialog stays open | — | inline in the dialog via A7's returned state, never a toast | dialog closes, page revalidates, banner gone | — |
| Allocation cell (PR2a) | `saving` — value stays, right border animates to terracotta | unset shows `—`, never `0.00` | `failed` — optimistic value REVERTS to last-known-good, border `--accent-redbrown`, inline "retry" | `saved` — border returns to hairline over 400ms, no toast | `stale` (another tab wrote) — server value + amber border + "changed elsewhere" |
| Copy last month | button → `saving` | source month empty → disabled, "August has no budget to copy" | inline message above the table, table unchanged | "Copied 12 · skipped 3 already set · skipped 1 archived" | same message, counts tell the story |
| `/goals` | — | existing empty state | — | planned contributions + target as plain figures | — |

**The load-bearing rule in that table:** a failed allocation cell blocks the
"every dollar has a job" confirmation. The headline must never assert that the
budget balances over a value the database does not have. Reverting the optimistic
value rather than leaving it on screen is the honest behavior; a toast the user
scrolls past is not.

**DS7 — the empty month leads with the escape hatch.** When the target month has
zero allocations and the prior month has some, the `∅` StateCard's PRIMARY action
is "Copy September's budget", with "Start blank" secondary. This replaces the
placeholder at `page.tsx:145-152`, which ships developer text to a user ("Seed
the five defaults via the pending migration"). In any other month the trigger is
a `btn-outline` beside `MonthNav`. Result renders as a sonner toast (already
mounted, `layout.tsx:48`; precedent `categorize/_merchant-row.tsx:63`), and
copied rows get a one-shot highlight — fill-blanks-only means the common case
changes few rows, otherwise indistinguishable from a no-op.

**DS31 — every PR1b CTA must be backed by PR1b machinery, and three were not.**
The plan swept this class exactly once: DS22 promised the F1 banner's CTA would
work, D9A made it always refuse, and X1 carved the exception that backs it. Nobody
re-ran the sweep after the four-way split. Three more were unbacked:

| CTA | Was specified as | Machinery | Fix |
|---|---|---|---|
| `plannedIncome === 0` headline CTA | "focuses the income section's first input" (§5.1) | inline inputs are §6.1, **PR2a** | opens the Allocate dialog on the first income category |
| DS7 `∅` primary action | "Copy September's budget" | `copyPreviousMonth` is §6.3, **PR2a** | **T20 moves into PR1b** |
| DS7 fallback trigger | `btn-outline` beside `MonthNav` | same | same |

**`copyPreviousMonth` (T20) moves from PR2a into PR1b.** It has no dependency on
`<MonthEditor>` — it is a pure library function, one server action and one button,
and it is the highest-leverage thing in the whole feature for "budget a month in
three minutes." Without it PR1b is a page that looks finished and still costs 46
modal dialogs to fill in, for the full real month X6 schedules before PR2b. With
it, the second month you use the app is one click. PR2a keeps §6.1's inline
editing and the `saving`/`saved`/`failed`/`stale` cell states.

**DS7 still does not fire on the first ever render** — its condition requires the
prior month to have allocations, and on day one no month does. That case is
DS30's First run row, which is a different state with a different action.

**DS30 — the first-render state.** `plannedIncome === 0 && allocatedCents === 0`
renders an `∅` StateCard above the table: *"Nothing is planned for September yet.
Start with your income — everything else is assigned from it."* Primary action
opens the Allocate dialog on the first `kind='income'` category. This replaces the
`sections.length === 0` empty state, which DS25's taxonomy seed makes unreachable
— 10 groups and 46 leaves always exist after `0017`, so that branch would have
shipped as dead UI a future reader assumes is live. The condition it replaces is
deleted, not left behind.

**DS36 — the first-run card admits that `Spent` is incomplete.** When the
month-scoped backlog (X4) is non-empty the card carries a second line:
*"N transactions this month aren't categorized yet, so Spent is incomplete."* with
a **secondary** action to `/categorize`; income stays primary. This ledger holds
498 uncategorized rows today, so on first render every `Spent` figure on the page
is low by an unknown amount — you plan $600 for Groceries against a `$120 spent`
that is not the real number. The `BacklogBanner` directly above states the
*condition* ("you have uncategorized transactions") and never the *consequence*
("therefore the column below is wrong"), and the consequence is the one that
changes what the user should believe. `CLAUDE.md`'s premise is that the user owns
every sign on every row; a page that knows its figures are provisional and does
not say so is the opposite of that.

**C5 — build the StateCard shell.** `DESIGN.md:184-191` specifies `∅`/`◐`/`!`/`✓`
cards and says "Not yet built as shared components. Inline them in the dashboard
empty state for now." There has been exactly one (`page.tsx:195`) for months and
PR1b needs five more. `<StateCard variant="empty"|"error"|"loading"|"success">`
lands in `src/components/ledger/`, and A7's `error.tsx` plus DS17's `loading.tsx`
render through it instead of being two more one-offs. Update `DESIGN.md:191`.

**DS47 + E10 — every remaining route gets both boundaries, through `StateCard`.**
DS34 fixes `/budget/[year]/[month]` only. Today every other route shows Next's
default error UI on a throw and a blank page on a slow query.

**E10 corrects the count from 19 to 17.** `DS47`'s list included `/budget`, which
is `src/app/budget/page.tsx` — nine lines of `await connection()` then
`redirect()`, no data fetch. A `loading.tsx` there flashes and redirects; an
`error.tsx` catches nothing a user can act on. The `T17c` glob was also short one
file: `DS47`'s prose correctly counts **10** missing `loading.tsx` (`/sync` has an
`error.tsx` but no `loading.tsx`) while the glob omitted `/sync/loading.tsx`.

Corrected: **17 files across 9 routes** — `/`, `/categorize`, `/goals`, `/import`,
`/import/preview/[id]`, `/import/success/[batchId]`, `/subscriptions`,
`/transactions` (both files each = 16), plus `/sync/loading.tsx` (error already
exists). Each is roughly fifteen lines through `C5`'s `StateCard`.

This is the cheapest it will ever be: `StateCard` is being built in this merge and
the variants already exist. If the 19 files read as repetitive, a route-group
`layout.tsx` is the refactor — but six near-identical files that work beat a
shared abstraction that does not exist. Prior learning
`mm-design-system-documented-not-adopted` (10/10) flagged this absence app-wide.

**DS34 — `loading.tsx` moves from T24 (PR2a) into PR1b, beside `error.tsx`.**
`src/app/sync/error.tsx` is the only `error.tsx` or `loading.tsx` in the entire
app (prior learning `mm-design-system-documented-not-adopted`, 10/10), so every
other route currently shows a blank page on a slow query. `loadMonthView` is the
app's heaviest read at six-to-eight queries. Shipping the merge that makes this
page look designed while it still flashes blank is the same "polish now, raw edges
later" pattern DS30/DS31 fix elsewhere — and it is about fifteen lines against a
`StateCard` variant PR1b builds anyway (C5). T24 in PR2a keeps the hydration
boundary work, which is what DS17's argument was actually about.

### 5.4 `/goals`

**DS11 — replacements, not just deletions.** Hiding the progress bar removes
`ProgressBar` (`goals/page.tsx:174`), the `% complete` line (`:175-180`), and the
entire top `SummaryStrip` (`:111-132`, which is only a bar plus a ratio). What
would survive is the subhead "Track progress toward your financial targets" — the
exact claim DS11 exists to stop making. So:

- Subhead becomes "Planned contributions toward each target. These are amounts
  you budgeted, not transfers."
- The removed strip becomes a plain two-number mono line (planned / target).
- A `!` StateCard reads "Progress tracking is paused — see the note above."
- Correct the `loadGoals` JSDoc.

No query change. The math is not fixed here, it is stopped from being displayed
as if it were savings. `loadGoals.ts:97` computes `progressPct` from planned
allocations, so a bar reading "60% to your $2,000 goal" asserts a fact about
money that may never have moved.

**DS12 — income does not reuse `EnvelopeCard`.** `resolveState`
(`envelope-card.tsx:35-48`) treats `raw > 100` as `"over"` → `--accent-redbrown`.
On an income row, receiving *more* than planned is good news painted red. Income
gets its own card; both cards now read their tone from `resolveRowDisplay` (C1),
so they cannot drift.

### 5.5 Safety: the F1 banner and its CTA

**D14A — two-layer mitigation, layer 1 only in PR1b.**

1. **Total failure:** `/budget` renders a banner when **zero** categories have
   `kind='income'`: "No income categories — Left to Budget cannot be computed."
   A budget with no income is always a misconfiguration, so no false positives.
   **DS22: the banner's CTA must work**, so a minimal `setCategoryKindAction`
   moves into PR1b — with X1's exception, without which it always refuses.
2. **Partial failure:** the per-category "this looks like income" hint. **A8
   moves this to PR2b**, because the failure it guards is unreachable until then:
   the backfill's target names (`Paycheck`, `Interest`, `Reimbursement`) are
   intact in the database right now (ids 40-42), and `renameCategoryAction` — the
   only thing that could break them — is PR2b. The guard lands with the feature
   that creates the risk. §9's earlier claim that partial failure was "the likely
   one" was false for PR1 and has been removed.

**DS32 — X1's confirmation is specified, not left as a clause.** §4.5 said the
reclassification sits "behind a confirmation naming what recomputes" and stopped
there. This dialog appears at the worst possible moment — the app has just told
you its central number cannot be computed — and §10's O1 notes the transition is
**not reversible in-app** once the category holds mixed signs. An unspecified
confirmation on an irreversible action is how `window.confirm()` ends up in a
Ledger Paper surface, breaking the visual system at exactly the point the user is
deciding whether to trust the app.

```
┌─ Reclassify a category as income ──────────────────────┐
│                                                        │
│  Paycheck                                              │
│  38 transactions · Mar 2026 – Sep 2026 · all positive  │
│                                                        │
│  Reclassifying rewrites how those months are           │
│  calculated. This month's summary, every prior month,   │
│  the spending trend chart, and whether this category    │
│  can receive transactions all change.                   │
│                                                        │
│  This cannot be undone in the app.                     │
│                                                        │
│           [ Cancel ]   [ Reclassify Paycheck ]         │
└────────────────────────────────────────────────────────┘
```

Rules: the shell is C5's `StateCard` vocabulary, not a new dialog language; the
count and date range are **concrete**, because "this will change past months" is
the vague warning everyone clicks through; the primary button names the action and
the category, never "Confirm"; the failure path renders **inline in the dialog**
via A7's returned state, never a toast the user scrolls past. The all-positive
check X1 requires is stated in the dialog as evidence, not hidden as a
precondition — it is the reason this direction is a repair rather than damage.

**A7 — the action returns state instead of throwing, and `error.tsx` ships with
it.** `upsertBudgetAllocationAction` throws today (`budget/actions.ts:38`) and
this route has no error boundary — `src/app/sync/error.tsx` is the only one in
the entire app. A thrown action inside a client island either takes the page down
or is swallowed. `CLAUDE.md` already documents the return-state posture for
`/sync` because these failures are reachable from ordinary use; the same reasoning
applies here, and DS4's failed-cell state cannot exist without it. PR1b adds
`src/app/budget/[year]/[month]/error.tsx` (48-line precedent: `sync/error.tsx`)
and writes `setCategoryKindAction` return-state from the start rather than
rewriting its signature one release later.

---

## 6. PR2a — budget entry that takes three minutes

### 6.1 Inline allocation, no redirect

`upsertBudgetAllocationAction` currently ends in `redirect()`. Budgeting 40 lines
is 40 full page navigations, which is the single reason the current budget will
not get used monthly.

**DS13 — this is an architecture change, not a form tweak.** `page.tsx` is a
Server Component and the only client island today is the Dialog trigger. A Left
to Budget total that moves while you type across rows needs **client-owned state
spanning the header and the whole row list** — dropping `redirect` and sprinkling
`useOptimistic` on individual row forms cannot do it, because each form only
knows its own value.

```
  page.tsx  (Server Component — unchanged responsibility)
      │  loads MonthView, passes it as initial data
      ▼
  <MonthEditor>            "use client" — owns the month's allocation state
      ├── <LeftToBudgetCard>   reads the running total from editor state
      ├── <IncomeSection>      rows bind to editor state
      ├── <ExpenseBands>       rows bind to editor state
      └── <FundsSection>       read-only (A6)
              └── each row: onBlur / Enter → server action
                            → optimistic update, immediate
                            → action RETURNS the reconciled row (P2)
                            → client merges by row id
```

**P2 — the action returns the reconciled row; revalidate once on exit.** Today
the action calls `revalidatePath` twice per commit (`budget/actions.ts:44-45`).
With a client-owned island that means 40 full route recomputes per session — each
re-running `loadMonthView`'s six-to-eight queries and pushing a whole server tree
at a client that already has the right numbers, fire-and-forget and potentially
overlapping. Server payloads landing out of order against optimistic state is how
a committed cell visibly snaps back, which is exactly the `stale` state DS4
specifies but does not want triggered by its own writes. A7 already makes the
action return state, so making that value useful costs nothing. Revalidation
fires once on editor blur-out or navigation, keeping the dashboard correct.

The existing Dialog stays reachable for the three-field
explicit/rollover/effective breakdown; it is no longer the only path.

**Read `node_modules/next/dist/docs/01-app/` on Server Components, Server Actions
and `useActionState` before writing this.** Per `AGENTS.md` this Next.js differs
from training-era Next.js, and an action that no longer redirects has different
revalidation semantics than one that does.

Estimate: **human ~2 days / CC ~1.5h.**

### 6.2 The currency input — the highest-frequency interaction (DS14)

- `type="text" inputMode="decimal"` — **never `type="number"`**; the scroll wheel
  silently mutates values in a 40-row grid (`_allocate-form.tsx:97` uses it today).
- Placeholder `—` for an **unbudgeted** category vs literal `0.00` for one
  budgeted at zero. Semantically different, and the zero-based ritual depends on
  the difference; `formatCents` (`money.ts:6-10`) cannot express it. Decided by
  `resolveRowDisplay` (C1), not in JSX.
- Right-aligned, `font-mono`, `[font-variant-numeric:tabular-nums]` — inputs do
  not inherit `font-family`, and the read-only Spent/Remaining columns are mono.
- Select-on-focus; parse via `parseAmountToCents` (C4), which now handles `$` and
  `,`; format on blur.
- **C3 — bound the value.** `allocateInputSchema` (`validateAllocateInput.ts:18`)
  is `nonnegative()` with no maximum while `year` and `month` two lines up are
  both ranged. Add `.max(100_000_000)` ($1M per line per month). Pasting an
  account number into a cell must be a visible inline error, not a silently
  accepted headline reading `($4,183,200.00) over-budgeted`. All three kinds
  inherit the bound from the one schema they share.
- **The row's amount input is the row's ONLY tab stop.** Today a row holds a
  category `Link` (`page.tsx:230`) and an `AllocateFormTrigger` button (`:266`),
  so adding an input makes the sequence link → input → button and Tab lands on
  "Allocate" every other press. Category link and the `⋯` overflow both get
  `tabIndex={-1}`, still reachable by click.
- Keys: `Enter` = commit + advance (wrapping across section boundaries);
  `Tab`/`Shift-Tab` = commit + move; `Escape` = revert to server value, keep
  focus; blur = commit. Commits never block navigation.

### 6.3 Copy last month

New `src/lib/budget/copyMonth.ts`:

```
copyPreviousMonth(db, targetYear, targetMonth)
  │
  ├── read every budget_periods row for (target − 1 month)
  │      JOIN categories ON ...
  │      WHERE categories.archived_at IS NULL     ← DS12
  │
  ├── for each: does a row already exist for target?
  │     ├── yes → SKIP  (never overwrite; there is no undo for this)
  │     └── no  → INSERT allocated_cents
  │
  ├── invalidateForwardRolloverMany(db, [...categoryIds], y, m)   ← D8A
  │      ONE statement, not one per category
  │
  └── return { copied, skipped, skippedArchived }  ← all three rendered
```

Fill-blanks-only, never overwrite: destructive-by-default with no undo is not
worth the convenience, and "skipped 12 rows you already set" is a fine message.
Whole thing in one `db.transaction`.

**DS12 — copy must exclude archived categories.** Without the join filter, copy
clones every prior-month row including archived ones, resurrecting the category
into the current month *and* recreating the allocation that archiving was
supposed to stop. The two features silently undo each other. `skippedArchived` is
reported separately so a surprising count is visible rather than inferred.

**D8A — batch the invalidation.** `invalidateForwardRollover` issues one UPDATE
per call; copying a 40-line budget fires 40. Add `invalidateForwardRolloverMany`
using `inArray`, with the single-category function delegating to it so there is
one implementation of the month predicate.

### 6.4 Stable ordering

**DS29 moved the column and the sort into PR1a — only the reordering UI is left
here, and T29 already carries it in PR2b.** `categories.sort_order INTEGER NOT
NULL DEFAULT 0` now ships in `0017` (§4.1), backfilled alphabetically within each
parent, and `loadMonthView`'s two-level ordering (DS12) lands with `T7`/`T8`. See
§4.3.

**E7 — there is no migration `0018`.** `archived_at` was the last thing left in
this section's migration, and `E7` moved it into `0017` so `DS31`'s
`copyPreviousMonth` can carry `DS12`'s archived join in PR1b. **PR2a ships no
schema change**, `T21` is deleted, and §12's S9 lane disappears — which also
retires §12's "S1 and S9 both write `drizzle/` migration files" conflict flag.

**DS12 — order both levels** (retained here for the rationale; implemented in
PR1a). Leaves sort `sort_order ASC, name ASC` instead of `spentCents DESC, name
ASC` (B4), **and** groups sort by the parent's `sort_order ASC, name ASC` instead
of `parentName.localeCompare` (`loadMonthView.ts:216`). Ordering only rows inside
groups solves half the problem: you still cannot put Giving first and Housing
second, which is the ordering EveryDollar users actually want — and which DS25's
seeded `sort_order` now gives you on day one without any UI.

Reordering UI (PR2b): `moveCategoryUpAction` / `moveCategoryDownAction` swapping
`sort_order` with the adjacent sibling, at both levels. **No drag-and-drop
library** — reuse ladder rung 4 says do not add a dependency for what two server
actions cover, and the "biggest drains first" view the old sort provided is
already served better by the dashboard trend chart.

### 6.5 Mobile, accessibility, hydration

**DS15 — mobile.** The table is `hidden sm:block` and cards are `sm:hidden`
(`page.tsx:155, 320`), so §6.1's editor covers only ≥640px; left alone the mobile
ritual is 40 modal dialogs, which is the problem §6.1 opens by describing. Left to
Budget becomes `sticky top-0` on mobile so the running total stays visible above
the keyboard.

**DS43 — the mobile budget list becomes a compact ledger row; `EnvelopeCard` is
reserved for `/goals` and the dashboard.** DS15 assumed `amountSlot` on the
existing card. `EnvelopeCard` is genuinely the signature component and genuinely
distinctive — the folded-flap corner is the opposite of a generic card, and this
is **not** the "app UI made of stacked cards" rejection — but it was designed when
`drizzle/0001` seeded five categories. There are now 46. Forty-six ornamented,
padded cards is a very long scroll where the flap stops being an ornament by row
ten, and App UI's "dense but readable" is the rule it fails on the viewport that
needs it most. PR2a's premise is that a month takes three minutes; that is not
reachable on a phone regardless of how good the input is, if the list itself is
46 cards tall.

Mobile rows become: name, planned, spent, a 2px bar, under the **same band and
group headings as desktop** — so the two viewports share one information
architecture instead of diverging right after PR1b unified them. Both renderers
read `resolveRowDisplay` (C1), which exists precisely so two layouts cannot drift.
An ornament repeated 46 times is not an ornament; `EnvelopeCard` stays special by
appearing where it is rare. It keeps `amountSlot` for PR2a's inline editing on
whichever surface still uses it.

**DS44 — DS16 splits: structural semantics ship in PR1b, interaction semantics
stay in PR2a.** DS16 is specified well and scheduled wrong. **PR1b** is the merge
that restructures the table — 10 group headings, band headings, DS18's separate
column-header row for income, DS27's three subtotal rows, DS26's hairline row —
while today those headings are `colSpan` cells (`page.tsx:195-202`). Shipping that
structure without its semantics gives a screen reader one grid whose column
meanings change halfway through, with no rowgroup structure and no caption, for a
full merge cycle — and X6 schedules a real month of use inside that window. Same
principle DS31 applied to CTAs, applied to markup: the merge that creates a
structure ships it readable.

**Into T12 (PR1b)** — attributes and element choices inside JSX T12 is already
rewriting, not new components:

- `<tbody>` per band and per group; heading as `<th scope="rowgroup">`
- category link as the row's `<th scope="row">`
- `<caption class="sr-only">` naming the month
- DS27's subtotals as `<tfoot>` or `<th scope="row">`, never a bare `<td>`
- DS26's hairline `aria-hidden`
- DS30's first-run card: primary action first in focus order, DS36's secondary link after

**Staying in T23 (PR2a)** — the expensive, interaction-bound half: the commit-only
live region, per-input `aria-label`, reorder announcements, 44px targets.

**DS16 — accessibility.**

- **Left to Budget is NOT a live region while typing.** The precedent an
  implementer will copy (`_allocate-form.tsx:124`) puts `aria-live="polite"` on a
  single field in a modal; the same treatment on a header watching 40 fields
  announces on every keystroke and makes the page unusable. Announce on *commit*
  only, via a visually-hidden `aria-live="polite"` node debounced ≥500ms, phrased
  as a sentence ("$420 left to budget"), never a bare numeral.
- `aria-label={`${leaf.name} planned amount`}` on every input — the visible label
  is a `<Link>` in a different cell.
- Each band and group wraps in its own `<tbody>` with the heading as
  `<th scope="rowgroup">` (today it is a `colSpan` cell, `page.tsx:195-202`);
  `<caption class="sr-only">` names the month; the category link is the row's
  `<th scope="row">`.
- Reorder controls: 44×44 hit area, `aria-label="Move Groceries up"`, **disabled
  rather than hidden** at list ends so the control column does not reflow, and an
  `aria-live="polite"` announcement of the new position.

**DS17 — hydration and loading.** `page.tsx` is a Server Component and
`<MonthEditor>` wraps the row list, so between first paint and hydration the
inputs render and swallow keystrokes — on the one page whose purpose is fast
typing. Scope the island to the header plus a per-band boundary so the first band
hydrates first, and render inputs `readOnly` and visually dimmed until hydrated.
Add `loading.tsx`; the repo has none anywhere today, so a cold-DB month shows a
blank page.

---

## 7. PR2b — category CRUD and archive

**X6 — split out of PR2 and sequenced after a real month of use.** Codex's read:
PR2 was carrying a CRUD subsystem wearing a budgeting hat, and CRUD/archive is
where the unhandled cross-surface dependencies live (B6 and B7 are direct
evidence — the rule engine and `/transactions`, neither of which PR2 planned to
touch). None of it is needed to validate the zero-based model: A1's seeded
taxonomy means PR2a is usable on its own, and you can budget a real month without
ever creating a category. This also puts `TODOS.md:73`'s integration checkpoint
where it can inform something.

Nothing is cut. PR2b ships after one month of real use.

### 7.1 Actions

Server actions, all Zod-validated, all returning state rather than throwing (A7's
posture, now house style for this route):

| Action | Notes |
|---|---|
| `createCategoryGroupAction` | a parent category |
| `createCategoryAction` | leaf, with `kind`, `carryover_policy`, optional `parent_id`. **DS12:** assigns `sort_order = max(sort_order) + 1` among siblings — the column default of `0` would otherwise put every new category at the top of its group |
| `renameCategoryAction` | unique-name index already enforces collisions. **This is the action that first makes F1's partial failure reachable**, which is why A8 lands the "looks like income" hint here |
| `setCategoryKindAction` | already shipped minimally in PR1b (DS22 + X1); PR2b exposes it generally |
| `setCarryoverPolicyAction` | already a documented invalidation trigger |
| `archiveCategoryAction` | see below |

**DS20 — category CRUD splits by frequency, not by kind.** Creation is
**inline**: a persistent last row per group ("+ Add a line to Housing" — a text
input that creates on Enter and immediately focuses the new row's amount cell),
plus a band footer "+ Add a group". Creating a category and funding it becomes one
motion, which is the actual ritual; a separate route breaks the flow state PR2a
exists to create. Structural and destructive actions (archive, set kind, set
carryover, reorder) live behind a per-row `⋯` menu, with `/budget/categories` as
the full management route. **This resolves O3.**

### 7.2 Archive, not delete — and archive must mean something

`transactions.category_id` is `onDelete: 'set null'` and
`budget_periods.category_id` is `onDelete: 'cascade'`, so a delete silently dumps
every transaction back into the uncategorized backlog *and* destroys the
allocation history the trend chart reads. New column `categories.archived_at
INTEGER` (nullable timestamp). The existing `categories_uncategorized_no_delete`
trigger (`drizzle/0001:8`) stays; archive must additionally refuse
`Uncategorized`.

**X3 — archive was specified in one direction only. Both halves ship here:**

```
B6: rules keep firing            B7: labels go blank
────────────────────             ──────────────────
rules.ts:44 selects every        transactions/page.tsx:67 feeds
category_rules row with no       listLeafCategories into CategoryCombobox,
join to categories and no        whose labelFor (:48-49) is
archived filter; both import       items.find(i => i.value === v)?.label ?? ""
paths auto-apply the match.      Hide archived from that list and every
An "archived" category keeps     historical row pointing at one renders
receiving transactions.          an empty label.

FIX: buildRuleMatcher EXTENDS    FIX: listLeafCategories takes
the categories join E8 already   { includeArchived } — same option shape
added in PR1a with an            getEffectiveAllocation uses, so it is
`archived_at IS NULL` clause.    house style. Pickers exclude archived;
One join, two guards (X2 + X3),  history resolves it.
one test file.
```

**E8 note:** before round 3 this said *"`buildRuleMatcher` joins `categories`"* as
if introducing the join, while `X2` put its own guard in the callers. Both guards
now sit on the one join `E8` establishes in PR1a; PR2b adds a clause, not a
second read. `TC31b` and `TC32` both live in `rules.test.ts`.

Archived categories are hidden from pickers and from months where they have no
allocation and no spend, and remain visible in historical months that do.

---

## 8. NOT in scope

| Deferred | Rationale |
|---|---|
| **PR3 — Fund *behavior*** (funds as budget rows, fixing B2's math, deciding B3's overspend semantics, dropping `is_savings_goal`, dropping `effective_allocation_cents`) | The `kind='fund'` *column value* ships in PR1a (D1B); only behavior is deferred. Changing how funds compute reinterprets existing `/goals` data on guesses, and `TODOS.md:73`'s integration checkpoint is still unchecked |
| **YNAB-style "Ready to Assign"** (assign from actual balances rather than planned income) | DS2: you asked for EveryDollar, and the plan-ahead ritual is the point. The caption states the limitation instead of hiding it |
| **Split transactions** | Explicitly NOT-in-V1 in `CLAUDE.md`; EveryDollar has it. Needs its own decision |
| **Debt snowball / Baby Steps** | Credit cards are NOT-in-V1. A debt *tracker* is feasible without card import, but it is a separate product surface |
| **Paycheck planning** (assigning lines to a specific paycheck) | EveryDollar Premium. Needs planned-income *dates*, which §3 deliberately does not model |
| **Month-scoping `/categorize` and the dashboard tile** | X4 pulls forward only the budget-page slice, which is what makes `received` trustworthy. The rest stays at `TODOS.md:430` (TD2) |
| **Drag-and-drop reordering** | §6.4 ships up/down actions; drag needs a dependency for marginal gain |
| **Dashboard card-stack redesign** | Codex hard-rejected `src/app/page.tsx` as a generic vertical card pile and asked for one dominant anchor with accounts demoted to a compact ledger list. Real, and a separate surface with its own IA problem — DS9 restyles the budget page only |
| **16px floor on explanatory copy** | Codex's universal rule. Rejected deliberately (DS13): `--text-sm` is 13px and is this app's body size, so a 16px floor would out-size the labels around the caption. The real defect was 11px at 4.1:1, which DS13 fixes |
| **Income as a separate reconciliation band** | Codex. Rejected (DS18) in favour of the approved mockup's table section with the schema change signposted |
| **Motion beyond the four specified** | **Rescoped by DS41.** The plan specifies four motions (DS6′ settle, DS4 `saving`/`saved` borders, DS7 copied-row highlight), so DS41 names the two durations, one easing and one global `prefers-reduced-motion` rule they already imply. Anything beyond those four is still its own pass |
| **Branded `Cents` type** (`TODOS.md:125`) | Large no-behavior-change diff; own pass |
| **Removing `classifyCategory`** | Zero non-test callers, but it has tests, and "delete a tested function" deserves its own look rather than riding along in a 7-site sweep. TD3 |
| **Postgres migration** | Unrelated track |

---

## 9. Failure modes

| # | Codepath | Realistic production failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|---|
| F1 | migration `0017` kind backfill | A user renamed `Paycheck`, so `WHERE name IN (...)` matches nothing and income stays misclassified — the app looks fine and B1 persists | TC5 | none possible in SQL | **mitigated, see below** |
| F2 | `leftToBudgetCents` | An income category with `carryover_policy='rollover'` (hand-set) inflates planned income | TC4 | §4.2 guard forces 0 | no |
| F3 | `copyPreviousMonth` | Prior month has no rows; copies 0 and looks broken | TC8 | returns `{copied:0}`, rendered | no |
| F4 | `archiveCategoryAction` | Archiving a category with open allocations hides money from the equation, so Left to Budget silently stops summing to zero | TC11 | reject archive when the current or a future month has a non-zero allocation | no |
| F5 | inline allocate | Two tabs edit the same cell; last write wins | no | none | yes — accepted, matches the existing stale-tab posture in `sync.ts` |
| F6 | archived category's rules | An archived category keeps receiving imported transactions (B6) | TC31 | matcher joins + skips archived (X3) | no |
| F7 | rule-driven sign mismatch | One remembered merchant files every future debit into income, poisoning `received` (B8) | TC32 | matcher skips the match (X2); row lands in the backlog | no |
| F8 | `resolveRowDisplay` | A tone rule drifts between the table and the mobile card | TC33 | one pure function, both layouts (C1) | no |
| F9 | P1 prefix scan | A rollover chain longer than two months under-reports the effective balance | TC30 | cross-checked against `getEffectiveAllocation` | **would be yes — this is why TC30 is mandatory** |
| F10 | P1 prefix scan, gap month | A month with no `budget_periods` row is treated as `allocated = 0` and the chain carries across it, so Jan + Mar (no Feb) reports $400 where today's code reports $200 (E4) | TC30 skip-month fixture | none possible — it is a computation, not an error path | **would be yes; the old oracle set had only a chain-START case (`budget.test.ts:311`), never a mid-chain gap** |
| F11 | `is_savings_goal` / `kind` drift, inverse direction | A writer sets `is_savings_goal = 1` without `kind` (today: `goals/actions.ts:19`), so the column default makes it `'expense'` — after A2 the goal vanishes from `/goals` (`eq(kind,'fund')`) and appears as a budgetable row on `/budget` (`ne(kind,'fund')`) (E6) | TC22b | none — both filters behave correctly on the data they are given | **yes — no error anywhere; a goal silently becomes a budget line** |
| F12 | PR1a landing alone | `/budget` renders 10 group headers, alphabetical order and no income rows through un-updated JSX (E1) | TC2b | n/a — reviewed and intended, not an error | no — §4 now states it |

**F1 was the one critical gap; it is now closed on both layers.**

**F10 and F11 were the two critical gaps found in round 3** — each had no test, no
error handling, and would have been silent. Both are closed by a test (`TC30`'s
skip-month fixture, `TC22b`). `F11` is `B5`'s shape read backwards: `TC18` proves
`createGoalAction`'s dual-write works the day it ships, not that it stayed — and
this repo has now shipped that exact failure twice (`applyRuleAtImport` with zero
callers for six months, `effective_allocation_cents` with zero writers for five
releases). `TC22b` pins the *invariant* (`kind` is authoritative in both
directions), not the writer.

```
Layer 1 — total failure (zero income categories)
  → /budget banner: "No income categories — Left to Budget cannot be computed"
  → CTA calls setCategoryKindAction
  → D9A refuses used categories
  → but the categories that miss the backfill ARE the used ones
  → X1 carves the exception: expense → income on an all-positive used
    category, behind a confirmation. The button now works in the only
    situation where it appears.

Layer 2 — partial failure (one renamed category, others intact)
  → the per-category "this looks like income" hint
  → A8 defers it to PR2b, because renameCategoryAction — the only thing
    that can produce this state — is PR2b. Verified: the backfill's three
    target names are intact in the database right now (ids 40-42), so the
    failure is unreachable in PR1a/PR1b/PR2a.
```

The migration writes a `categories.kind` summary line to the migration log.

---

## 10. Open questions

- **O1 — is `Reimbursement` income or a netting expense?** §4.1 assumes income
  (EveryDollar's model). If a reimbursement usually offsets a specific expense you
  already categorized, expense-kind with netting is better. Not reversible in-app
  once used (X1 only permits expense→income on an *all-positive* category, and a
  reimbursement category holds both signs). Tracked in `TODOS.md`; decide after a
  real month. Zero transactions in it today, so nothing is at stake yet.
- **O2 — when you overspend an EveryDollar Fund, does the negative carry to next
  month or reset?** Sets B3's eventual semantics in PR3. Answer from real usage.
- **O4 — what do PR2a's four allocation-cell states look like?** `saving`,
  `saved`, `failed` and `stale` are specified as border colors only (§5.3). DS4
  deliberately removed toasts, so **the border is the entire feedback channel** for
  the app's highest-frequency interaction. Deliberately deferred in design review
  round 2 to a short design pass at the top of PR2a, rather than specified on paper
  two merges early for an interaction nobody has felt yet. PR2a inherits DS41's
  motion tokens and C1's `resolveRowDisplay`, so that pass will have real materials.
  **This is the one open design item in the plan** — if the pass is skipped, the
  implementer improvises four border treatments.
- **O5 — when a rollover category has no `budget_periods` row for a month, should
  its accumulated balance reset to zero?** That is what happens today
  (`budget.ts:56` returns `null`, `:80`'s `if (prior)` guard contributes 0), and
  `E4` requires `P1`'s prefix scan to reproduce it exactly. Fund $200/month for six
  months, skip funding it in November, and December opens at $200 rather than
  $1,200. **This is a different mechanism from `O2`/`B3`** — that one is the
  `Math.max(0, …)` overspend clamp; this is a *missing row* erasing an *untouched*
  balance, which is the more surprising of the two. Latent today: all 50 seeded
  categories are `carryover_policy: 'none'`. `TC30`'s skip-month fixture pins the
  behavior either way, so what is open is whether it is the behavior you want.
  Tracked in `TODOS.md`; answer with `O2`, from real fund usage, at PR3.
- ~~O3 — where does category CRUD live?~~ **Resolved by DS20** (inline creation,
  `⋯` menu for structural actions, `/budget/categories` as the full route).

---

## 11. Test plan

Framework: **Vitest**, `pnpm test` (`vitest run`, `vitest.config.mts`). 53 test
files; colocated `*.test.ts`; `:memory:` Drizzle helper at `src/lib/test/db.ts`.
Migration-test precedent: `src/db/migration0010.test.ts`. Action-test precedent:
`src/app/budget/actions.test.ts`.

### Coverage diagram

```
CODE PATHS                                                   USER FLOWS
[+] drizzle/0017_category_kind.sql                           [+] First run after PR1a+PR1b
  ├── [GAP] TC5  income backfill by name → 3 rows flipped      ├── [GAP] virgin month → NOT success (TC19)
  ├── [GAP] TC23a fund backfill from is_savings_goal            ├── [GAP] zero income → banner + working CTA
  ├── [GAP] TC24a group taxonomy seed (A1): zero orphan         └── [GAP] [→E2E] CTA reclassifies, page survives
  │              expense categories remain
  └── [GAP] TC24b global effective_allocation_cents = NULL    [+] Build a month's budget
                                                                ├── [GAP] [→E2E] TC14 type until zero
[+] src/lib/budget.ts                                           ├── [GAP] [→E2E] TC15 tab 10 rows, no reload
  ├── categoryMonthPredicate() (new)                            └── [GAP] TC13 copy last month, then adjust
  │   └── [GAP] TC20 window + transfer; sign stays at caller
  ├── computeMtdSpent()  (refactored)                         [+] Income reconciliation
  │   ├── [★★★ EXISTS] budget.test.ts:103-249                   ├── [GAP] TC6  planned > received → variance
  │   │   (happy, refunds, transfers, boundaries, Dec→Jan)      ├── [GAP] TC6  clawback nets down received
  │   └── [GAP] TC2  REGRESSION — byte-identical post-refactor  └── [GAP] TC3b pending paycheck NOT counted (TS2)
  ├── computeMtdReceived() (new)
  │   ├── [GAP] TC3  positives sum, clawback nets              [+] Error / empty states
  │   └── [GAP] TC3b pending EXCLUDED  ← TS2                     ├── [GAP] TC11 archive w/ allocation → refused
  ├── getEffectiveAllocation()                                   ├── [GAP] TC8  copy from empty month
  │   ├── [★★★ EXISTS] 11 tests, budget.test.ts:251-422          ├── [GAP] TC17b fundCount 0 → no FUNDS section
  │   ├── [GAP] TC4  income kind forces rollover 0               └── [GAP] TC23b setCategoryKind RETURNS state
  │   └── [GAP] TC30 ORACLE — agrees with the set-based read
  ├── invalidateForwardRollover()                              [+] Regression guards
  │   └── [★★★ EXISTS] budget.test.ts:424-545                    ├── [GAP] TC2  spent unchanged for expenses
  ├── invalidateForwardRolloverMany() (new)                      ├── [GAP] TC7  paycheck out of spentCents ← B1
  │   └── [GAP] TC28 N categories == N single calls              ├── [GAP] TC34a loadGoals repoint  ← MANDATORY
  └── rollover prefix scan (P1, new)                             └── [GAP] TC34b loadMonthlyTrends ← MANDATORY
      ├── [GAP] TC30 6-month chain accumulates fully
      └── [GAP] TC30 clamp applies per month, not once        [+] src/lib/budget/resolveRowDisplay.ts (NEW — C1)
                                                                 ├── [GAP] TC33a >100% → amber bar, not red (DS8′)
[+] src/lib/budget/loadMonthView.ts                              ├── [GAP] TC33b income over plan → green + chip
  ├── [GAP] TC6/TC7  income split, B1 regression                 ├── [GAP] TC33c variance neutral while month open
  ├── [GAP] TC9   leftToBudget uses allocated, not effective     └── [GAP] TC33d unset "—" vs budgeted "0.00"
  ├── [GAP] TC17  fund subtracts, renders no row pre-A6
  ├── [GAP] TC17b A6 — fundCount 0 → section absent           [+] src/lib/money.ts (C4)
  ├── [GAP] TC22  kind drift: is_savings_goal=0, kind=fund      ├── [★★ EXISTS] money.test.ts, parseAmount.test.ts
  ├── [GAP] TC25a A1 — bands from kind; no "Ungrouped" header   └── [GAP] TC16b "$1,234.56" and "1,234" parse
  ├── [GAP] TC25b X5 — Uncategorized excluded from planned
  ├── [GAP] TC27  X4 — month-scoped backlog count              [+] src/lib/rules.ts
  ├── [GAP] TC31  RECONCILIATION INVARIANT  ← TS4                ├── [GAP] TC31b X3 — archived category skipped
  ├── [GAP] TC29  query-count INVARIANCE, 5 vs 50  ← TS5        └── [GAP] TC32  X2 — negative row not filed to income
  ├── [GAP] TC21  groupIntoSections injected comparator
  ├── [GAP] TC10  order stable while spend changes  ← B4       [+] src/lib/categories.ts
  └── [GAP] TC26  groups order by parent sort_order              └── [GAP] TC31c includeArchived resolves labels

[+] src/lib/budget/copyMonth.ts (new)                        [+] src/lib/budget/upsertAllocation.ts
  ├── [GAP] TC8   copies blanks, skips existing                  └── [GAP] TC12 INVERTED (A4) — cache stays NULL
  └── [GAP] TC24  archived excluded, counted separately

COVERAGE: 6/44 paths tested (14%)  |  Code paths: 6/36 (17%)  |  User flows: 0/8 (0%)
QUALITY: ★★★:3  ★★:3  ★:0  |  GAPS: 38 (3 E2E, 0 eval)
```

### Eng review round 3 delta

```
CODE PATHS — CHANGED OR ADDED BY ROUND 3              USER FLOWS
[~] drizzle/0017 (kind + sort_order + archived_at)
  ├── [GAP] TC24a RESTATED (E3) — leaf-scoped:        [~] Land PR1a alone
  │           every non-parent kind='expense' row       └── [GAP] TC2b (E1) REGRESSION —
  │           has a parent, except Uncategorized             10 sections not 1, no
  ├── [GAP] TC35  EXTENDED (E2) — sort_order                 "Ungrouped" header, income
  │           non-null on all 60, unique per parent           absent from `sections`,
  └── [GAP] TC24  UNBLOCKED (E7) — archived_at now            order stable across runs
            exists in PR1b, so copyMonth's DS12
            join parses and TC24 can run             [+] Fund with a skipped month
                                                       └── [GAP] TC30 skip-month (E4)
[+] src/lib/budget/loadUncategorizedBacklog.ts (E5)         Jan + Mar, no Feb → chain
  └── [GAP] TC27 MOVED here; scoped vs unscoped              terminates; Jan does NOT
            differ on a two-month fixture                    carry into Mar   ← F10

[~] src/lib/rules.ts — buildRuleMatcher(m, cents)     [+] Goal drifts out of /goals
  └── [GAP] TC32 MOVED here (E8), now runnable:         └── [GAP] TC22b (E6) — is_savings_
            negative → income rejected; positive              goal=1 + kind='expense'
            → fund rejected. ONE categories join             renders as a budget row AND
            that X3 extends in PR2b, not a 2nd read          is absent from goals  ← F11

[+] src/lib/budget/monthOfIso.ts — monthPhase() (E12) [+] Month closes overnight
  └── [GAP] TC41 future / open / closed; local          └── [GAP] TC41 — Sep is 'open' on
            midnight boundary; Dec→Jan rollover;              Sep 30 23:59 local, 'closed'
            follows process.env.TZ, not UTC                   on Oct 1 00:00 local

[~] src/lib/budget/resolveRowDisplay.ts
  ├── [GAP] TC40 EXTENDED (E11) — barTone is a token,
  │           never --accent-redbrown, and identical
  │           for table row and mobile row on identical
  │           inputs   ← F8 tested, not asserted
  └── [~]   signature takes `phase`, not two booleans (E12);
            TC33c / TC38 / TC39 restate against it

REVISED TOTALS: 39 code paths (was 36)  |  41 gaps (was 38)
  3 new ids (TC2b, TC22b, TC41) · 3 extended (TC30, TC35, TC40)
  · 2 relocated (TC27, TC32) · 1 restated (TC24a) · 1 unblocked (TC24)
```

Legend: ★★★ behavior + edge + error · ★★ happy path · ★ smoke · [→E2E] integration

### Mandatory regression tests (REGRESSION RULE — not optional, not negotiable)

| # | Why it is a regression |
|---|---|
| **TC2** | `computeMtdSpent` is refactored under existing callers. Pins byte-identical output for expense categories, fixture-driven |
| **TC7** | B1 is existing broken behavior. Pins a +$2,000 income row out of `summary.spentCents` |
| **TC34a** | A2 repoints `loadGoals.ts:44` from `isSavingsGoal` to `kind`. **`loadGoals` has no test file at all** — `git ls-files` shows none. Pin current output on a fixture, then swap |
| **TC34b** | A2 repoints `loadMonthlyTrends.ts:61`. **Also has no test file.** Same treatment |
| **TC30** | P1 replaces the rollover algorithm. Without the cross-check against `getEffectiveAllocation`, F9 ships silently — all 26 existing budget tests would still pass while the shipping path computes a different number. **E4: the oracle set is not sufficient on its own.** `budget.test.ts:311` is a chain-*start* case (one row, read in its own month), not a mid-chain gap, so a scan that carries across a missing month passes every existing test. The skip-month fixture is part of TC30, not optional |
| **TC2b** | **(E1)** PR1a restructures what `/budget` renders through un-updated JSX. Pins the four consequences named in §4 so they are reviewed, not discovered: 10 sections not 1, no `"Ungrouped"` header, income absent from `sections`, order stable across two runs with different spend |
| **TC22b** | **(E6)** `A2` makes `kind` authoritative while `is_savings_goal` survives as a shadow, and `goals/actions.ts:19` writes the boolean without `kind` until `T5`. Pins the *invariant* in both directions rather than the writer — `TC18` proves the dual-write works the day it ships, which is exactly what `applyRuleAtImport` and `effective_allocation_cents` also proved |

### Required tests

| # | File | Asserts |
|---|---|---|
| TC1 | `budget.test.ts` | `categoryMonthPredicate` via its wrappers: empty → 0, transfer-paired excluded, rows on the 1st and last day included, next-month row excluded |
| TC2 | `budget.test.ts` | **REGRESSION** — `computeMtdSpent` byte-identical for expense categories |
| TC3 | `budget.test.ts` | `computeMtdReceived`: positives sum, a negative clawback nets down, transfer-paired excluded |
| TC3b | `budget.test.ts` | **(TS2)** a pending row in an income category does NOT count toward received, while a pending row in an expense category still counts toward spent |
| TC4 | `budget.test.ts` | income category with `carryover_policy='rollover'` → `rolloverCents === 0` |
| TC5 | `src/db/migration0017.test.ts` (new) | applied to a DB with a renamed `Paycheck` → the banner condition is true; applied to the real seed → three rows flip to income |
| TC6 | `loadMonthView.test.ts` | income section populated; variance = received − planned, negative when short |
| TC7 | `loadMonthView.test.ts` | **REGRESSION (B1)** — a +$2,000 income row is absent from `summary.spentCents` and does not render as "remaining" |
| TC8 | `copyMonth.test.ts` (new) | copies missing rows, skips existing, returns `{copied, skipped}`, empty source → `{0,0}` |
| TC9 | `loadMonthView.test.ts` | `leftToBudget` uses `allocated_cents` not `effective_allocation_cents` (a rollover category proves the difference); zero case; negative case |
| TC10 | `loadMonthView.test.ts` | **(B4)** row order stable across two runs with different spend |
| TC11 | `archiveCategory.test.ts` (new) | refuses `Uncategorized`; refuses a category with a non-zero allocation in the current or a future month; succeeds otherwise |
| TC12 | `budget.test.ts` | **INVERTED (A4)** — after `upsertAllocation`, `effective_allocation_cents` is still NULL, and `loadMonthView` produces correct figures with it NULL. Pins D7A′ so a future "let's cache this" PR fails a test instead of shipping |
| TC13-15 | manual / `/qa` | see the test-plan artifact |
| TC16 | `validateAllocateInput.test.ts` | Zod rejects negative planned, month 13, year 1999, unknown kind, **and (C3) a value above `100_000_000`** |
| TC16b | `money.test.ts` | **(C4)** `parseAmountToCents` handles `"$1,234.56"`, `"1,234"`, and rejects garbage; existing simplefin cases still pass from the new home |
| TC17 | `loadMonthView.test.ts` | **(D3A)** a `kind='fund'` category with a $200 allocation reduces `leftToBudgetCents` by $200 and sets `plannedFundCents=200_00` |
| TC17b | `loadMonthView.test.ts` | **(A6)** with zero fund categories, `fundCount === 0`, `fundRows` is empty, and the reconciliation invariant still holds |
| TC18 | `src/app/goals/` integration | **(D1B)** `createGoalAction` writes `kind='fund'` as well as `isSavingsGoal=true`; a goal created after `0017` is counted by TC17's denominator |
| TC19 | `loadMonthView.test.ts` | **(DS6′)** `plannedIncome === 0` never yields the success state, whatever `leftToBudget` is |
| TC20 | `budget.test.ts` | **(D5A)** `categoryMonthPredicate` excludes transfer-paired rows and rows outside `[first, firstOfNext)`; a refund inside the window is INCLUDED by the predicate (the sign decision belongs to the caller) |
| TC21 | `loadMonthView.test.ts` | **(D6A)** `groupIntoSections` honors the injected comparator — same rows, two comparators, two orders |
| TC22 | `loadMonthView.test.ts` | **(D10A)** a `kind='fund'` category with `is_savings_goal = 0` (drift simulated) is still excluded from budget rows and still counted in the denominator |
| TC23 | `setCategoryKind.test.ts` (new) | **(D9A)** refuses a category with ≥1 transaction; refuses one with ≥1 `budget_periods` row; succeeds on an unused one and invalidates forward rollover |
| TC23b | `setCategoryKind.test.ts` | **(X1 + A7)** allows expense→income on a USED all-positive category; refuses one holding any negative row; refuses income→expense on a used category; **returns an error state rather than throwing** |
| TC24 | `copyMonth.test.ts` | **(DS12)** an archived category with a prior-month allocation is NOT copied and is reported in `skippedArchived` |
| TC24a | `migration0017.test.ts` | **(A1 + DS25 + E3, RESTATED)** after the migration, every `kind='expense'` category that is **not a parent of any other category** has a non-NULL `parent_id`, except `Uncategorized`. **This assertion was unsatisfiable twice.** Round 2: eight groups left eight leaves orphaned, fixed by DS25. Round 3: the predicate as written also caught the 10 new group parents, which are themselves `kind='expense'` with `parent_id IS NULL` — so it failed by 10 on a *correct* migration. DS25 fixed the leaves and never re-read the assertion it was fixing |
| TC35 | `migration0017.test.ts` | **(DS25 + E2)** the mapping is exact and total: 10 group parents exist, all 46 expense leaves resolve to one of them, every group is non-empty, and the group `sort_order` values are 1-10 with no duplicates. **E2 adds:** `sort_order` is non-null on all 60 rows and unique within each `parent_id` — which is what proves the backfill ran *after* the `parent_id` UPDATEs rather than numbering one flat bucket. A future category added to `0002` without a parent fails here rather than on the page |
| TC2b | `loadMonthView.test.ts` | **(E1, REGRESSION)** against a post-`0017` fixture: `sections.length === 10`; no section's `parentName` is `"Ungrouped"` or null; no `kind='income'` category appears in `sections`; and `sections` plus each section's leaf order are identical across two runs whose spend differs. Pins the four ways PR1a changes the rendered page, so §4's revised claim is enforced rather than asserted |
| TC22b | `loadMonthView.test.ts` | **(E6)** a category with `is_savings_goal = 1` and `kind = 'expense'` (the inverse of TC22's drift) renders as an ordinary budget row and is absent from `loadGoals`. Pins that `kind` is authoritative in **both** directions — TC22 only ever tested one |
| TC41 | `monthOfIso.test.ts` | **(E12)** `monthPhase(2026, 9, …)` is `'open'` at `2026-09-30T23:59` local and `'closed'` at `2026-10-01T00:00` local; `monthPhase(2026, 10, …)` is `'future'` on `2026-09-30`; the Dec→Jan rollover; and the boundary follows `process.env.TZ` rather than UTC — the bug `src/lib/now.ts` exists to prevent, and the reason `CLAUDE.md` makes the container refuse to boot without `TZ` |
| TC35b | `loadMonthView.test.ts` | **(DS26)** `Uncategorized` is absent from `MonthView` when it has no month spend and no month-scoped backlog; present, last, and carrying no allocate affordance when it has either |
| TC36 | `loadMonthView.test.ts` | **(DS27)** the three band subtotals equal `plannedIncomeCents` / `allocatedCents` / `plannedFundCents`, and `income − spending − funding === leftToBudgetCents` over the same mixed fixture TC31 uses. Redundant with TC31 by construction — that is the point: it pins the *rendered* figures, not just the summary |
| TC37 | `loadMonthView.test.ts` | **(DS30)** a seeded-but-unallocated month sets the first-run condition (`plannedIncome === 0 && allocatedCents === 0`) **and** leaves `sections.length > 0`, so the old empty branch is provably unreachable and the new one provably fires |
| TC38 | `resolveRowDisplay.test.ts` | **(DS33)** an income row whose shortfall is fully covered by pending renders the pending badge and a **neutral** variance; the same row with no pending renders per DS21. Pins that TS2's asymmetry is disclosed rather than silent |
| TC39 | `resolveRowDisplay.test.ts` | **(DS35)** the same short income row renders neutral while `monthHasEnded` is false **and after it becomes true**; an overspent expense row renders `--money-neg` in both. Pins that closing a month changes nothing on the income side and that red stayed attached to overspend |
| TC40 | `resolveRowDisplay.test.ts` | **(DS40 + E11)** an envelope at 80% and one at 120% produce different output — both amber-filled, only the second carrying the overflow tick; the bar is never `--accent-redbrown`. Pins that DS8's one-red-signal rule did not erase the nearly-done/over distinction. **E11 adds:** `barTone` is returned as a design-system token name (never a raw Tailwind class such as `bg-amber-500`), and the table row and the mobile row receive an identical value from identical inputs — which is **F8** ("a tone rule drifts between the table and the mobile card") tested rather than asserted |
| TC25 | `createCategory.test.ts` (new) | **(DS12)** a new sibling gets `sort_order = max+1`, landing last in its group |
| TC25a | `loadMonthView.test.ts` | **(A1)** bands come from `kind`; no section header is ever the string `"Ungrouped"`; an unparented category renders directly under its band |
| TC25b | `loadMonthView.test.ts` | **(X5)** `Uncategorized` renders as a row with spend but contributes nothing to `allocatedCents` or `leftToBudgetCents`, and carries no allocate affordance |
| TC26 | `loadMonthView.test.ts` | **(DS12)** groups order by parent `sort_order`, not alphabetically |
| TC27 | `loadUncategorizedBacklog.test.ts` (new — **moved by E5**) | **(X4 + E5)** `loadUncategorizedBacklog` scoped to a month counts only that month's uncategorized rows; unscoped still counts all time; the two differ on a fixture spanning two months. Lives with the extracted module, not in `loadMonthView.test.ts` |
| TC28 | `budget.test.ts` | **(D8A)** `invalidateForwardRolloverMany` clears the same rows for N categories that N single calls would, and the single-category function delegates to it |
| TC29 | `loadMonthView.test.ts` | **(TS5)** query-count **invariance** — a 5-category and a 50-category fixture, both rollover-enabled, issue the *same* number of statements. Never asserts a constant |
| TC30 | `budget.test.ts` | **(P1 + E4, MANDATORY)** the set-based prefix scan agrees with `getEffectiveAllocation` across every case in `budget.test.ts:251-422`, plus a 6-month unspent chain accumulating fully and a mid-chain overspend clamping per month. **E4 adds the skip-month fixture, which the oracle set does not supply:** Jan $200 · Feb no row · Mar $200 → `effective(Mar) === 200`, not 400. The chain terminates at the gap. Without this case a scan that iterates existing rows passes every other assertion here |
| TC31 | `loadMonthView.test.ts` | **(TS4)** RECONCILIATION INVARIANT — over a mixed fixture (income + expense + fund + rollover + archived + unallocated + `Uncategorized`), `plannedIncome − Σ visible expense planned − Σ visible fund planned === leftToBudget`. Must hold with zero funds too |
| TC31b | `rules.test.ts` | **(X3 / B6)** `buildRuleMatcher` returns no match for a rule whose category is archived |
| TC31c | `categories.test.ts` | **(X3 / B7)** `listLeafCategories({ includeArchived: true })` returns archived rows so a historical label resolves; the default excludes them |
| TC32 | `rules.test.ts` | **(X2 / B8 / E8)** `buildRuleMatcher(merchant, amountCents)` returns no match for a negative row against a `kind='income'` category, and none for a positive row against a fund; manual `categorizeTransaction` of a negative row into income still succeeds (the clawback case). **E8 is what makes this runnable here** — as originally filed, X2 put the guard in `importBatch.ts`/`sync.ts` while the test sat in a module whose matcher signature was `(normalizedMerchant: string) => …` and never saw an amount |
| TC33 | `resolveRowDisplay.test.ts` (new) | **(C1)** all four rule families: DS8′ amber over 100%, DS12 income capped and green with an over-plan chip, DS21 neutral variance while the month is open, DS14 `—` vs `0.00` |
| TC34 | `loadGoals.test.ts`, `loadMonthlyTrends.test.ts` (both new) | **REGRESSION (A2)** — output pinned on a fixture before and after the `kind` repoint |

UI component tests stay out of scope per `CLAUDE.md` ("Tests for UI components
(categorization logic only)"). **That is precisely why C1 exists:** every display
rule the design review wrote lives in `resolveRowDisplay`, a pure function, where
this repo is allowed to test it. TC13-15 are covered by `/qa` against the
test-plan artifact.

---

## 12. Parallelization

Rewritten for the four-merge split (A5), then again for `DS31`/`DS34`/`E7` (E10).

**This table is DERIVED from §13. When a task moves between merges, this moves
with it.** It went stale twice already: `A5` rewrote it after the four-way split,
and design round 2 then moved `copyPreviousMonth` (`DS31`) and `loading.tsx`
(`DS34`) into PR1b while this table kept scheduling copy-month into PR2a — on the
one document a person reads immediately before opening three parallel worktrees.

| Step | Modules touched | Depends on |
|---|---|---|
| S1 migration `0017` + schema — `kind`, groups, **`sort_order`** (DS25/DS29), **`archived_at`** (E7) | `drizzle/`, `src/db/` | — |
| S2 budget math (predicate, received, income guard, month helpers + **`monthPhase`** — E12, money parser) | `src/lib/budget.ts`, `src/lib/budget/monthOfIso.ts`, `src/lib/money.ts` | S1 |
| S3 `kind` repointing, all 7 sites + **the sign guard inside `buildRuleMatcher`** (E8) | `src/lib/budget/`, `src/lib/goals/`, `src/lib/trends/`, `src/lib/categories.ts`, `src/lib/categorize/`, `src/lib/rules.ts` | S1 |
| S4 set-based `loadMonthView` + P1 prefix scan + `leftToBudget` + **backlog extraction** (E5) | `src/lib/budget/` | S2, S3 |
| S5 `resolveRowDisplay` | `src/lib/budget/` | S4 |
| S6 budget surface (card, bands, restyle, StateCard, SummaryStrip, `error.tsx`, **`loading.tsx` — DS34**) | `src/app/budget/`, `src/app/`, `src/components/ledger/` | S5 |
| S7 `/goals` rework | `src/app/goals/`, `src/lib/goals/` | S3 |
| S8 `setCategoryKindAction` + X1 exception + DS32's dialog | `src/lib/budget/`, `src/app/budget/` | S3 |
| S9 **`copyPreviousMonth` + its action and triggers (DS31, T16c)** — moved here from PR2a | `src/lib/budget/`, `src/app/budget/` | S4 |
| S10 route boundaries for the remaining 9 routes (DS47, 17 files — E10) | `src/app/` | S6 |
| S11 inline allocate island + currency input + mobile/a11y/hydration | `src/app/budget/` | S6, S9 |
| S12 category CRUD + archive + X3's archived clause | `src/app/budget/`, `src/lib/budget/`, `src/lib/rules.ts`, `src/app/transactions/` | S11 |

```
PR1a  Lane A:  S1 → S2 → S4                (the spine)
      Lane B:  S3                          (after S1; touches 6 modules but
                                            none of Lane A's, and S4 waits)
      Lane C:  S5                          (after S4 — pure, no deps beyond it)

      A and B in parallel after S1 lands. Merge both. Then S4, then S5.

PR1b  Lane D:  S6 → S10                    (budget surface, then the other
                                            routes' boundaries — S10 needs
                                            C5's StateCard from S6)
      Lane E:  S7                          (goals surface — genuinely independent
                                            NOW, because S3 already moved the
                                            loadMonthView touches into PR1a)
      Lane F:  S8                          (one action + validator + dialog)
      Lane G:  S9                          (copyPreviousMonth — pure lib +
                                            one action; DS31 moved it here and
                                            E7 gave it the archived_at column
                                            it needs)

      D, E, F and G in parallel. G touches src/app/budget/ like D does —
      see the conflict flag below.

PR2a  Lane H:  S11                         (single lane, no schema change —
                                            E7 deleted migration 0018)

PR2b  Lane I:  S12                         (single lane)
```

**Conflict flags:**
- **S1 is the only migration in the whole plan** (E7 deleted `0018`). Nothing to
  serialize against. The previous "S1 and S9 both write `drizzle/`" flag is retired.
- **S2, S4 and S5 all touch `src/lib/budget/`.** Same lane, sequential.
- **S6 and S9 both touch `src/app/budget/`** — S9 adds the action and the two
  triggers into files S6 is rewriting wholesale (`page.tsx`). Run S9 *after* S6
  in the same worktree, or accept a hand-merge on `page.tsx`. This is the one real
  PR1b conflict and it is new, created by `DS31` moving copy forward.
- **S3 reaches into `src/lib/categorize/` and `src/lib/rules.ts`**, which S12 also
  touches — three merges apart, so a rebase note, not a conflict. Note `E8` makes
  S3's change to `rules.ts` structural (the matcher's signature), so S12's archived
  clause is an edit to S3's join rather than a new one.
- The pre-`A5` plan's "Lane B is independent, 20 minutes" was removed and stays
  removed: DS11/DS12/DS21 gave the `/goals` work a `loadMonthView.ts` dependency,
  which S3 absorbs into PR1a.

---

## 13. Implementation tasks

`T` = task, `TC` = test. Checkbox as you ship.

### PR1a — data and math (no visual change)

- [x] **T1 (P1, human: ~6h / CC: ~50min)** — schema — migration `0017`: `categories.kind`, income backfill, fund backfill, **the full DS25 group taxonomy (10 groups, 46 leaves mapped explicitly)**, **`sort_order` column + alphabetical-within-parent backfill (DS29/E2)**, **`archived_at` column (E7 — absorbs the deleted T21)**, global cache clear
  - Surfaced by: §2 B1; A1 — 50/50 categories have `parent_id NULL` and nothing can create a group before PR2b; **DS25 — A1's eight groups left 8 categories orphaned and `TC24a` unsatisfiable**; **DS29 — without `sort_order` here, PR1b ships A1's groups plus B4's reshuffle-as-you-spend in one merge**; **E2 — the SQL block wrote to `sort_order` without creating it, so the migration died on its first group INSERT**; **E7 — `DS31` moved `copyPreviousMonth` into PR1b but its `DS12` archived join needs a column PR2a was scheduled to add**
  - **Rebase onto `origin/main` first.** It already carries `drizzle/0016_tired_thing.sql` (v0.12.4 / PR #34); this branch is one commit behind. `0016` is taken.
  - **This is now the only migration in the plan.** `0018` is deleted (E7).
  - Order inside the file matters: three `ADD COLUMN`s → kind backfills → group INSERT → `parent_id` UPDATEs → **then** the `sort_order` backfill (it partitions on `parent_id`, so running it earlier numbers one flat bucket) → cache clear.
  - Files: `drizzle/0017_category_kind.sql`, `src/db/schema.ts`, `src/db/migration0017.test.ts`
  - Verify: `pnpm db:migrate` then `pnpm test`; TC5, **TC24a (restated — E3)**, **TC35 (extended — E2)**
- [x] **T2 (P1, human: ~2h / CC: ~15min)** — budget math — extract `categoryMonthPredicate`, add `computeMtdReceived` (pending excluded, TS2), force rollover 0 on income
  - Surfaced by: §2 B1; D5A; TS2
  - Files: `src/lib/budget.ts`, `src/lib/budget.test.ts`
  - Verify: TC1, TC3, TC3b, TC4, TC20 + **regression TC2**
- [x] **T3 (P1, human: ~1.5h / CC: ~20min)** — DRY — move `monthBoundary`, `nextMonth`, `previousMonth`, `nMonthsBack` into `monthOfIso.ts`; update all call sites; **add `monthPhase(year, month, now)` → `'future' | 'open' | 'closed'` (E12)**
  - Surfaced by: D4A — four verbatim copies; prior learning `mm-month-helpers-duplicated-four-times` (10/10); **E12 — `resolveRowDisplay`'s `monthHasStarted`/`monthHasEnded` booleans had no producer anywhere in `src/`, so the date comparison was going to be written inline in a component, where `CLAUDE.md` forbids testing it**
  - `monthPhase` reads the clock through `src/lib/now.ts` (never `.toISOString()`), and replaces the boolean pair — three states, not four; `started=false && ended=true` was expressible and impossible.
  - While here: `page.tsx:78`'s `shiftMonth(year, month, delta)` is a sixth month-arithmetic variant. It is correct, but T12 rewrites that file anyway — fold it into this sweep rather than leaving a seventh home.
  - Files: `src/lib/budget/monthOfIso.ts` + test, `src/lib/budget.ts`, `src/lib/budget/loadMonthView.ts`, `src/lib/trends/loadMonthlyTrends.ts`, `src/lib/categorize/loadTransactions.ts`, `src/app/budget/[year]/[month]/page.tsx`
  - Verify: **TC41**; `pnpm test` unchanged otherwise
- [x] **T4 (P1, human: ~1h / CC: ~15min)** — money — move `parseAmountToCents` to `src/lib/money.ts`, add `$`/`,` stripping, rename `SimpleFinAmountError` → `AmountParseError`, use it in `upsertBudgetAllocationAction`
  - Surfaced by: C4 — `Math.round(Number(dollars) * 100)` at `budget/actions.ts:27`, against `CLAUDE.md` rule 1
  - Files: `src/lib/money.ts`, `src/lib/simplefin/parseAmount.ts` (removed), `src/app/budget/actions.ts`, simplefin importers
  - Verify: TC16b; existing `parseAmount.test.ts` cases green from the new home
- [x] **T5 (P1, human: ~2h / CC: ~20min)** — schema reads — repoint **all seven** `is_savings_goal` readers to `kind`; `createGoalAction` dual-writes
  - Surfaced by: A2 — the plan listed 4; `categorizeTransaction.ts:77`, `bulkCategorize.ts:96` and `goals/actions.ts:41` were missed, and PR3 would have deleted those guards silently
  - Files: `loadMonthView.ts`, `loadGoals.ts`, `loadMonthlyTrends.ts`, `categories.ts`, `categorizeTransaction.ts`, `bulkCategorize.ts`, `goals/actions.ts`
  - Verify: TC18, TC22, **TC22b (E6 — the inverse drift)** + **regressions TC34a, TC34b**
- [x] **T6 (P1, human: ~2h / CC: ~20min)** — safety — automatic categorization never files a sign-mismatched row into income or a fund, **guarded inside `buildRuleMatcher` (E8)**
  - Surfaced by: X2 / B8 — one remembered merchant poisons `received` forever; **E8 — X2 put the guard in two callers while X3 (PR2b) puts the identical `categories` join inside the matcher, for the same table and the same reason. `CLAUDE.md`: "one guard in the shared function beats a guard in every caller"**
  - The matcher's returned function takes the amount: `(normalizedMerchant: string, amountCents: number) => RuleMatch | null`. The builder joins `categories` for `kind` in the query it already runs once per batch. PR2b's X3 adds `archived_at IS NULL` to that same join rather than a second read.
  - Files: `src/lib/rules.ts`, `src/lib/importBatch.ts`, `src/lib/simplefin/sync.ts`
  - Verify: **TC32, now in `rules.test.ts` where it can actually run** (including: manual clawback into income still succeeds — it does not route through the matcher)
- [x] **T7 (P1, human: ~5h / CC: ~45min)** — read model — income sections, bands from `kind`, `leftToBudgetCents`, `fundCount`, month-scopable backlog; **`Uncategorized` returned as its own field, conditional on spend-or-backlog (DS26)**; **two-level `sort_order` ordering (DS29/DS12)**; **band subtotal figures exposed for DS27**
  - Surfaced by: §3 target model; A1; A6; X4; X5; **DS26** — an inert read-only row led the section the user fills in, and rendered even with nothing to say; **DS27** — nothing on screen summed to the headline; **DS29** — B4's spend-ordered sort survives into the merge that introduces the grid
  - **Also carries E5's extraction:** `loadUncategorizedBacklog` moves to its own module `src/lib/budget/loadUncategorizedBacklog.ts`, exported, with X4's optional `(year, month)` scope. `loadMonthView` imports it and keeps the `MonthView` field; `/categorize` and `/transactions` call it directly and stop building a month view for one `COUNT(*)`.
  - **Also carries E1's regression pin:** `TC2b` asserts the four structural consequences of PR1a rendering through un-updated JSX.
  - Files: `src/lib/budget/loadMonthView.ts` + test, `src/lib/budget/loadUncategorizedBacklog.ts` + test (new — E5), `src/app/categorize/page.tsx`, `src/app/transactions/page.tsx`
  - Verify: TC6, TC7, TC9, TC10, TC17, TC17b, TC19, TC21, TC25a, TC25b, TC26, **TC27 (in its new home)**, **TC31**, **TC35b**, **TC36**, **TC2b**, **TC22b**
- [ ] **T8 (P1, human: ~4h / CC: ~40min)** — perf — set-based `loadMonthView` with **P1's clamped prefix scan and E4's stated base case**; delete `getEffectiveAllocation`'s `persist`; keep it as the single-row API; **E13's query merge**
  - Surfaced by: §2 B5; D7A′; **P1 — a prior-month lookup is wrong past two months**; TS1; **E4 — P1 never said what a gap month does, and the behavior it must reproduce (chain terminates, `budget.ts:56`/`:80`) is not in TC30's oracle set**; **E13 — the six-query list held two derivable queries**
  - **E4:** the scan starts at the earliest *contiguous* row before the target, not the earliest row. Jan $200 · Feb no row · Mar $200 → `effective(Mar) = 200`.
  - **E13:** fold `loadPendingByCategory` into the spend `GROUP BY` (same window, same grouping, two aggregates) and compute fund rows from the `categories` + `budget_periods` reads already in memory. Four queries, plus two when a rollover category exists.
  - Files: `src/lib/budget/loadMonthView.ts`, `src/lib/budget.ts`
  - Verify: **TC30 (mandatory oracle + E4's skip-month fixture)**, TC29 invariance, TC12; closes `TODOS.md:197`
- [ ] **T9 (P1, human: ~5h / CC: ~45min)** — display rules — pure `resolveRowDisplay`, signature **`(row, kind, phase)`** where `phase` comes from `monthPhase` (E12)
  - Surfaced by: C1 — **five** copies of the tone ladder across two color systems (E11); `CLAUDE.md` bans UI component tests, so rules in JSX are untestable. **DS35 — the original signature could not express DS21, one of the four rules this function owns. DS33 — income pending disclosure is a fifth rule and belongs here, not in JSX. E12 — the boolean pair DS35 arrived at had no producer anywhere in `src/` and admitted an impossible fourth state (`started=false && ended=true`). E11 — the desktop table's own bar (`page.tsx:292-296`, raw Tailwind palette) was missing from C1's inventory, and it is the copy DS40 must change**
  - `barTone` is returned as a token name. Neither renderer writes a color.
  - Files: `src/lib/budget/resolveRowDisplay.ts` + test
  - Verify: TC33a-d, **TC38 (DS33 pending disclosure), TC39 (DS35 month-close, restated against `phase`), TC40 (DS40 + E11's token and cross-layout identity)**
- [ ] **T10 (P2, human: ~45min / CC: ~12min)** — docs — **five** stale JSDoc blocks (C2 + E9); B3's rationale comment **and O5's beside it (E4)**; `invalidateForwardRollover`'s contract rewritten to say the read branch is unreachable (P3); inline ASCII diagrams in `budget.ts` (two-sign dispatch), `copyMonth.ts` (pipeline), `resolveRowDisplay.ts` (rule table), **`loadMonthView.ts` (E9 — the band/group/leaf axes, the hardest structure in this plan to reconstruct from the code)**
  - Surfaced by: C2; P3; standing diagram preference; **E9 — C2 listed four blocks and stepped over `loadMonthView.ts:63-66`, which documents the synthetic `"Ungrouped"` section A1 deletes and cites superseded decision id `T3A`. Same shape as DS42, which caught the `DESIGN.md` equivalent by counting**; **E4 — the gap-month chain reset (O5) has no comment anywhere, while its structural twin B3 gets a rationale, a test and an open question**
  - Files: `src/lib/budget.ts`, `src/lib/budget/loadMonthView.ts`, `src/lib/budget/upsertAllocation.ts`
  - Verify: read; `grep -n "Ungrouped" src/lib/budget/loadMonthView.ts` returns nothing that claims it renders

### PR1b — the surface

- [ ] **T11 (P1, human: ~4h / CC: ~35min)** — UI — Left to Budget card, five states incl. the `plannedIncome === 0` guard, 240ms success settle
  - Surfaced by: DS6′ — a virgin month satisfies `0 − 0 − 0` and renders "every dollar has a job" before the user types anything; prior learning `zero-based-budget-empty-state-false-success` (9/10)
  - Files: `src/components/ledger/left-to-budget.tsx`
  - Verify: TC19; all five states, both themes
- [ ] **T12 (P1, human: ~4h / CC: ~40min)** — UI — restyle `/budget/[year]/[month]` fully to Ledger Paper tokens; bands, income section, FUNDS (conditional), **`Uncategorized` last-under-hairline and conditional (DS26)**, **per-band `Σ planned` subtotal rows (DS27)**
  - Surfaced by: DS9 — 0 Ledger Paper tokens against 35 shadcn defaults; A1; A6; X5; **DS26**; **DS27 — the headline was an assertion with no on-screen derivation**; prior learning `mm-design-system-documented-not-adopted` (10/10)
  - **Also carries DS44's structural a11y** (split out of T23): `<tbody>` per band and group, `<th scope="rowgroup">` headings, category link as `<th scope="row">`, `<caption class="sr-only">`, DS27's subtotals as `<tfoot>`/`scope="row"`, DS26's hairline `aria-hidden`. PR1b is the merge that restructures the table; it ships that structure readable
  - **Also carries DS43's mobile ledger list** — compact rows under the same band/group headings as desktop, replacing 46 stacked `EnvelopeCard`s; both renderers read `resolveRowDisplay`
  - Files: `src/app/budget/[year]/[month]/page.tsx`, `src/components/ledger/`
  - Verify: visual against variant-C **plus §15's correction list — the mockup predates DS26/DS27/DS39 and does not show subtotals**; no `bg-card`/`border-border`/`text-muted-foreground`/`rounded-md` remain; VoiceOver reads band → group → row without losing column meaning at the income boundary; at 375px the list is scannable without 46 card flaps
- [ ] **T13a (P2, human: ~15min / CC: ~3min)** — UI — `SummaryStrip` grid becomes `grid-cols-2 lg:grid-cols-5`; drop the `sm:grid-cols-3` step
  - Surfaced by: DS28 — at 3 columns the five cells break DS2's matched-pair reading and put `Received` beside `Planned spending`; 2 columns preserves the pairs, so the middle breakpoint was worse than the one below it
  - Files: `src/components/ledger/summary-strip.tsx`
  - Verify: pairs read correctly at 375px, 768px and 1280px
- [ ] **T13 (P1, human: ~3h / CC: ~30min)** — UI — extract `SummaryStrip` (`cells[]` contract), named tokens; **DS45: `variant="ledger" | "plain"` so the dashboard is not half-restyled**; **DS39: one ruled `--bg-raised` strip with `--rule-faint` dividers, not five bordered cards**; **DS42: all five `DESIGN.md` updates**
  - Surfaced by: DS10 — the `sm:grid-cols-4` grid orphans a cell at five; `DESIGN.md`'s own two-use threshold now exceeded; **DS39 — five bordered boxes under a headline is the dashboard-card mosaic App UI rules name, and this page uses no `--rule-*` token at all**; **DS42 — the plan named 2 `DESIGN.md` edits and invalidates 5**
  - **DS42 — the full `DESIGN.md` list:** `:144` (SummaryStrip — reverses "don't extract yet"), `:150` (`RemainingCell` → `resolveRowDisplay`), `:169-171` (EnvelopeCard fills — **already stale today**: the doc says `bg-amber-500`/`bg-destructive`, the code at `envelope-card.tsx:50-54` uses tokens; and DS40 changes the values again), `:191` (StateCard — reverses "inline them for now"), plus a **new motion section** (DS41). Prior learning `mm-design-system-documented-not-adopted` (10/10) is about exactly this drift
  - Files: `src/components/ledger/summary-strip.tsx`, `src/app/page.tsx`, `DESIGN.md`
  - Verify: dashboard and budget render identical figures from one component; no `border`/`rounded` on individual cells; `grep -n 'bg-amber-500\|bg-destructive' DESIGN.md` returns nothing
- [ ] **T14 (P1, human: ~2h / CC: ~20min)** — UI — `StateCard` shell (`∅`/`◐`/`!`/`✓`), used by every PR1b empty and error state; update `DESIGN.md:191`; **`loading.tsx` ships here too (DS34)**
  - Surfaced by: C5 — `DESIGN.md` says "inline them for now" and there has been exactly one for months; PR1b needs five more
  - Surfaced by (DS34): `src/app/sync/error.tsx` is the app's only `error.tsx` or `loading.tsx`; PR1b otherwise restyles the page and still flashes blank on the app's heaviest read
  - Files: `src/components/ledger/state-card.tsx`, `src/app/budget/[year]/[month]/loading.tsx`, `DESIGN.md`
  - Verify: all six specified states render through it; a throttled cold load shows `◐`, not a blank page
- [ ] **T15 (P1, human: ~2h / CC: ~25min)** — UI — amber remap and contrast fixes; **DS40's warn/over split**; **DS41's motion tokens + one global reduced-motion rule**
  - Surfaced by: DS8′/DS13 — raw `--accent-amber` on `--paper-1` is ≈2.4:1, under the 3:1 large-text floor, and collides with `BacklogBanner` directly above; **DS40 — amber carried five meanings and DS8′ would have made 80% and 120% render identically on the same bar**; **DS41 — §8 claimed one motion while §5.3 specified four, with two durations from nowhere and reduced-motion honored once**
  - Files: `src/components/ledger/left-to-budget.tsx`, `src/components/ledger/envelope-card.tsx`, `src/lib/budget/resolveRowDisplay.ts`, `src/app/globals.css`, `src/app/budget/[year]/[month]/page.tsx`, `DESIGN.md`
  - Verify: contrast check both themes; `> 0` before month start renders neutral, not amber; an 80% and a 120% envelope are visually distinguishable; reduced-motion disables all four motions from one rule
- [ ] **T16 (P1, human: ~3h / CC: ~30min)** — safety — F1 banner + `setCategoryKindAction` with X1's exception, returning state; **DS32's confirmation dialog (concrete transaction count + date range, named primary button, inline failure)**; `error.tsx`
  - Surfaced by: DS22 + **X1 — the CTA refuses exactly the categories it exists to fix**; A7 — the route has no error boundary and `sync/error.tsx` is the app's only one; **DS32 — an irreversible action (§10 O1) behind a one-clause "a confirmation", on a surface with no dialog vocabulary beyond `AllocateFormTrigger`**
  - Files: `src/app/budget/[year]/[month]/page.tsx`, `error.tsx`, `src/lib/budget/setCategoryKind.ts`, `src/app/budget/actions.ts`
  - Verify: TC23, TC23b; a validation failure renders inline in the dialog, not a page crash and not a toast; the dialog shows a real count and range, not a generic warning
- [ ] **T16b (P1, human: ~2h / CC: ~20min)** — UI — DS30's first-run `∅` StateCard **with DS36's backlog line and secondary `/categorize` action**; delete the unreachable `sections.length === 0` branch; retarget the `plannedIncome === 0` headline CTA at the Allocate dialog (DS31); **DS37's caption rewrite (reads `loadAccountBalances`)**
  - Surfaced by: **DS30 — after `0017`'s taxonomy seed the old empty branch can never fire, and the actual day-one screen (50 categories, zero allocations) had no state at all**; **DS31 — the headline CTA was specified as "focuses the first input", which does not exist until PR2a**; **DS36 — 498 uncategorized rows make every `Spent` figure low and the page never said so**; **DS37 — the caption argued against the rail total while the rail total was on screen**
  - Files: `src/app/budget/[year]/[month]/page.tsx`, `src/components/ledger/state-card.tsx`, `src/components/ledger/left-to-budget.tsx`
  - Verify: TC37; a fresh month renders the first-run card, its primary button opens a working dialog, and the backlog line shows the month-scoped count
- [ ] **T16c (P1, human: ~2h / CC: ~20min)** — UX — **`copyPreviousMonth` moved forward from T20 (DS31)**: `src/lib/budget/copyMonth.ts`, the action, the `∅` primary action and the `btn-outline` beside `MonthNav`, sonner result
  - Surfaced by: **DS31 — DS7's empty-month escape hatch was PR1b UI over PR2a machinery**; it has no dependency on `<MonthEditor>`, and without it PR1b costs 46 dialogs to fill a month, for the full real month X6 schedules before PR2b. **E7 — DS31 moved the function but not its schema dependency: §6.3's pipeline joins `categories.archived_at IS NULL` (DS12) and TC24 asserts the skip, against a column PR2a was scheduled to add. `archived_at` now ships in `0017`, so the join parses and TC24 runs here**
  - The archived filter matches nothing until PR2b's `archiveCategoryAction` exists. That is correct, not a stub — do not drop the join or hardcode `skippedArchived: 0`, or DS12's guarantee ("archive and copy silently undo each other without it") becomes a promise for a later merge to keep.
  - **Sequencing note:** this touches `src/app/budget/[year]/[month]/page.tsx`, which T12 rewrites wholesale. Run after T12 in the same worktree (see §12's Lane D/G conflict flag).
  - Files: `src/lib/budget/copyMonth.ts` + test, `src/app/budget/actions.ts`, `src/app/budget/[year]/[month]/`, `src/lib/budget.ts`
  - Verify: TC8, **TC24 (now runnable — E7)**, TC28
- [ ] **T17b (P2, human: ~20min / CC: ~5min)** — design system — add `--text-*: initial` to `@theme`, closing the type scale (DS46). **Run after T12**
  - Surfaced by: DS46 — `globals.css:77` claims the scale replaces Tailwind's defaults; `@theme` merges, so anything above `--text-3xl` silently falls back. Measured: **one** call site in `src/` (`page.tsx:115`), which T12 deletes
  - Files: `src/app/globals.css`
  - Verify: `grep -rE "text-(4xl|5xl|6xl|7xl|8xl|9xl)" src/` returns nothing; `pnpm build` clean
- [ ] **T17c (P2, human: ~3h / CC: ~30min)** — states — `error.tsx` + `loading.tsx` for every remaining route, through `StateCard` (DS47 + E10)
  - Surfaced by: DS47 / prior learning `mm-design-system-documented-not-adopted` (10/10) — every route but `/sync` and (after DS34) `/budget/[year]/[month]` shows Next's default error UI on a throw and a blank page on a slow query
  - **E10 — 17 files, not 19.** DS47's list included `/budget`, which is nine lines of `await connection()` + `redirect()` with no data fetch: a `loading.tsx` there flashes and redirects, an `error.tsx` catches nothing actionable. The glob was also short `/sync/loading.tsx` (that route has an `error.tsx` already), which is why DS47's prose correctly counted 10 missing loading files while the glob produced 9.
  - Files: `src/app/{,categorize/,goals/,import/,import/preview/[id]/,import/success/[batchId]/,subscriptions/,transactions/}{error,loading}.tsx` (16) + `src/app/sync/loading.tsx` (1) — **17 files across 9 routes**
  - Verify: every route renders `!` on a thrown error and `◐` on a throttled load; no route falls back to Next's default UI; `/budget` still redirects without a flash
- [ ] **T17d (P3, human: ~1h / CC: ~10min)** — design system — audit amber's four remaining meanings app-wide after DS40 (DS48)
  - Surfaced by: DS48 — DS40 resolved the one pair that rendered identically; amber still means backlog-exists (`BacklogBanner`), categorize-count (Spine chip), late-assigning (headline) and `stale` (PR2a cell). Distinguishable today, enforced by nothing
  - Files: audit `src/`; record findings in `DESIGN.md`'s color section
  - Verify: a written inventory of every `--accent-amber` use and what it means
- [ ] **T17 (P2, human: ~2h / CC: ~20min)** — `/goals` — DS11 replacement copy, income card, hide progress bar / percent / remaining-to-target
  - Surfaced by: §2 B2; DS11(ii) — a relabel alone leaves `progressPct` asserting a fact about money that may never have moved
  - Files: `src/app/goals/page.tsx`, `src/lib/goals/loadGoals.ts`, `src/components/ledger/`
  - Verify: subhead no longer claims progress; income over-plan renders positive

### PR2a — the entry ritual

- [ ] **T18 (P1, human: ~2 days / CC: ~1.5h)** — UX — `<MonthEditor>` client island; inline allocate; **action returns the reconciled row, revalidate once on exit (P2)**
  - Surfaced by: §6.1 — 40 page loads to budget 40 lines; P2 — 40 route recomputes per session fighting the optimistic state
  - Files: `src/app/budget/actions.ts`, `src/app/budget/[year]/[month]/`
  - Verify: TC15 manual; read the Next 16 Server Actions doc first
- [ ] **T19 (P1, human: ~1 day / CC: ~50min)** — UX — currency input, tab order, key semantics, **C3's upper bound**
  - Surfaced by: DS14 — the highest-frequency interaction was unspecified, Tab lands on "Allocate" every other press; C3 — `allocatedCents` has no maximum while `year` and `month` are both ranged
  - Files: `src/app/budget/[year]/[month]/`, `src/lib/budget/validateAllocateInput.ts`
  - Verify: TC16; tab through 10 rows hits only amount inputs
- [ ] ~~**T20**~~ — **moved to PR1b as T16c by DS31.** `copyPreviousMonth` never needed the client island, and DS7's empty-month CTA was PR1b UI standing on it. Fill-blanks-only, archived excluded (DS12) and `invalidateForwardRolloverMany` (D8A) all move with it.
- [ ] ~~**T21**~~ — **deleted by E7.** `archived_at` moved into `0017` (T1), because `DS31` had already moved `copyPreviousMonth` into PR1b while its `DS12` archived join and `TC24` still pointed at this migration. `sort_order` and the two-level ordering had already gone to T1/T7 by `DS29`, so nothing was left. **There is no migration `0018`, and PR2a ships no schema change** — §12's S9 lane and its `drizzle/` conflict flag are both retired.
- [ ] **T22 (P2, human: ~2h / CC: ~20min)** — mobile — inline amount input bound to editor state on DS43's ledger rows; sticky Left to Budget
  - Surfaced by: DS15 — the table is `hidden sm:block`, so the mobile ritual is 40 modal dialogs. **DS43 replaced the 46-card stack in T12, so this is now an input on an existing row rather than an `amountSlot` on `EnvelopeCard`**
  - Files: `src/app/budget/[year]/[month]/`, `src/components/ledger/`
  - Verify: allocate a category at 375px without opening a dialog
- [ ] **T23 (P2, human: ~2h / CC: ~20min)** — a11y — commit-only live region, per-input labels, 44px reorder targets (**row-group and table semantics moved to T12 by DS44**)
  - Surfaced by: DS16 — copying the `_allocate-form.tsx:124` live-region precedent to a header watching 40 fields announces on every keystroke. The structural half shipped with the structure in PR1b; what is left is interaction-bound and genuinely belongs with the editor
  - Files: `src/app/budget/[year]/[month]/`, `src/components/ledger/`
  - Verify: VoiceOver pass — typing does not announce per keystroke; every input has a name
- [ ] **T24 (P2, human: ~45min / CC: ~10min)** — hydration — island boundary per band (**`loading.tsx` moved to T14 in PR1b by DS34**)
  - Surfaced by: DS17 — inputs swallow keystrokes until hydration. The loading file was the smaller half and did not depend on the island; DS17's real argument is the boundary
  - Files: the editor island
  - Verify: keystrokes before hydration are not lost

### PR2b — category CRUD and archive (after one month of real use)

- [ ] **T25 (P2, human: ~5h / CC: ~40min)** — CRUD — create group / create leaf / rename / set carryover, all returning state
  - Surfaced by: §7.1 — no way to build your own budget structure without it
  - Files: `src/app/budget/`, `src/lib/budget/`, validators
  - Verify: TC25
- [ ] **T26 (P2, human: ~2h / CC: ~20min)** — CRUD — inline creation + `⋯` menu for structural actions (DS20, resolves O3)
  - Surfaced by: DS20 — a separate route breaks the flow state PR2a exists to create
  - Files: `src/app/budget/[year]/[month]/`, `src/lib/budget/`
  - Verify: create a line and fund it without leaving the page
- [ ] **T27 (P1, human: ~4h / CC: ~35min)** — archive — `archiveCategoryAction` **plus X3's two fixes**: the rule matcher skips archived categories, and `listLeafCategories` gains `includeArchived`
  - Surfaced by: §7.2; **X3 / B6 — archived categories keep receiving imported transactions; B7 — historical labels go blank**
  - Files: `src/lib/budget/`, `src/lib/rules.ts`, `src/lib/categories.ts`, `src/app/transactions/`
  - Verify: TC11, TC31b, TC31c
- [ ] **T28 (P2, human: ~1h / CC: ~15min)** — safety — the per-category "this looks like income" hint, non-dismissible `ⓘ` beside the Rollover chip (DS23)
  - Surfaced by: A8 — deferred here because `renameCategoryAction` is the only thing that can make F1's partial failure reachable, and it lands in this PR
  - Files: `src/lib/budget/loadMonthView.ts`, `src/app/budget/[year]/[month]/page.tsx`
  - Verify: an expense category with a net-positive month sets the hint; a net-negative one does not
- [ ] **T29 (P2, human: ~2h / CC: ~20min)** — reorder — `moveCategoryUpAction` / `moveCategoryDownAction` at both levels
  - Surfaced by: §6.4 — no drag-and-drop dependency
  - Files: `src/lib/budget/`, `src/app/budget/`
  - Verify: TC26; reorder announces the new position

---

## 14. Decisions

### Eng review round 1 (2026-09-04, `0e52e0af`)

| ID | Decision | Section |
|---|---|---|
| D1B | `kind` ships all three values in one migration; fund *behavior* deferred to PR3 | §4.1 |
| D3A | Fund allocations subtracted from Left to Budget | §4.3 |
| D4A | Month helpers consolidated into `monthOfIso.ts` | §4.2 |
| D5A | Share the transfer+date predicate; refund and pending semantics stay per call site | §4.2 |
| D6A | `groupIntoSections` generic with an injected comparator | §4.3 |
| D7A′ | Set-based `loadMonthView`; persist-on-upsert dropped | §4.3 |
| D8A | Batched `invalidateForwardRolloverMany` | §6.3 |
| D9A | Kind changes restricted to unused categories | §4.5 |
| D10A | All `is_savings_goal` reads repointed to `kind` | §4.5 |
| D14A | Two-layer F1 mitigation | §9 |

### Design review (2026-09-04) — renumbered `D1A`–`D24A` → `DS1`–`DS24` by A3

| ID | Decision |
|---|---|
| DS1 | One hero; the existing "Total Remaining" `Hero` is removed |
| DS2 | Five subordinate stat cells; EveryDollar planned-income model with the caption stating the limit |
| DS3 | Four money columns, not six; rollover rows show effective in Planned |
| DS4 / DS5 | Full interaction-state table; a failed cell blocks the success confirmation |
| DS6′ | Five Left to Budget states incl. the `plannedIncome === 0` guard; one 240ms success settle |
| DS7 | The empty month leads with "Copy September's budget" |
| DS8′ | One overspend signal per row; the bar goes amber over 100%, not red |
| DS9 | Restyle the whole budget surface, not one card on a default shell |
| DS10 | Named tokens; `SummaryStrip` extracted with a `cells[]` contract |
| DS11 | `/goals` gets replacement copy, not just deletions |
| DS12 | `sort_order = max+1`; groups ordered too; copy skips archived; income does not reuse `EnvelopeCard` |
| DS13 | Contrast, 13px + AA type floor (16px universal rejected), dark mode, iOS autozoom |
| DS14 | Currency input, tab order, key semantics |
| DS15 | Mobile editor via `amountSlot`; sticky Left to Budget |
| DS16 | Commit-only live region; row groups; 44px reorder targets |
| DS17 | Hydration boundary per band + `loading.tsx` |
| DS18 | Income stays a table section with the boundary marked |
| DS19 | Read-only FUNDS section (**amended by A6** — only when a fund exists) |
| DS20 | Category CRUD splits by frequency; inline creation + `⋯` menu. Resolves O3 |
| DS21 | Income variance neutral while the month is open |
| DS22 | F1's banner CTA must work (**depends on X1** to be true) |
| DS23 | The income hint is not dismissible |
| DS24 | The allocation action returns state instead of throwing; add `error.tsx` |

### Design review round 2 (2026-09-04) — this round

Re-run after eng review round 2 split PR1/PR2 into four merges and added A1, A6,
X1 and X5. Splitting a plan is a design change: a screen that is complete when
everything ships together can be half-built when only the first half ships. Score
re-rated 9/10 → 7/10 on the current text, not a reversal of round 1.

| ID | Decision | Where |
|---|---|---|
| DS25 | The complete 50 → 10 group mapping is written into `0017`; `Travel` and `Family` added; leaf-vs-group name collisions resolved by keeping the leaf inside the group | §4.1 |
| DS26 | `Uncategorized` renders last under a hairline, and only when it has month spend or backlog — A6's precedent applied to X5's row | §3, §4.3 |
| DS27 | Per-band `Σ planned` subtotal rows; the headline is derivable on screen instead of asserted | §3, §5.2 |
| DS28 | Stat row is `grid-cols-2 lg:grid-cols-5`; the `sm:grid-cols-3` step is dropped | §5.2 |
| DS29 | `sort_order` column, backfill and two-level `ORDER BY` move into PR1a; the reorder UI stays in PR2b | §4.1, §4.3, §6.4 |
| DS30 | A first-run `∅` state for the real day-one condition; the `sections.length === 0` branch DS25 made unreachable is deleted | §5.3 |
| DS31 | Every PR1b CTA must be backed by PR1b machinery. Three were not; `copyPreviousMonth` (T20) moves into PR1b and the zero-income CTA retargets at the Allocate dialog | §5.1, §5.3 |
| DS32 | X1's confirmation dialog is fully specified: concrete count and date range, named primary button, inline failure state | §5.5 |
| DS33 | Income rows disclose pending with the `+p` affordance expense rows already use; variance stays neutral when pending covers the gap | §4.4 |
| DS34 | `loading.tsx` moves into PR1b beside `error.tsx`; T24 keeps the hydration boundary | §5.3 |
| DS35 | `resolveRowDisplay` gains `monthHasEnded` (it could not express DS21); a closed month reads as record — `--money-neg` reserved for expense overspend | §4.4 |
| DS36 | The first-run card names the consequence of the backlog: `Spent` is incomplete, with a secondary link to `/categorize` | §5.3 |
| DS37 | The DS2 caption names the rail rather than arguing against it; `--money-pos` keeps both meanings, the copy disambiguates | §5.1 |
| DS38 | A journey storyboard (§5.0) — the artifact that catches sequencing defects across the four merges | §5.0 |
| DS39 | `SummaryStrip` is one ruled strip with hairline dividers, not five bordered cards | §5.2 |
| DS40 | Amber's five meanings resolved: `warn` proportional amber, `over` capped amber + a 2px redbrown overflow tick, so 80% and 120% differ | §4.4 |
| DS41 | Two motion durations, one easing and **one** global `prefers-reduced-motion` rule in `DESIGN.md`; §8's deferral rescoped to new motion | §5.1, §8 |
| DS42 | Five `DESIGN.md` updates, not two — `:169-171` is already stale against the code today | §5.2 |
| DS43 | Mobile budget becomes a compact ledger list; `EnvelopeCard` reserved for `/goals` and the dashboard, where it is rare enough to be signature | §6.5 |
| DS44 | DS16 splits — structural table semantics ship in PR1b with the structure; live region and reorder announcements stay in PR2a | §6.5 |
| DS45 | `SummaryStrip` takes `variant="ledger" \| "plain"`; the dashboard keeps its current appearance until its own restyle | §5.2 |
| DS46 | Close the type scale (`--text-*: initial`) — exactly one call site, and T12 already deletes it | §5.2 |
| DS47 | `error.tsx` + `loading.tsx` for every remaining route, through `StateCard` | §5.3 |
| DS48 | Audit amber's four remaining meanings app-wide after DS40 | §4.4 |

Also corrected in this round, as defects rather than decisions:

- **Migration numbering.** `origin/main` already carries `drizzle/0016_tired_thing.sql` (v0.12.4 / PR #34) and this branch is one commit behind it. Every `0016` became `0017`, every `0017` became `0018`.
- **`TC24a` was unsatisfiable.** A1's eight groups left `Hotels`, `Flights`, `Vacation`, `Childcare`, `School`, `ATM`, `Bank Fees` and `Misc` orphaned while the test asserted zero orphans. The migration and its own test disagreed.
- **§3's page-structure diagram drew the forbidden state.** It showed `$0.00 ✓ every dollar has a job` as the canonical PR1b screen; DS6′ and §5.1 forbid success when `plannedIncome === 0`, which is exactly the day-one condition. Labelled as a populated month, with the first-render screen pointed at §5.3.

### Eng review round 2 (2026-09-04)

| ID | Decision | Where |
|---|---|---|
| D1 | Split PR1 into PR1a (data + math) and PR1b (surface); nothing cut | header |
| A1 | Seed a group taxonomy in `0017`; top-level bands come from `kind`; `"Ungrouped"` never headers | §4.1, §4.3 |
| A2 | Repoint **all seven** `is_savings_goal` readers, not four | §4.5 |
| A3 | Renumber design decisions → `DS*`, tests → `TC*` | key table |
| A4 | Delete F6, invert `TC12`, remove §4.1's contradiction of §4.5 | §4.1, §9, §11 |
| A5 | Rewrite parallelization for the four-merge split | §12 |
| A6 | FUNDS renders only when a fund exists; drop the `+ $X to goals` sub-line | §3, §4.3 |
| A7 | `setCategoryKindAction` returns state **and** `error.tsx` ships in PR1b | §5.5 |
| A8 | The "looks like income" hint moves to PR2b, beside `renameCategoryAction` | §5.5, §7.1 |
| C1 | Pure, tested `resolveRowDisplay`; both layouts render it | §4.4 |
| C2 | Four stale JSDoc blocks named explicitly in T10 | §4.2 |
| C3 | Upper bound on `allocatedCents` ($1M per line per month) | §6.2 |
| C4 | One money parser: `parseAmountToCents` moves to `src/lib/money.ts` | §4.2 |
| C5 | Build the `StateCard` shell | §5.3 |
| TS1 | Keep `getEffectiveAllocation` as the single-row API; delete `persist`; cross-check via TC30 | §4.2 |
| TS2 | Pending excluded from `received`, included in `spent` | §3 |
| TS3 | Mandatory regression tests for `loadGoals` and `loadMonthlyTrends` (both untested today) | §11 |
| TS4 | Reconciliation invariant test (TC31) | §11 |
| TS5 | Query-count guard asserts invariance, not a constant; the count is six, not four | §4.3 |
| P1 | Rollover is a clamped prefix scan over a loaded range, not a prior-month lookup | §4.3 |
| P2 | The action returns the reconciled row; revalidate once on editor exit | §6.1 |
| P3 | Keep `effective_allocation_cents` but document the read branch as unreachable; drop in PR3 | §4.2 |
| X1 | Narrow exception: expense→income on a used, all-positive category | §4.5 |
| X2 | Automatic categorization never files a sign-mismatched row | §4.5 |
| X3 | Archive means no new writes AND still-resolvable reads | §7.2 |
| X4 | Month-scopable backlog for the budget page banner | §4.3 |
| X5 | `Uncategorized` is read-only and excluded from the planned side | §4.3 |
| X6 | Split PR2 into PR2a (entry ritual) and PR2b (CRUD + archive, after a real month) | §7 |

### Eng review round 3 (2026-09-04) — this round

Run after design round 2. Two themes. First, **the seam sweep `DS30`/`DS31`
introduced only ever ran forward** — design round 2 checked PR1b against PR2a and
never looked at PR1a↔PR1b, where the same defect was larger (`E1`) — and `DS31`
reproduced it on itself by moving a function without its schema dependency (`E7`).
Second, **three decisions were written in prose and never carried into the artifact
an implementer copies**: `DS29`'s column into the SQL block (`E2`), `DS31`/`DS34`'s
task moves into the lane map (`E10`), `DS25`'s taxonomy into the assertion it was
fixing (`E3`). Codex, run as the outside voice against the repo rather than the
plan text, independently found `E1`–`E4` and contributed `E6`.

| ID | Decision | Where |
|---|---|---|
| E1 | PR1a is not "no visual change" — 10 group headers, alphabetical order, income rows absent, `Uncategorized` gone, through un-updated JSX, on two pages. Claim replaced with the truth; `TC2b` pins it | §4 |
| E2 | `0017` creates `sort_order` before inserting into it, and backfills alphabetically **after** the `parent_id` UPDATEs; the partition is stated so it is not re-decided | §4.1 |
| E3 | `TC24a` restated in leaf terms — it was unsatisfiable a second time, failing by 10 against the group parents `DS25` created | §11 |
| E4 | `P1`'s prefix scan terminates at a gap month, matching `getEffectiveAllocation`; `TC30` gains the skip-month fixture its oracle set never had; the product question becomes `O5` | §4.3, §10 |
| E5 | `loadUncategorizedBacklog` extracts to its own module, which is what makes `X4`'s scope expressible and stops two routes running the app's heaviest read for one `COUNT(*)` | §4.3 |
| E6 | `TC22b` pins the `is_savings_goal`/`kind` drift in the **inverse** direction — the one with a live writer (`goals/actions.ts:19`) | §11, §9 F11 |
| E7 | `archived_at` moves into `0017`; migration `0018` and `T21` are deleted; PR2a ships no schema change | §4.1, §6.4 |
| E8 | `X2`'s sign guard moves **inside** `buildRuleMatcher`, onto the same `categories` join `X3` adds in PR2b; `TC32` relocates to `rules.test.ts`, where it can run | §4.5, §7.2 |
| E9 | `C2` is five stale JSDoc blocks, not four — `loadMonthView.ts:63-66` documents the `"Ungrouped"` section `A1` deletes | §4.2 |
| E10 | §12's lane map rewritten against §13 (it still scheduled `copyPreviousMonth` into PR2a); `DS47` corrected to 17 files across 9 routes | §12, §5.3 |
| E11 | `C1`'s tone inventory is five copies across two color systems; `resolveRowDisplay` returns `barTone` as a token and `TC40` pins cross-layout identity (`F8`) | §4.4 |
| E12 | `monthPhase()` in `monthOfIso.ts` replaces `resolveRowDisplay`'s producerless boolean pair with three states; `TC41` pins the local-time boundary | §4.4 |
| E13 | The six-query list held two derivable queries; it is four, plus two for rollover. `TC29` still asserts invariance, never the number | §4.3 |
| E14 | `O5` (gap-month fund reset) tracked in `TODOS.md` beside `O2`, explicitly distinct from the `B3` clamp entry | §10 |
| E15 | `DS45`'s `variant="plain"` deletion recorded against the dashboard-restyle trigger in `TODOS.md` | §5.2 |

---

## 15. Approved mockups

| Screen | Mockup | Direction | Notes |
|---|---|---|---|
| `/budget/[year]/[month]` | `~/.gstack/projects/thehashrocket-my_money_manager/designs/budget-month-zero-based-20260904/variant-C.png` | Flat warm paper. Dashed binding-stitch rail per `DESIGN.md`'s Spine spec, one dominant Left to Budget headline with caption, calm subordinate stat row, ruled-paper tables with per-row progress bars and an explicit Allocate affordance | Corrections the mockup gets wrong: negatives use **parentheses** via `formatCents`, not minus signs; the Allocate affordance appears consistently, not on arbitrary rows; ignore the invented nav items (Reports, Calendar, Payees) and the **Credit Card** account row (not in V1). The mockup predates DS19 (no FUNDS section) and A1 (it shows groups, which only exist after `0017`'s taxonomy seed — that is now what makes it renderable). It also predates design review round 2: it shows **no band subtotal rows** (DS27), does not place `Uncategorized` last under a hairline (DS26), and its stat row is not the DS28 grid. Treat variant-C as the art direction, not the layout of record; §3's page-structure block is the layout of record |

Variants A and B, plus the comparison board, are in the same directory. All three
passed the GPT-4o vision gate; C was approved 2026-09-04.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 5 | ISSUES_FOUND | plan pass: 8 findings, 8 folded; design pass: 6 + 2 hard rejections, 5 folded; round-2 eng: 7 findings, 7 folded; design round-2: 6 + 2 hard rejections, 5 folded, 1 declined; round-3 eng: 5 findings, 5 folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 3 | CLEAR (PLAN) | round 1: 14 issues, 0 critical gaps; round 2: 30 issues, 0 critical gaps; round 3: 15 issues, 2 critical gaps found and closed |
| Design Review | `/plan-design-review` | UI/UX gaps | 2 | CLEAR (FULL) | round 1: score 4/10 → 9/10, 24 decisions; round 2: score 7/10 → 9/10, 24 decisions (`DS25`–`DS48`) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** Five passes. The round-3 pass was pointed at the repository rather than the
plan text and independently reproduced four of this review's five architecture findings
with the same `file:line` evidence — `E1` (PR1a is not "no visual change"), `E2` (the
`0017` SQL does not run as written), `E3` (`TC24a` fails by 10), `E4` (`P1` does not
preserve gap-month semantics). It contributed one this review had not reached: `E6`,
`createGoalAction` writing `is_savings_goal` without `kind`. It also caught a detail this
review missed on `E1` — `src/app/page.tsx:64` renders the dashboard from the same
`MonthViewSummary`, so PR1a's blast radius is two pages, not one. **One correction went
the other way:** this review claimed `TC30`'s oracle set would catch a naive prefix scan;
Codex was right that it would not. `budget.test.ts:311` is a chain-*start* case, not a
mid-chain gap, so `E4` moved from "contained by the test net" to a live untested behavior
change and `TC30` gained the skip-month fixture.

**CROSS-MODEL:** Seven tensions across five rounds. The six from earlier rounds stand as
recorded. The seventh was resolved *against this review*, not against Codex — see the
`TC30` correction above. `E6` was accepted but reframed: Codex argued it as a
migrate-before-deploy window, which is weak for this app (under Docker the entrypoint
migrates and starts from one image; on `pnpm dev` the code lands before the migration and
fails loudly). The durable version is drift symmetry — `TC22` tests one direction and the
untested direction is the one with a live writer — so the fix is `TC22b` pinning the
invariant rather than a note about deploy ordering.

Round 3's own theme, and the reason it found what two prior rounds did not: **the seam
sweep `DS30`/`DS31` introduced only ever ran forward.** Design round 2 checked PR1b
against PR2a and never looked back at PR1a↔PR1b, where the same defect was larger — and
`DS31` reproduced it on itself, moving `copyPreviousMonth` into PR1b without the
`archived_at` column its `DS12` join needs (`E7`). The second theme is cheaper and
recurs: **three decisions were written in prose and never carried into the artifact an
implementer copies** — `DS29`'s column into the SQL block (`E2`), `DS31`/`DS34`'s task
moves into the lane map (`E10`), `DS25`'s taxonomy into the assertion it was fixing
(`E3`). Reading the migration SQL against the live schema, and the test text against the
migration, is what surfaced all three.

**VERDICT:** ENG + DESIGN CLEARED — ready to implement. CEO review not run; it does not
gate shipping and this plan's scope was settled explicitly across three rounds
(`0e52e0af`, then `D1`/`X6`, unchanged by round 3).

**UNRESOLVED DECISIONS:**
- **O4 — PR2a's four allocation-cell states (`saving`/`saved`/`failed`/`stale`) are specified as border colors only.** Deliberately deferred (design round 2, D6.1) to a short design pass at the top of PR2a rather than specified on paper two merges early. DS4 removed toasts, so the border is the entire feedback channel for the app's highest-frequency interaction; if that pass is skipped, the implementer improvises four border treatments. Carried forward from design review round 2; round 3 did not reopen it.
