# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Rule engine** (`src/lib/rules.ts`): `applyRuleAtImport` (auto-categorize during commit if an exact match exists) + `createOrUpdateRule` (idempotent upsert).
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
