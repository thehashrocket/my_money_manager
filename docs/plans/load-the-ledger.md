# Plan — Load the ledger and start budgeting

Locked via `/plan-eng-review` 2026-09-02. Supersedes nothing; this is the work that
`PLAN.md`'s "integration checkpoint" has been waiting on since Weekend 2.

## Why

Five weekends of features shipped, plus SimpleFIN sync and a Docker image. The
ledger has never been budgeted with. Measured against the real database at
`/Users/jasonshultz/Projects/my_money_manager/data/money.db`:

```
transactions ........... 1178      date range .... 2025-09-26 → 2026-04-20
uncategorized .......... 498       (excl. transfer-paired; 295 merchants, 248 singletons)
budget_periods ......... 0         ← envelope budgeting has never run
applied migrations ..... 5 of 10   ← SimpleFIN sync has never touched real data
starting_balance_cents . 0, 0      ← displayed balances are net-change, not balances
```

135 days of transactions are missing. This plan closes that gap, wires the two
things that stop it reopening, and ends with allocations set for the current month.

## The gap, and what can still reach it

```
2025-09-26 ─────────── 2026-04-20 │·············· 135-day gap ··············│ 2026-09-02
   1178 rows (CSV import)         │                                          │  today
                                  │                                          │
   ├──────────────────────────────┼─────────────────┼────────────────────────┤
                            2026-06-04        2026-07-19
                     SimpleFIN 90-day cap   MAX_LOOKBACK_DAYS = 45
                     (hard, provider-side)  (ours, sync.ts:30)

   CSV export covers the WHOLE gap: Star One takes an arbitrary date range
   (prior batches: statement_starone_1_01_01_2025_to_04_20_2026.csv).
   → MAX_LOOKBACK_DAYS stays at 45. Widening it was considered and cut.
```

## Two defects that gate the work

Both were found during review and verified, not assumed.

### 1. Auto-categorization was never wired up (`applyRuleAtImport`)

```
  category_rules (73 trained, all exact-match)
        │
        │   ┌────────────────────────────────────────────┐
        └──▶│ applyRuleAtImport()      src/lib/rules.ts:30│
            │ tested by 14 assertions in rules.test.ts    │
            │ documented in CHANGELOG.md:292 as shipped   │
            └────────────────────────────────────────────┘
                          │
                          ✗  ZERO production callers
                          │
   commitImport()  ───────┴──── syncSimpleFin()
   importBatch.ts:167           sync.ts:363
   inserts with no categoryId   inserts with no categoryId
                    │                   │
                    ▼                   ▼
              every imported row lands NULL, forever
```

Consequence: the backlog grows monotonically with use and never shrinks from
automation. This is why 498 rows accumulated. Measured: 56 rows across 7
merchants in today's backlog would already be auto-categorized by the existing
rules. Forward, it applies to every row of every future import.

### 2. CSV dedup is position-dependent

`import_row_hash = sha1(date | amount_cents | raw_description | raw_memo | row_index)`
(`src/lib/hash.ts:13`). The row index is deliberate, per CLAUDE.md rule 3, so two
genuinely identical same-day coffees both survive. Its second-order consequence
was never tested. Proven empirically during review:

```
Re-import the IDENTICAL file  →  parsed 10, new  0, dupes 10   ✓ dedup works
Import a WIDER export of the  →  parsed 10, new 10, dupes  0   ✗ dedup blind
  same rows at new offsets        DB: 15 rows for 10 distinct txns
                                  Preview told the user "0 duplicates"
```

The SimpleFIN path already solved exactly this with `contentSignature` plus a
multiset budget map (`mapTransaction.ts`, used at `sync.ts:262-300`). That
solution was never applied back to the CSV path.

## Sequence

Order matters. Steps 1-3 are code and land before any real data moves.

```
  ┌─ code, on a branch, tests green ──────────────────────────────┐
  │  1. T2  content-overlap dedup in buildPreview                 │
  │  2. T1  wire applyRuleAtImport at both insert sites           │
  │  3. T3  persist row balance + derive the starting anchor      │
  │  4. T5  widen REVIEW_WINDOW_DAYS  |  T6 fix the doc drift     │
  └───────────────────────────────────┬───────────────────────────┘
                                      │  merge to main
  ┌─ operational, IN THE MAIN CHECKOUT ▼ /Users/jasonshultz/Projects/my_money_manager
  │  5. pnpm db:migrate         (snapshots first; dry-run already verified clean)
  │  6. CSV-import 2026-04-21 → 2026-09-02, per account
  │     → arrives pre-categorized for every trained merchant (step 2)
  │     → overlapping rows caught even on a wider export (step 1)
  │     → starting balances resolve (step 3)
  │  7. /sync: link both accounts, sync forward
  │  8. /sync: resolve the transfer-review queue (now reaches the backfill, step 4)
  │  9. /categorize the remaining backlog, /budget set allocations
  │ 10. Use it for a week. That closes the Weekend 2 integration checkpoint.
  └────────────────────────────────────────────────────────────────
```

