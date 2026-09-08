# /categorize → /transactions merchant drilldown

**Status:** IMPLEMENTED (2026-09-07) — T1-T16 all landed. Reviewed via
`/plan-eng-review` + `/plan-design-review` before implementation.
**Branch:** `thehashrocket/categorize-name-to-transactions`
**Ask:** on `/categorize`, clicking the name on a row lands on `/transactions`
showing just that name's transactions.

---

## Problem

`/categorize` shows one row per uncategorized `normalized_merchant` group
(`loadMerchantGroups.ts`). Each row gives you a key, a row count, and a dollar total —
then asks you to pick a category. There is no way to see WHAT the rows are. `AMAZON` at
53 rows and −$2,411 could be groceries, gifts, or a laptop. Today the only recourse is
opening `/transactions` in another tab and retyping the merchant by hand.

Measured on the live ledger (`my_money_manager-app-1`, 1,540 rows): **181 uncategorized
groups, 363 distinct merchants.**

## Decisions

| # | Decision | Chosen | Why |
|---|---|---|---|
| D2 | Filter mechanism | **Exact `merchant=` param** | `search=` is `LIKE %x%`; on 11 of 181 groups it returns a superset (`AMAZON` 59 → 71 rows — 59 being what the exact filter returns for the key, not its 53-row uncategorized subset). Also index-backed. |
| D3 | Which rows | **All rows for the merchant** | Prior filing history is the decision support: `COSTCO GAS` shows 1 uncategorized but 50 total, 49 already filed as `Gas`. |
| D4 | What is clickable | **Merchant name only** | On all 181 rows; the category badge renders on 6. |
| D5 | Carry-forward guard | **Keys-driven round-trip test** | Silent-drop bug documented 3× in `_filter-bar.tsx`; existing test hand-enumerates fields so it can't catch field #10. |
| D6 | Href builder location | **Beside `transactionsDrilldownHref`** | 3 builders → 2, without dragging a serializer move into a feature PR. |
| D7 | Flow coverage | **Manual QA checklist**, no Playwright | CLAUDE.md rules UI/E2E tests out of V1. |
| D8 | Link prefetch | **`prefetch={false}`** | 181 links auto-prefetch a shell `loading.tsx` already provides on a dynamic route. |
| D9 | Row detail *(codex)* | **Show `rawMemo` on `/transactions` rows** | Rows render `normalizedMerchant` with the bank text in a hover-only `title=`; the destination showed 59 identical labels. |
| D10 | Merchant control *(codex)* | **Dismissible chip in `FilterSummary`** | A hidden-only filter can't be cleared without wiping all nine. |
| D11 | Schema testability *(codex)* | **Extract to `src/lib/transactions/searchParams.ts`** | `searchParamsSchema`/`flatten` are module-private; the planned tests were unwritable. |
| D12 | `merchant` length bound *(codex)* | **No bound** | Column is unbounded `text`; a 200-cap invents a 404 for a link the app itself emits. |
| D13 | Merchant link on `/transactions` rows | **Build now** | ~2 lines in a component D9 already opens. |
| D14 | Collapse all URL builders | **Defer to TODOS.md** | Pure refactor, no user-visible payoff; D5's test already covers the failure mode. |
| D15 | Rule 10 doc | **Update now** | `?merchant=` becomes a third consumer of `normalized_merchant`; rule 10 says "two tables". |

## Shape of the change

```
/categorize row                          /transactions
┌──────────────────────────────┐         ┌────────────────────────────────────┐
│ AMAZON            53 rows    │ click   │ AMAZON ⊗ — 59 rows          ← D10  │
│  └─ <Link prefetch={false}>──┼────────►│ 04/12 AMAZON        [Gifts]  ← D3  │
│                              │         │       AMAZON MKTPL*8Y21  −$41.02   │
│ [category ▾] □Remember [Sub] │         │ 04/09 AMAZON        [—]      ← D9  │
└──────────────────────────────┘         │       AMZN Mktp US*RT4T9  −$12.80  │
   count = uncategorized only (53)       └────────────────────────────────────┘
                                            count = all rows (59) — D3
```

## Data flow

```
_merchant-row.tsx
  group.normalizedMerchant                     e.g. "GASCO#00000ANYTWN"
        │
        ▼
  merchantDrilldownHref(merchant)              ← new; beside transactionsDrilldownHref (D6)
        │  new URLSearchParams({merchant})
        │  NEVER a template literal — 17 of 363 real keys carry # * ? / ;
        │  a bare `#` truncates the query and silently filters on "GASCO"
        ▼
  /transactions?merchant=GASCO%2300000ANYTWN
        │
        ▼
  lib/transactions/searchParams.ts  .strict()  ← [1] add `merchant` or every link 404s
        │                                          (extracted here by D11)
        ▼
  filterValues { …, merchant }                 ← [2] add or FilterSummary omits the chip
        │
        ▼
  _filter-bar.tsx
    TransactionsFilterValues                   ← [3] add to the type
    filterValuesToSearchParams                 ← [4] add or PAGE 2 SILENTLY DROPS IT
    FilterBar hidden field                     ← [5] add or "Apply filters" drops it
        │
        ▼
  loadTransactions({ merchant })
        │
        ▼
  eq(transactions.normalized_merchant, m)      ← uses transactions_merchant_idx
                                                  (schema.ts:300)
```

**Sites [1]–[5] are the whole risk of this change.** Missing [1] fails loudly (404).
Missing [4] fails silently — the filter works on page 1 and vanishes on page 2, leaving
you looking at all 1,540 rows in a page that still reads as filtered. That class has
already happened twice (`pageSize`, `includeTransfers`); see the comments at
the `merchant` and `pageSize` field comments on `TransactionsFilterValues`,
and the hidden-input block, all in `_filter-bar.tsx` (named rather than
numbered — the same PR rewrote that file and the line numbers moved). D5's keys-driven test exists to end it, and D11
lets that test close both halves — a key must be both serialized *and* accepted.

`merchant` carries no length bound (D12): the column is unbounded `text`, the value goes
into a parameterized `eq()` with no injection surface, and oversized URLs are rejected at
the HTTP layer. Longest real key today is 69 chars. `""` normalizes to `undefined` via
`flatten()`.

## Files to touch

| File | Change | From |
|---|---|---|
| `src/lib/transactions/searchParams.ts` *(new)* | `searchParamsSchema` + `flatten`, extracted | D11 |
| `src/lib/transactions/searchParams.test.ts` *(new)* | schema accept/reject cases | D11 |
| `src/lib/categorize/loadTransactions.ts` | `merchant?: string`; `eq()` predicate | D2 |
| `src/lib/categorize/loadTransactions.test.ts` | exact-match + composition cases | D2 |
| `src/lib/budget/transactionsDrilldownHref.ts` | add `merchantDrilldownHref` | D6 |
| `src/lib/budget/transactionsDrilldownHref.test.ts` | URL-hostile key cases | test review |
| `src/app/transactions/page.tsx` | import schema; `filterValues`; merchant chip | D10, D11 |
| `src/app/transactions/_filter-bar.tsx` | type + serializer + hidden field | D5 |
| `src/app/transactions/_filter-bar.test.ts` | keys-driven round-trip test | D5 |
| `src/app/transactions/_transaction-row.tsx` | `rawMemo` line + merchant link | D9, D13 |
| `src/app/categorize/_merchant-row.tsx` | `<Link prefetch={false}>` on merchant name | D4, D8 |
| `CLAUDE.md` | rule 10: name `?merchant=` as a third consumer | D15 |

**12 files** — 4 tests, 1 doc, 2 a mechanical extraction. Started at 5; the growth is
recorded honestly and every addition traces to a numbered finding. No new services, no
new tables, no migration, no new dependency.

### What actually shipped (2026-09-07)

The table above is the eng review's scope. The design review's ten extra tasks
(T6-T15) added these, all UI or its read model — still no new services, tables,
migrations or dependencies:

| File | Change | From |
|---|---|---|
| `src/app/categorize/_pending-pick.ts` *(new)* | `sessionStorage` store for the pending pick, read via `useSyncExternalStore` | T11/D19 |
| `src/app/categorize/_categorize-ui.tsx` | ruled list + column headers, amber onto tokens, progress counter, `StateCard` empty state, dismissal lifted out of the row | T6, T10, T14, T15 |
| `src/app/categorize/_merchant-row.tsx` | `<details>` disclosure, grid row, full-strength rule-backed rows, focus rings | T6, T7, T12, T22 |
| `src/app/categorize/page.tsx` | discoverability hint naming the disclosure | T15 |
| `src/app/transactions/_transactions-ui.tsx` | ruled list, merchant-aware `StateCard` empty state, amber onto tokens, 44px pagination targets | T6, T10, T12, T14 |
| `src/lib/categorize/loadMerchantGroups.ts` | `sampleMemos` + `totalRowCount` per group | T7 |
| `src/lib/categorize/loadMerchantGroups.test.ts` | sample suppression + total-count cases | T7 |
| `src/lib/categorize/loadTransactions.ts` | `summarizeByCategory` (`GROUP BY category_id`), predicates extracted and shared | T9 |
| `TODOS.md` | three deferrals recorded (Cache Components, `import/preview` amber, the other eight filter chips) | D19, D21, D18 |

Two implementation notes worth carrying forward, neither of which changes a decision:

- **D19 is implemented as `useSyncExternalStore`, not `useState` + a restore
  effect.** `sessionStorage` IS the field's state; there is no second copy.
  Restoring into React state from an effect is a cascading render that
  `react-hooks/set-state-in-effect` refuses outright, and reading storage during
  render would desynchronize the server HTML from the first client render.
- **T15's denominator is `remaining + done`, never `initialGroups.length`.**
  Both categorize actions call `revalidatePath("/categorize")`, so the server
  list drops a merchant the moment it is filed — measured reading "1 of 5" one
  submit after it read "0 of 6", as though the work had grown.

## Test plan

```
CODE PATHS                                                USER FLOWS
[+] merchantDrilldownHref()                               [+] Categorize → inspect
  ├── plain key "AMAZON"                                    ├── Click AMAZON → 59 rows
  ├── URL-hostile keys ★★★  (17 real: GASCO#00000ANYTWN,      ├── [MANUAL] Click → page 2 →
  │   CORNER STORE #, ST DMV 000 *SVC, UTIL CO/EZ-PAY,        │      filter SURVIVES ⚠ D5 class
  │   VENDOR.COM/BILL, NORA?S BBQ JOI ANYTWN)            ├── [MANUAL] Apply filters →
  └── empty-string key → refuse, never emit "?merchant="    │      merchant survives
                                                            ├── [MANUAL] chip ⊗ → merchant