**Step 5 runs in the main checkout, not a worktree.** `scripts/db-paths.mjs`
hardcodes cwd-relative `./data/money.db` and does not read `DATA_DIR` (unlike
`src/lib/paths.ts:9`). Running `pnpm db:migrate` from a Conductor worktree
migrates that worktree's empty database while appearing to succeed.

**Migration risk is retired.** `scripts/migrate.mjs` was dry-run during this
review against a `VACUUM INTO` copy of the real ledger: migrations applied,
1178 rows / 408 categorized / 73 rules / 272 transfer pairs preserved,
`foreign_key_check` clean. The `0010` table rebuild survived a database with
real FK-referencing rows, which is the shape CLAUDE.md rule 7 exists for and
which had never been exercised outside tests.

## Implementation Tasks

- [x] **T1 (P1, human: ~2h / CC: ~20min)** — rules — Wire `applyRuleAtImport` into both insert sites
  - Surfaced by: Architecture A1 — zero production callers; found by Codex, confirmed repo-wide
  - Files: `src/lib/importBatch.ts`, `src/lib/simplefin/sync.ts`
  - Tests: rule-matched row gets `categoryId` at commit; unmatched stays NULL; same for the sync path; a `contains`/`regex` rule resolves through the same path
  - Verify: `pnpm test`, then confirm 56 rows across 7 merchants auto-resolve on the real copy
- [x] **T2 (P1, human: ~3h / CC: ~25min)** — import — Content-overlap dedup in `buildPreview`
  - Surfaced by: Architecture A2 — proven double-count on a wider re-export
  - Files: `src/lib/importBatch.ts`; move `contentSignature` out of `src/lib/simplefin/mapTransaction.ts` to a shared `src/lib/contentSignature.ts` so the CSV path does not import from `simplefin/` (wrong dependency direction)
  - Tests: the shifted-export case (wider export of already-imported rows reports them as duplicates); identical-file re-import still dedups; two genuinely identical same-day rows still both survive (rule 3 must not regress)
  - Verify: `pnpm test`
- [x] **T3 (P2, human: ~3h / CC: ~30min)** — accounts — Persist row balance, derive the starting anchor
  - Surfaced by: Architecture A3 + Codex point 6 — `parseCsv.ts:151` parses Star One's running balance and discards it
  - Files: `src/db/schema.ts` + additive migration (new nullable column, no table rebuild), `src/lib/importBatch.ts`, `src/lib/accounts/loadAccountBalances.ts`
  - Tests: anchor derived from the earliest imported row equals `balance − amount`; drift reads 0 against a matching feed balance
  - Verify: `pnpm test`; after step 6, `/sync` drift shows 0
- [x] **T5 (P3, human: ~15min / CC: ~5min)** — sync — Widen `REVIEW_WINDOW_DAYS` to cover the backfill
  - Surfaced by: Performance P2 / Codex point 5 — 120 days back is 2026-05-05; rows dated 2026-04-21..05-04 are unreachable
  - Files: `src/app/sync/page.tsx:35`
  - Note: keep it independent of `MAX_LOOKBACK_DAYS`; the existing comment says so explicitly
  - Verify: after step 6, ambiguous buckets from late April appear in the review list
- [x] **T6 (P3, human: ~15min / CC: ~5min)** — docs — Correct the auto-categorize claim
  - Surfaced by: Code Quality Q1 — `CHANGELOG.md:292` documents behavior that does not exist; `TODOS.md:38` marks it `[x]`
  - Files: `CHANGELOG.md`, `TODOS.md`
  - Verify: read-through
- [ ] **T7 (P2, human: ~30min / CC: ~10min)** — categorize — Measure `/categorize` at 295 merchant groups
  - Surfaced by: Performance P1 — `loadMerchantGroups.ts:33` has no LIMIT; its doc comment assumes 30-60 groups
  - Files: none yet; measurement against the migrated copy
  - Verify: if interaction is acceptable, close it and correct the doc comment's stated assumption; if not, open a pagination task

**Status 2026-09-02:** T1, T2, T3, T5 and T6 are implemented on
`thehashrocket/next-todo-priority` (5 commits, 518 tests green). T7 is a
measurement against the migrated real ledger and belongs with the operational
sequence, not before it. Steps 5-10 have not run.

## NOT in scope

| Deferred | Why |
|---|---|
| PR2 Postgres, PR3 NAS/phone | Decided at D1. Neither is evaluable until the app is proven on real data. |
| P1 SimpleFIN cross-account relink double-count | Cannot fire until step 7 links the accounts. Do it immediately after, not before. |
| Raising `MAX_LOOKBACK_DAYS` 45→90 | Cut. Star One's CSV export covers the whole gap, so the smaller sync window is strictly better. |
| Month-scoped `/categorize` filter + month-scoped backlog count | Real gap (Codex points 3-4) but a new feature, not a fix. TODO. |
| `/categorize` pagination | Gated on T7's measurement. |
| All P3/P4 Docker script test and DRY nits | Unchanged from `TODOS.md`; none block this. |
| Branded `Cents` type, shared batch-writer | Unchanged. The batch-writer becomes cheaper to bundle once T1 touches both insert sites, but it is not required. |