[+] loadTransactions({merchant})                            │      drops, date range stays
  ├── exact match, NOT prefix ★★★                          └── [MANUAL] Clear filters →
  │     AMAZON ⇏ AMAZON PRIME                                      everything drops
  │     (pins D2; the assertion that stops a revert)
  ├── composes with categoryId / dateFrom / accountId      [+] Empty / boundary
  ├── undefined → no predicate                               ├── ?merchant=amazon (lowercase)
  └── totalCount uses the same predicate as rows             │      → 0 rows, legible empty state
                                                             ├── ?merchant= → no filter
[+] searchParams.ts (D11 makes these reachable)              ├── ?merchantt=X → 404 (.strict())
  ├── merchant present → parsed                              └── stale key post-backfill
  ├── merchant="" → flatten() → undefined                    │      → 0 rows (accepted, D15)
  └── unknown key → reject (.strict() preserved)

[+] Regression guard
  └── every TransactionsFilterValues key round-trips ★★★  — serialize, then feed
      back through searchParamsSchema (both halves, D5+D11)

[–] _merchant-row.tsx <Link>, _transaction-row.tsx render, FilterBar hidden field
    — no UI tests (CLAUDE.md V1 scope); covered by the manual checklist (D7)
```

Full manual checklist and edge cases:
`~/.gstack/projects/thehashrocket-my_money_manager/jasonshultz-thehashrocket-categorize-name-to-transactions-eng-review-test-plan-20260907-181500.md`

## Failure modes

| Codepath | Realistic failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| `merchantDrilldownHref` | someone swaps `URLSearchParams` for a template literal; `#` truncates the query | Yes ★★★ | n/a | wrong rows, silently |
| `filterValuesToSearchParams` | `merchant` not serialized; page 2 unfiltered | Yes ★★★ (D5+D11) | n/a | unfiltered list that reads as filtered |
| `searchParamsSchema` | `merchant` omitted from the strict schema | Yes (D11) | `notFound()` | Next 404 — loud |
| `loadTransactions` | predicate uses `like` not `eq` | Yes ★★★ | n/a | superset, silently |
| merchant chip `⊗` | builds href without dropping `merchant` | Yes (round-trip) | n/a | filter won't clear |
| stale key post-backfill | `db:backfill-merchants` rewrites keys; a bookmarked link 0-rows | No | none | `OLD KEY — 0 rows` |

**No critical gaps.** The one uncovered row produces a visible `— 0 rows` header naming
the filter, not wrong data, is only reachable from a bookmark, and is inherent to rule 10
rather than introduced here. D15 documents it in rule 10 instead of coding around it.

## NOT in scope

- **Playwright / any E2E harness** — CLAUDE.md rules UI tests out of V1; not reversing
  that for one link (D7). The click→paginate flow is a manual checklist instead.
- **Linking the category badge** (`→ Groceries (rule)`) to `?categoryId=N` — renders on
  6 of 181 rows; D3 already surfaces the same history (D4).
- **A visible merchant *input* in `FilterBar`** — `merchant=` is exact-match on a
  normalized key, so a text field would silently zero-row anyone typing `amazon` (D10).
- **Collapsing all three `/transactions` URL builders into one module** — the right end
  state; deferred to TODOS.md as its own reviewable refactor (D14).
- ~~**A sample memo per group on `/categorize`**~~ — **REVERSED by D16.** Three
  independent reviewers found the round trip, not the missing detail, was the failure
  point. Now the primary affordance.
- **Month-scoping `/categorize`** — `TODOS.md:432` (P2), independent of this.
- ~~**Restyling `/categorize` to Ledger Paper tokens**~~ — **PARTIALLY REVERSED by D17
  + D21.** Row shells and the amber backlog strip are in scope; the rest of the page
  is not.
- **Colouring category badges by category** — 19 categories against 5 accents means any
  cycling palette lies. Answered by a header summary instead (D20).
- **`cacheComponents: true`** — would preserve `useState`, scroll and `<details>` state
  structurally, replacing D19's hand-rolled persistence. A caching-model migration, not
  a feature PR. TODOS.md.
- **Converting `import/preview`'s raw amber to tokens** — the 4th offender in DESIGN.md's
  audit table, but it sits on the import path (D21). TODOS.md.
- **A filter-removal affordance for the other eight filters** — D18's merchant chip is
  the only removable one, a consistency wrinkle until the rest catch up. TODOS.md.
- **Raising the global type scale to 16px** — Codex flagged it; already adjudicated and
  deferred standalone at `TODOS.md:1163`. Not reopened here.

## What already exists