## What already exists

| Need | Existing code | Reused or rebuilt? |
|---|---|---|
| Backfill the 135-day gap | `/import` CSV pipeline, fully tested | Reused as-is |
| Cross-source overlap dedup | `contentSignature` + multiset budget, `sync.ts:262-300` | Reused (T2 moves it to a shared module) |
| Rule resolution at import | `applyRuleAtImport`, 14 assertions | Reused; only the wiring is new (T1) |
| Starting balance data | `parseCsv.ts:151` already parses it | Reused; only persistence is new (T3) |
| Safe schema change on real data | `scripts/migrate.mjs` | Reused, field-verified during this review |
| Bulk categorize head of distribution | `/categorize` | Reused |
| Row-by-row tail | `/transactions` inline picker | Reused |

## Failure modes

| # | Codepath | Realistic failure | Test? | Handled? | User sees |
|---|---|---|---|---|---|
| 1 | `buildPreview` dedup | Wider re-export double-counts | T2 adds it | After T2 | Rows flagged duplicate in preview |
| 2 | `commitImport` + rules | A bad `contains` rule mass-mislabels the backfill | T1 adds it | Partly | Wrong categories, correctable in bulk; **no undo on import-time categorization** — see risk below |
| 3 | `pnpm db:migrate` | Rebuild fails on FK rows | `migration0010.test.ts` + today's dry run | Yes | Non-zero exit, pre-migrate snapshot intact |
| 4 | Step 7 link | Mislink, then relink → silent cross-account double-count | `sync.test.ts:737` pins it | **No** | Nothing. Known open P1. |
| 5 | Transfer review | Backfilled April pairs unreachable | No | After T5 | Rows counted as spending, invisibly |

**Critical gap: #4.** No test, no handling, silent. It is the open P1 in `TODOS.md`
and step 7 is exactly when it becomes reachable. Mitigation for this plan: link
each account once, carefully, and verify the mapping before syncing. Fix it
immediately after this plan lands.

**Risk on #2:** `bulkCategorize` has a full undo path; import-time categorization
does not. A rule that matches too broadly labels the whole backfill with no
one-click reversal. The rule set is 73 exact-match rules today (zero `contains`,
zero `regex`), so the blast radius is currently nil, but it grows the moment a
`contains` rule is trained. Worth a follow-up TODO rather than blocking T1.

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| T2 | `src/lib/` (importBatch, new contentSignature module) | — |
| T1 | `src/lib/` (importBatch, simplefin) | T2 (same file) |
| T3 | `src/lib/`, `src/db/`, `drizzle/` | T1 (same file) |
| T5 | `src/app/sync/` | — |
| T6 | docs | — |
| T7 | none (measurement) | — |

```
Lane A: T2 → T1 → T3     (sequential, all touch src/lib/importBatch.ts)
Lane B: T5               (independent, src/app/sync/)
Lane C: T6               (independent, docs)
Lane D: T7               (independent, read-only measurement)

Launch A, B, C, D in parallel. Merge all. Then run the operational sequence.
```

Conflict flags: none. T1 touches `src/lib/simplefin/sync.ts` while T5 touches
`src/app/sync/page.tsx` — different files, no overlap.

## GSTACK REVIEW REPORT

| Runs | Status | Findings |
|---|---|---|
| Step 0 — Scope Challenge | complete | Ground truth measured from the real ledger; 1 scope cut (`MAX_LOOKBACK_DAYS` 45→90) |
| 1. Architecture | complete | 4 (A1 P1, A2 P1, A3 P2, A4 P2) |
| 2. Code Quality | complete | 2 (Q1 P3, Q2 P4) |
| 3. Tests | complete | coverage diagram produced, 5 gaps, 4 critical |
| 4. Performance | complete | 2 (P1 P2, P2 P3) |
| Outside voice | codex, `ready` | 6 findings, all verified before acceptance; 3 net-new |
| Cross-model tension | none | Codex extended the review; superseded the review on the balance-anchor method |

VERDICT: PROCEED. CODEX ABSORBED — points 1, 2, 5 promoted to A4, A1, P2; point 6
replaced the review's own step 6; points 3 and 4 corrected the review's effort
estimate and are captured as deferred scope.

Decisions D1-D6: all resolved, all chose the complete option (6/6).
Critical gap carried forward: failure mode #4 (cross-account relink double-count),
no test, no handling, silent — the open P1 in TODOS.md, reachable from step 7.

NO UNRESOLVED DECISIONS