| Existing | Reused? |
|---|---|
| `transactionsDrilldownHref` (`lib/budget/`) — `/budget` → `/transactions` drilldown | Yes — new builder lives beside it (D6) |
| `loadTransactions` 10-filter machine, `TransactionFilter` | Yes — one field added, no restructure |
| `filterValuesToSearchParams` / `buildHref` carry-forward | Yes — one field added; the chip's ⊗ href reuses `buildHref` |
| `transactions_merchant_idx` (`schema.ts:300`) | Yes — makes `eq()` index-backed for free |
| `searchPredicate` already matching `normalized_merchant` | **Deliberately not reused** — `LIKE %x%` returns a superset (D2) |
| `FilterSummary` already lists active filters | Yes — but it is a `parts.join(" · ")` `<p>`, NOT a chip row. D18 rebuilds it as one |
| `TransactionRow.rawMemo` already selected by `loadTransactions` | Yes — no query change for the memo line itself |
| `/transactions/loading.tsx` | Yes — makes `prefetch={false}` free (D8) |
| `listLeafCategories(db, {includeArchived: true})` (`page.tsx:130`) | Pattern noted — no merchant equivalent exists (merchants aren't a table) |
| **`StateCard`** (`components/ledger/state-card.tsx`) — `variant="empty"` + title/description/actions | Yes — D18's empty state. `/transactions`' current one-sentence `EmptyState` predates it |
| **`AllCaughtUp`** (`_categorize-ui.tsx:84`) — `✓`, heading, warm copy | Pattern — the empty state `/transactions` should have had all along |
| **`min-h-11` 44px floor** (`_transactions-ui.tsx:163-166`, with the comment explaining why) | Yes — every new interactive element inherits it (DS66) |
| **`color-mix(in oklch, var(--accent-amber) …)`** — shared formula used by `BacklogBanner`, the dashboard tile, the Spine chip | Yes — D21 converts the two backlog strips onto it |
| **`--motion-quick` / `--motion-ease`** (`globals.css`) + the one global `prefers-reduced-motion` rule | Yes — D22's disclosure chevron. No per-component `motion-reduce:` variant |
| **DS49's ruled row-lists** on the dashboard (TODOS.md:1115) | Yes — the reference implementation for D17 |
| `← Budget` back-link idiom (`categorize/page.tsx:28-33`) | Yes — `/transactions` gains the mirror-image `← Categorize` (D18) |
| `groups.length` (`_categorize-ui.tsx:39`) | **Was computed and never rendered** — now the progress counter (D18) |

Nothing is rebuilt that already exists.

## Parallelization

Sequential implementation, no parallelization opportunity — every step funnels through
`src/app/transactions/` and the five carry-forward sites must land together or the
feature is broken between commits. T1 (extraction) gates T3/T4; T5 gates T6/T9.

## Design specification

Added by `/plan-design-review` (2026-09-07). Initial design completeness: **4/10**.
Eight decisions (D16-D23) plus the visual spec below. Two independent outside voices
(Codex gpt-5.4, fresh Claude subagent) agreed 7/7 on the litmus scorecard and both
triggered the same hard rejection.

| # | Decision | Chosen | Why |
|---|---|---|---|
| D16 | Navigate vs disclose | **Both** — `<details>` samples in place, drilldown as escape hatch | Three reviewers independently found the round trip, not the missing detail, was the failure point. Reverses the plan's rejection of D9 option C. |
| D17 | Row shells | **Ruled rows, both pages** | `[HARD REJECTION]` confirmed 2/2: `_transaction-row.tsx:127` and `_merchant-row.tsx:84` are both `rounded-md border p-3` in `ul.space-y-2`. DS49 (TODOS.md:1115) is the in-repo reference. |
| D18 | Zero-result state | **Merchant-aware `StateCard` + both escapes** | `?search=` recovers the post-backfill stale-key case automatically — rule 10's unfixable coupling becomes one click. |
| D19 | Unsaved dropdown pick | **Persist to `sessionStorage`** | `MerchantRow` holds it in `useState` (`:33-37`) 60px from the link. Verified: `<Activity>` preservation is gated on Cache Components, which `next.config.ts` does not set. |
| D20 | Category badge colour | **Monochrome + header summary; `Uncategorized` stays amber** | 19 categories vs 5 accents — any cycling palette lies. Amber is the only badge encoding a *state*. |
| D21 | Amber drift | **Convert both backlog strips + the Uncategorized badge** | DESIGN.md's own audit names them. Excludes `import/preview` (import path). |
| D22 | What the merchant name does | **It is the `<details>` control; the link moves inside** | Halves added tab stops (362 → 181) and structurally closes truncation, `opacity-50` contrast, link-inside-`<form>`, and navigate-with-unsaved-state. |
| D23 | T9 link semantics | **Merge, plain text on self-match** | Replace silently discards date range + `pageSize`. Self-link flagged by both outside voices. |

### Visual spec — every new element, to the token

| Element | Spec |
|---|---|
| Merchant name (`/categorize`) | `<summary>` control. `text-terracotta`, no resting underline, `hover:underline underline-offset-4`. `title` = full key. `py-2.5 -my-2.5` for the 44px floor without changing row height. Chevron rotates on `--motion-quick`. |
| Rule-backed rows | **Full-strength ink** — drop `opacity-50` (`_merchant-row.tsx:86`). The `→ GROCERIES (RULE)` badge carries the settled signal. A control inside a 50%-opacity row fails contrast and has no hover on touch. |
| Sample memos | 3 max, `font-mono text-[var(--text-xs)] text-ink-3`. Suppress any sample identical to the group key (151 rows / 9.8% of the ledger). If none survive, render no disclosure control at all. `See all 59 transactions →` closes the region. |
| `rawMemo` line (`/transactions`) | `font-mono`, one line desktop / two mobile, `truncate` + `title`. Suppressed when identical to the merchant key. **When `merchant` is active, the merchant name is dropped from the row and the memo takes the primary slot.** |
| `title={row.rawDescription}` | **DELETE** (`:135` and `:243`). `raw_description` holds only `WITHDRAWAL` (1302) or `DEPOSIT` (238) — this tooltip has conveyed nothing on 1,540 of 1,540 rows. |
| Filter chip row | Above the filter panel, replacing the `parts.join(" · ")` `<p>`. Removable merchant chip = filled terracotta + `×`; non-removable facts = outline chips. `rounded-[999px]` (DESIGN.md: pill radius is chips only). `×` wrapped in `min-h-11 min-w-11` with `aria-label="Remove merchant filter"` — the glyph is silent to a screen reader (same class as the DS66 parens rule). Not `⊗`: not in this app's vocabulary. |
| Header block (`FilterSummary`) | `← Categorize` return link (mirrors `categorize/page.tsx:28-33`), chip row, `COSTCO GAS — 50 rows, 1 uncategorized · 49 filed as Gas`, and `Categorize all 1 →` (the earlier spelling of this example spliced AMAZON's 59/53 onto COSTCO GAS's filing history, which cannot add up). Merchant is `parts[0]`, its own element, `max-w-[28ch] truncate` + `title` (longest real keys are 63-69 chars of personal Zelle strings). |
| Row dimming (`/transactions`) | **Suppress when `merchant` is active.** Otherwise the 49 filed rows that ARE D3=A's rationale render at `opacity-50` while the 1 row you already knew about is the only thing at full contrast. |
| Empty state | `StateCard variant="empty"`. `No transactions for "amazon".` + `[Remove the merchant filter]` + `[Search for "amazon" instead →]`. Names the key verbatim. |
| Progress counter | `Backlog: 498 transactions — $8,420.11 · 12 of 181 merchants done`. `groups.length` already exists at `_categorize-ui.tsx:39` and was never rendered. |
| Focus | `focus-visible:outline-2 focus-visible:outline-offset-2` in terracotta on every new interactive element. |
| Visited | Distinct visited treatment on merchant links — 181 of them on a page worked in passes; "did I already look at this one?" is a real question. Terracotta must not override it. |
| Amber (D21) | `color-mix(in oklch, var(--accent-amber) …)`, the shared formula. Watch the `-mx-5` gutter coupling on the sticky strips (DESIGN.md). |
| Money | Parens on negatives, `[font-variant-numeric:tabular-nums]`, `formatCents()`. |
| 375px | Rows stack; the merchant control takes its own full-width line as a real 44px target. Expanded disclosure layout at this width is **unresolved** — needs eyes at implementation. |

### Litmus scorecard (Claude / Codex — 7/7 consensus)

```
1. Brand unmistakable in first screen?    YES / YES
2. One strong visual anchor?               NO / NO      → D18 header block
3. Scannable by headlines only?            NO / NO      → D17 column headers
4. Each section has one job?               NO / NO      → D16 splits the two questions
5. Cards actually necessary?               NO / NO      → D17 [HARD REJECTION]
6. Motion improves hierarchy?              NO / NO      → D22 chevron on --motion-quick
7. Premium without decorative shadows?     NO / NO      → D17
```

## Approved Mockups

| Screen | Path | Direction | Notes |
|---|---|---|---|
| `/transactions` chrome | `~/.gstack/projects/thehashrocket-my_money_manager/designs/merchant-drilldown-20260907/variant-C.png` | Filter chip row above the panel, terracotta underlined links, ISO dates, hairline rules | Its rows omit the 5 per-row controls — that is generator omission, not a proposal |
| `/transactions` row density | `.../round2-B.png` | All 5 controls retained; Remember + Apply-to-past stacked vertically to absorb the memo line | Corrections: real 48-72 char bank memos, parens on negatives, drop invented tags/split/currency |
| `/categorize` row | `.../categorize-row.png` | Terracotta underlined control, full-strength rule-backed row, 69-char truncation with underline through the ellipsis, 375px stacking | Predates D22 — the name is now a `<details>` control, not a link |

## Implementation Tasks

Synthesized from the eng review (T1-T10) and this design review (T11-T16). Each task
derives from a specific finding. T1-T5 are unchanged; T6-T10 are revised where a design
decision moved them.

- [x] **T1 (P1, human: ~1h / CC: ~10min)** — `lib/transactions` — extract `searchParamsSchema` + `flatten` out of `page.tsx`
  - Surfaced by: Outside voice #3 (D11); `vitest.config.mts` is `environment: "node"`
  - Files: `src/lib/transactions/searchParams.ts` (new), `src/app/transactions/page.tsx`
  - Verify: `pnpm build` passes; `pnpm test` green
- [x] **T2 (P1, human: ~1h / CC: ~10min)** — `loadTransactions` — add exact `merchant` filter
  - Surfaced by: Architecture #1 (D2) — `searchPredicate` is `LIKE %x%`; `AMAZON` 53 → 71
  - Files: `src/lib/categorize/loadTransactions.ts`, `.test.ts`
  - Verify: assert `AMAZON` excludes `AMAZON PRIME`
- [x] **T3 (P1, human: ~1h / CC: ~10min)** — thread `merchant` through all 5 carry-forward sites
  - Surfaced by: Code Quality #4 (D5) — silent page-2 drop, documented 3× in `_filter-bar.tsx`
  - Files: `src/lib/transactions/searchParams.ts`, `page.tsx`, `_filter-bar.tsx`
  - Verify: `pnpm test` + manual QA 2-4
- [x] **T4 (P1, human: ~1h / CC: ~10min)** — keys-driven round-trip test, both halves
  - Surfaced by: Code Quality #4 (D5=B), unlocked by T1
  - Files: `_filter-bar.test.ts`, `src/lib/transactions/searchParams.test.ts`
  - Verify: delete the new `params.set("merchant", …)`; the test must fail naming `merchant`
- [x] **T5 (P1, human: ~45min / CC: ~10min)** — `merchantDrilldownHref` + URL-encoding tests
  - Surfaced by: Test review — 17 of 363 real keys carry `# * ? /`
  - Files: `src/lib/budget/transactionsDrilldownHref.ts`, `.test.ts`
  - Verify: pin `GASCO#00000ANYTWN` → `merchant=GASCO%2300000ANYTWN`
- [x] **T6 (P1, human: ~4h / CC: ~35min)** — **[HARD REJECTION]** convert both row lists from cards to ruled rows
  - Surfaced by: Pass 1 / D17 — Codex + subagent both triggered hard rejection #7; litmus 5 NO on both
  - Files: `src/app/categorize/_merchant-row.tsx`, `_categorize-ui.tsx`, `src/app/transactions/_transaction-row.tsx`, `_transactions-ui.tsx`
  - Verify: no `rounded-md border p-3` row shells remain; column headers render; compare against DS49's dashboard lists
- [x] **T7 (P1, human: ~3h / CC: ~25min)** — `<details>` sample-memo disclosure on `/categorize` rows
  - Surfaced by: Pass 3 / D16 + D22 — the round trip was the failure point; the merchant name is now the control
  - Files: `src/lib/categorize/loadMerchantGroups.ts` (+`loadSampleMemos`, `selectDistinct` with the cap applied in JS), `_merchant-row.tsx`
  - Verify: `AUDIBLE` (memo == key) renders NO disclosure control; `AMAZON` shows 3 distinct memos + `See all 59 transactions →`
- [x] **T8 (P1, human: ~1h / CC: ~10min)** — `rawMemo` line, conditional; delete the dead `rawDescription` tooltip
  - Surfaced by: Outside voice #1 (D9), refined by Pass 1 — merchant name is dropped and memo promoted when `merchant` is active
  - Files: `src/app/transactions/_transaction-row.tsx`
  - Verify: memo readable without hover and present on touch; suppressed on the 151 identical-to-key rows; no `title={row.rawDescription}` anywhere
- [x] **T9 (P1, human: ~2h / CC: ~20min)** — rebuild `FilterSummary` as the header block
  - Surfaced by: D18 + D20 + Pass 3 — return path, chip row, counts, and the finishing action are one component
  - Files: `src/app/transactions/page.tsx`, `src/lib/categorize/loadTransactions.ts` (`GROUP BY category_id`)
  - Verify: `← Categorize` present when `merchant` active; `×` drops merchant and leaves the date range; `Categorize all 53 →` returns
- [x] **T10 (P1, human: ~1h / CC: ~10min)** — merchant-aware empty state on `StateCard`
  - Surfaced by: D18 — three reachable paths, currently one flat sentence
  - Files: `src/app/transactions/_transactions-ui.tsx`
  - Verify: `?merchant=amazon` names the key and offers both escapes; `Search instead` reaches `?search=amazon` with rows
- [x] **T11 (P1, human: ~3h / CC: ~25min)** — persist the pending category pick across navigation
  - Surfaced by: Subagent finding #1 (D19) — verified: no `cacheComponents`, so `useState` is genuinely lost
  - Files: `src/app/categorize/_merchant-row.tsx`
  - Verify: pick a category, drill down, return — the pick survives; submit clears it; a group categorized elsewhere does not restore a stale pick
- [x] **T12 (P2, human: ~1h / CC: ~10min)** — a11y pass on every new element
  - Surfaced by: Pass 6 — 44px targets, focus rings, visited state, `aria-label` on the silent `×`
  - Files: all of the above
  - Verify: keyboard-only walk of 3 rows on each page; every new target ≥44px; visited links visibly differ
- [x] **T13 (P2, human: ~45min / CC: ~10min)** — T9 link semantics: merge + plain text on self-match
  - Surfaced by: D23 — Codex #4 and subagent #10 independently
  - Files: `src/app/transactions/_transaction-row.tsx`
  - Verify: clicking from a date-filtered view keeps the date range; rows matching the active merchant render as text
- [x] **T14 (P2, human: ~1h / CC: ~10min)** — amber drift: two backlog strips + Uncategorized badge onto tokens
  - Surfaced by: D21 — DESIGN.md's own audit table
  - Files: `_categorize-ui.tsx`, `_transactions-ui.tsx`, `_transaction-row.tsx`
  - Verify: no raw `amber-*` in those three; `-mx-5` still equals the `p-5` gutter
- [x] **T15 (P2, human: ~30min / CC: ~5min)** — progress counter + discoverability hint
  - Surfaced by: Pass 3 — `groups.length` computed at `_categorize-ui.tsx:39` and never rendered
  - Files: `src/app/categorize/_categorize-ui.tsx`, `page.tsx`
  - Verify: counter reads `N of 181 merchants done` and decrements per group, not per transaction
- [x] **T16 (P3, human: ~10min / CC: ~2min)** — `CLAUDE.md` rule 10 gains a third consumer
  - Surfaced by: TODO 3 (D15)
  - Files: `CLAUDE.md`
  - Verify: read rule 10 back; the URL-param coupling is visible to a backfill reader

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 13 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 4/10 → 9/10, 8 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |
| Outside Voice | `/plan-eng-review` + `/plan-design-review` | Cross-model plan challenge | 2 | issues_found | eng: 6 findings; design: 7 findings + 1 hard rejection |

- **CODEX:** Two runs. The eng-review run produced D9-D12. The design run classified this
  `APP UI` and triggered **hard rejection #7 — "app UI made of stacked cards instead of
  layout"** — verified in code (`_transaction-row.tsx:127`, `_merchant-row.tsx:84`, both
  `rounded-md border p-3` inside `ul.space-y-2`) and closed by D17. Six of its seven design
  findings were confirmed; the seventh split — the "visited link distinction" half was
  accepted, the "raise body text to 16px" half was **rejected as already adjudicated**
  (`TODOS.md:1163` defers the global type scale standalone, deliberately).
- **CROSS-MODEL:** The design-stage litmus scorecard was **7/7 consensus, zero
  disagreements**, and both models triggered the same hard rejection independently. Three
  reviewers (primary, Codex, fresh Claude subagent) converged from three directions on one
  structural problem — the plan treats this as a link when it is a round trip — which is
  what D16 answers. The subagent alone found the severest defect: navigating to the
  drilldown destroys `MerchantRow`'s unsaved `useState` pick (`:33-37`) from a link 60px
  away, confirmed against the Next 16 docs (no `cacheComponents`, so pages genuinely
  unmount). Its scroll-loss claim was checked and **dropped** — `link.md:232` says scroll is
  maintained on back/forward.
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement. Note the design review added 10
  tasks (T6-T15) and reversed two "NOT in scope" lines after the eng review ran, so a
  re-run of `/plan-eng-review` against the grown scope is worth considering before shipping.

NO UNRESOLVED DECISIONS
