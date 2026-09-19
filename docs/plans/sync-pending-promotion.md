# Plan — sync pending/posted content-dedup promotion

Source: TODOS.md's two most recent, confirmed-but-unfixed P2s (2026-09-18,
sync-dedup-race-fixes review tail), selected via `/plan-eng-review` triage of
TODOS.md + PLAN.md. Both are correctness bugs in `src/lib/simplefin/sync.ts`
that clear PLAN.md's own severity bar ("verified in code... can silently
produce a wrong number, lose data, or report a durable fact that didn't
happen"). Staged as two PRs per this repo's established pattern for
related-but-separable sync fixes (see `card-transaction-import.md`,
`sync-dedup-race-fixes` itself).

## PR1 — pending/posted content-dedup promotion (TODOS.md:3465)

### The bug

A pending CSV row and a later-posted, content-matching SimpleFIN row collide
in `syncSimpleFin`'s content dedup with no promotion path. Reproduced
empirically (not just reasoned): a pending CSV row and a matching posted feed
row (same date/amount/memo) produce `duplicateByContent: 1, insertedCount: 0`.
The pending row is never updated, stays `is_pending: true` forever, and is
permanently excluded from the balance sum (rule 1: `SUM(... AND NOT
is_pending)`) — a phantom missing amount (`driftCents`) on every future sync.

`loadContentBudget` (`sync.ts:239-305`) has no `is_pending` filter in
`existingByContent`'s WHERE clause (confirmed by reading it directly) and
returns only a per-signature COUNT, with no way to identify which existing
row is pending. CSV import already solved this exact problem —
`commitImport`'s `buildPreview` (`importBatch.ts:153-244`) builds
`contentCandidates: Map<signature, {id, isPending}[]>` and
`claimContentCandidate` prefers a pending candidate when the incoming row is
posted, producing an `updateExistingRowId` that `commitImport` uses to UPDATE
the existing row in place instead of dropping the new one. Sync's content
dedup has no equivalent.

### What already exists (reused, not rebuilt)

- `contentSignature` (`src/lib/contentSignature.ts`) — already shared between
  both write paths; unchanged.
- `importBatch.ts`'s `contentCandidates` / `claimContentCandidate` — the
  algorithm this plan extracts and shares, not reimplements (Issue 2A).
- `recheckContentDedup`, `recheckLandedIds`, `applyDedupPruning`, the `Staged`
  entry shape, and the whole read-before-await recheck discipline sync.ts
  already established for id/content/cutover races — v2's design routes
  promotable rows through these UNCHANGED instead of adding a fourth,
  narrower recheck beside them (see "What the outside review changed" below).
- `undoSyncBatch` / `findLastSyncBatch`'s batch-ownership model and
  `linkTransfersByBucket`'s batch-scoped persist filter — extended (v2), not
  bypassed, so a promoted row participates in undo and transfer pairing the
  same way an inserted row already does.

### What the outside review changed (Codex, run against v1 of this plan)

v1 mirrored CSV's `toUpdate` pattern directly: leave the promoted row's batch
id alone, add one narrow new recheck, done. Codex read the actual code
(`undoSync.ts`, `sync.ts`'s `linkTransfersByBucket`, `import/page.tsx`) rather
than taking the plan's claims on faith and found that shape doesn't fit sync:

1. Sync's `undoSyncBatch`/`findLastSyncBatch` treat "rows this batch owns" as
   load-bearing for undo and reporting (verified: `undoSyncBatch` deletes
   exactly `WHERE import_batch_id = batchId`) — a promotion-only sync would
   mint a batch owning zero rows, the exact "empty batch" class
   `NothingVerifiedError` exists to prevent, reached through a door that
   guard doesn't cover.
2. The id/content rechecks only ever inspected `entry.rows` — a row diverted
   into a separate `toPromote` list at staging time (v1's design) would
   silently skip both, reopening exactly the race class this file has been
   hardened against three times already this branch.
3. `linkTransfersByBucket` deliberately only persists a pair with a leg from
   THIS batch (verified at `sync.ts:2508-2514`) — a promoted row keeping its
   old batch id would be permanently unpairable as a transfer even after
   promotion, trading "stuck pending forever" for "never re-paired."
4. D8.4 card-completeness bookkeeping was solving a case that can't occur —
   CSV import is asset-only (verified: `import/page.tsx` filters to
   `accountClass === "asset"`), so a card can never hold a CSV-origin pending
   row to promote.
5. The plan's fallback language invented "prefer the newest candidate"
   ordering that `contentCandidates`'s actual `pop()`-off-arbitrary-row-order
   implementation doesn't have.

v2 above resolves all five: (1) is closed by the new `sync_promotions` table
(item 5); (2) is closed by routing promotable rows through the existing
`entry.rows` pipeline instead of a side list (item 3); (3) is closed by
extending `linkTransfersByBucket`'s persist filter to cover
`sync_promotions` rows too (item 6); (4) is dropped as scope that never
applied (item 7); (5)'s claim is removed and replaced with an explicit
"order is unspecified" test (item 1).

### Design v2 (revised after outside review found the v1 design didn't fit
sync's batch/undo/pairing model — see "What the outside review changed" below)

**Governing idea:** a promotable row is NOT a special case bolted onto content
dedup. It is an ordinary `toInsert` candidate that flows through 100% of the
EXISTING id-recheck / content-recheck machinery unchanged, and only at the
literal write statement does it get redirected from INSERT to UPDATE. This is
what makes rechecking not a "fourth bolt-on" (Codex's point 2) — it's the same
two rechecks already there, applied to the same row set already there.

1. **Extract `src/lib/contentCandidates.ts`** (Issue 2A — approved):
   `buildContentCandidates(existingRows)` → `Map<string, Candidate[]>` and
   `claimPendingCandidate(candidates, sig)` → `Candidate | undefined` (pops
   ONLY a pending candidate for the signature, never a posted one — posted
   candidates stay in `loadContentBudget`'s ordinary count-based dedup,
   unchanged). No invented "newest" ordering (Codex's point 5) — SQLite row
   order is explicitly documented as arbitrary in the new module's docstring,
   and neither caller depends on which one is picked when several pending
   rows share a signature (multiset content-dedup already tolerates this).
   `importBatch.ts`'s `buildPreview` and `sync.ts`'s staging loop both call
   it; `importBatch.ts`'s existing tests re-verify the extraction changed
   nothing about CSV's already-correct behavior.

2. **Content budget excludes pending rows from the COUNT** (posted-only budget,
   same query, `isPending` now selected and filtered out of the tally, not
   the WHERE clause — a pending row is never a "plain duplicate," it's a
   promotion candidate or nothing). A posted incoming row first tries
   `claimPendingCandidate`; if that finds nothing, it falls through to the
   existing posted-budget count check exactly as today.

3. **Staging loop**: a row with a pending candidate is pushed onto
   `entry.rows` (`toInsert`) LIKE ANY OTHER NEW ROW, carrying an optional
   `promotionCandidateId` field. It is NOT diverted into a separate list. This
   is the fix for Codex's point 2: `recheckLandedIds` and `recheckContentDedup`
   both iterate `entry.rows`, so a promotable row gets the exact same
   concurrent-writer protection as a brand-new row, with no new recheck
   function needed for that part.

4. **Write transaction — redirect, don't special-case**: at the point that
   loops `entry.rows` to build the INSERT (`sync.ts:~1254`), a row carrying
   `promotionCandidateId` re-reads that candidate's CURRENT `is_pending` and
   `external_id` inside the transaction first (Issue 1B's race check, now
   scoped to exactly the one thing `recheckLandedIds`/`recheckContentDedup`
   don't already cover: whether the SPECIFIC candidate row is still available
   to claim, not whether the incoming row itself is a duplicate — that part
   is already handled by step 3). Still pending and unclaimed → UPDATE it
   (`isPending: false`, `rawMemo`, `normalizedMerchant`, `payee`,
   `cardLastFour`, `importRowHash`, `externalId`, `simplefinSourceAccountId`,
   **and `bankTransactionNumber: null`** — round-3 outside-review finding, see
   below — plus Issue 1A, approved: stamp provenance at confirmation time).
   No longer available (already promoted or deleted since staging) → fall
   through to an ordinary INSERT of the incoming row, exactly as if it had
   never matched a candidate — this is now safe specifically because step 3
   already ran it through the real dedup rechecks, so "insert it as new"
   cannot double-count.

   **`bankTransactionNumber` must be nulled, not left alone** (round-3
   finding — confirmed by reading `matchTransfers.ts:317` and
   `linkTransfersByBucket`'s `adjudicatedByTxnNumber` derivation at
   `sync.ts:2494` directly): sync's transfer matcher treats ANY non-null
   `bankTransactionNumber` as "already adjudicated by CSV" (rule 4) and
   diverts an otherwise-clean cross-source pair to manual review instead of
   auto-linking it. A promoted row keeps whatever Star One assigned at
   CSV-import time — including, in the worst case, the shared `6098`
   pending-placeholder number rule 3 specifically warns about — so leaving
   it in place would make PR1's own stated goal (item 6, transfer
   re-pairing) silently never fire for exactly the rows this fix exists to
   promote. Nulling it is what makes a promoted row behave like an ordinary
   SimpleFIN-native row for pairing purposes, which is the property being
   claimed. `priorBankTransactionNumber` joins the `sync_promotions`
   snapshot (item 5) so undo restores it.

   **Categorization does NOT run on promotion** (closes a round-2 outside-review
   finding — see below): `categoryId` is deliberately absent from the UPDATE
   field list, and no `import_batch_categorizations` row is written for a
   promoted row. This matches CSV's own precedent exactly — `commitImport`'s
   `toUpdate` path (`importBatch.ts:403-416`) never re-runs `buildRuleMatcher`
   either, because the row already went through rule-matching once, when it
   was first inserted (as pending) by whichever write path created it. A
   promoted row's category is therefore whatever it already was: null if
   nothing matched at original-insert time, a rule's category if one did, or
   whatever the user has since set by hand — never re-decided by this sync.
   This is the one place a promoted row's write path DIFFERS from an ordinary
   insert's, and it differs on purpose: "route it through the same pipeline"
   (step 3) is about dedup safety, not about re-running every insert-time side
   effect on a row that already had its one categorization decision made.

5. **Batch/undo model (Codex's point 1 — the real gap).** A promoted row's
   `transactions.import_batch_id` is left UNCHANGED (still points at its
   original CSV batch) — repointing it to the sync batch would make
   `undoSyncBatch`'s delete-based undo destroy a transaction that predates
   this sync, which is worse than today's bug. Instead, a new join table,
   **`sync_promotions`** (`batchId` → `import_batches.id` `onDelete: cascade`,
   `transactionId` → `transactions.id` `onDelete: cascade`, plus the row's
   PRE-promotion values: `priorIsPending`, `priorRawMemo`,
   `priorNormalizedMerchant`, `priorPayee`, `priorCardLastFour`,
   `priorImportRowHash`, `priorExternalId`, `priorSimplefinSourceAccountId`,
   **`priorBankTransactionNumber`, `priorTransferPairId`** — the last two
   added after round-3 review, see below), records "this sync batch promoted
   this row, here is how to put it back."
   `findLastSyncBatch`'s reported count becomes `insertedCount +
   promotedCount` (two numbers, not folded into one — a promotion is not new
   money the way rule 1's spend/income distinction already refuses to fold
   two different facts into one figure). `undoSyncBatch`, inside its existing
   transaction, gains a second step: for every `sync_promotions` row on this
   batch, UPDATE the transaction back to its prior snapshot, THEN delete as
   today (`import_batches` cascade takes `sync_promotions` rows with it, but
   the revert UPDATE must run first — cascade alone would just discard the
   snapshot without ever applying it).

6. **Transfer re-pairing (Codex's point 3).** `linkTransfersByBucket`'s
   persist filter (`sync.ts:2508-2514`, "only persist a pair involving a row
   from THIS batch") is extended to also treat a row present in this batch's
   `sync_promotions` as "from this batch" — mirroring CSV's `toUpdate`
   row-id re-seed (`importBatch.ts:462-465`) instead of leaving sync as the
   one write path where a newly-posted row can never get its transfer
   pairing persisted. **`syncSimpleFin` now also writes `pairsLinkedCount`
   onto its own batch row** (round-2 outside-review finding — see below):
   confirmed by reading `sync.ts` directly, it never has, because
   `/import/success/[batchId]`'s own comment says the batch-scoped
   `COUNT(*)` fallback is "exact by construction" for sync, since sync had no
   `toUpdate`-equivalent concept before this plan. Promotion makes that
   premise false the same way it was already false for CSV (which is why
   CSV writes this column explicitly rather than relying on the count) — a
   pair involving a promoted row would otherwise silently undercount on the
   success page.

   **Undo must restore the row's PRIOR pairing state, not blindly clear it
   to NULL** (round-3 outside-review finding — a "clear to null" v2 draft
   was wrong: confirmed by reading `linkTransfersByBucket`'s `unlinked`
   candidate query at `sync.ts:2471`, a PENDING row is not excluded from
   automatic transfer-pairing today — `findAmbiguousTransfers`,
   `findSameAccountReversalCandidates`, `linkTransferPairManually` and
   `rejectTransferPairManually` all have no `isPending` guard either — so a
   candidate row can ALREADY carry a real `transfer_pair_id` from BEFORE
   this sync ever ran, entirely unrelated to promotion. Blindly nulling it
   on undo would erase a pre-existing, correct pairing that had nothing to
   do with this sync.) `priorTransferPairId` (added to the `sync_promotions`
   snapshot above) is read and stored at the moment promotion happens, BEFORE
   any write. On undo: if the row's CURRENT `transferPairId` differs from
   `priorTransferPairId` — meaning THIS sync's own `linkTransfersByBucket`
   call created a new pairing after promoting it — clear that new pairing on
   both legs (a raw symmetric clear, not `unlinkTransferPair`, which also
   records a `transfer_pair_rejections` row; undoing a promotion is not a
   human saying "not a transfer," it's taking back the promotion that made
   the pairing possible). Then set `transferPairId = priorTransferPairId` on
   the row — restoring whatever it was already, including "still correctly
   paired to whatever it was already paired to before this sync touched it"
   when `priorTransferPairId` is non-null. The prior partner's own
   `transferPairId` needs no separate restoration: since
   `linkTransfersByBucket`'s candidate query excludes any row that already
   has a non-null `transferPairId`, a pre-existing pairing was never eligible
   to be reassigned by this sync in the first place, so the partner's side of
   it was never touched.

7. **D8.4 card completeness dropped from this PR (Codex's point 4).** CSV
   import is asset-only (`import/page.tsx:18-26` filters to
   `accountClass(a.type) === "asset"`), so a CSV-origin pending row can never
   exist on a card account — `expectedCardExternalIds` bookkeeping was
   solving a case that cannot occur. Not added.

8. **Reporting**: `AccountSyncCounts` gains `promotedFromPending`, separate
   from `duplicateByContent` (a promotion is a write, not a no-op match).
   Surfaced via `accountWarnings`-shaped copy ("1 pending transaction
   confirmed as posted on \"X\"") — this file's standing doctrine that a
   durable write is never silent.

9. **`totalToInsert === 0` early-return** (`sync.ts:1123-1153`) is naturally
   correct now rather than needing a separate carve-out: because step 3 pushes
   promotable rows onto `entry.rows` like any other new row, the existing
   `staged.reduce((n, s) => n + s.rows.length, 0)` count already includes
   them. No special case needed — this is a side effect of the "route through
   the same pipeline" governing idea, not a patch bolted on afterward.

### Migration

New table `sync_promotions` (see field list in step 5). One migration via
`pnpm db:generate` + `pnpm db:migrate` (CLAUDE.md rule 7 — this is a new
table, not a rebuild, so it does not need `scripts/migrate.mjs`'s
foreign-key-off table-rebuild handling, but still goes through the same
script rather than a bare `drizzle-kit migrate`, per the project's standing
rule never to bypass it).

### Test plan

- `contentCandidates.test.ts` (new): `buildContentCandidates` grouping,
  `claimPendingCandidate` only ever returning a pending candidate (never
  posted), returning `undefined` when none is pending, empty-list behavior.
  Explicit test that candidate order is untested/unspecified (guards against
  the module's API ever silently promising an order it doesn't have).
- `sync.test.ts` (extend):
  - Core repro: pending CSV row + matching posted feed row → promoted,
    `is_pending` false, provenance stamped, `driftCents` no longer phantom,
    `promotedFromPending: 1`.
  - Recheck coverage: a concurrent writer lands the SAME external_id as the
    incoming row between staging and write → existing `recheckLandedIds`
    path fires for this row exactly as it would for an ordinary insert
    (proves step 3's "same pipeline" claim, not just asserts it).
  - Promotion-specific race: the candidate row is deleted, or already
    promoted by a concurrent completed sync, between staging and write →
    falls through to a plain insert, no lost transaction, no double-write.
  - Undo: `undoSyncBatch` on a batch that ONLY promoted (no inserts) reverts
    the row to its prior pending state and correctly reports
    `deletedCount`-equivalent feedback for the promotion instead of silently
    finding "nothing to undo."
  - Transfer pairing: a promoted row's real transfer partner (already in the
    ledger, unpaired) gets paired by this same sync, proving the
    `sync_promotions`-aware persist filter closes the gap Codex found.
  - `pairsLinkedCount` on the sync batch reflects a pair involving a promoted
    row (round-2 finding) — a bare `COUNT(*) WHERE import_batch_id = batchId`
    would miss it, mirroring `importBatch.test.ts`'s existing "seeds from
    BOTH freshly-inserted and toUpdate ids" test for the CSV side.
  - Categorization is NOT re-run on promotion (round-2 finding): a promoted
    row's pre-existing `categoryId` (set at original CSV-insert time, or
    since by hand) survives promotion unchanged, and no
    `import_batch_categorizations` row is written for it.
  - Undo restores a promoted row's PRE-promotion `transfer_pair_id` exactly
    (round-3 finding, supersedes round-2's "clear to null" language): a row
    already paired before this sync ran keeps that pairing after undo; a row
    that was unpaired before promotion and got newly paired by this same
    sync loses only that new pairing on undo.
  - `bankTransactionNumber` is nulled on promotion and a cross-source
    transfer pair auto-links afterward instead of routing to manual review
    (round-3 finding) — regression-guards against `adjudicatedByTxnNumber`
    silently defeating item 6's whole purpose. Undo restores the prior
    value.
  - Early-return: a sync whose only outcome is a promotion does NOT take the
    `up-to-date` path (now a natural consequence, tested as a consequence,
    not as a special-cased branch).
- `importBatch.test.ts`: existing tests re-verified against the extracted
  shared module.

### Round 2 outside review (Codex, run against v2)

All five round-1 findings confirmed closed. Three new, real gaps found —
verified independently by reading `undoSync.ts`, `sync.ts`'s insert loop, and
`import/success/[batchId]/page.tsx` directly rather than taking the review on
faith:

1. Transfer-pair undo asymmetry — a promoted row's `transfer_pair_id`
   survives undo because undo reverts it rather than deleting it, so the
   `ON DELETE SET NULL` cascade that un-pairs an ordinary undone row never
   fires. **Closed in v3 with a symmetric clear; refined further by round 3
   below**, which found the clear itself was too blunt.
2. Categorization side effects underspecified — resolved as "no re-run,
   matches CSV's own `toUpdate` precedent exactly." **Closed above** (item 4).
3. `syncSimpleFin` never writes `pairsLinkedCount` (confirmed: only
   `importBatch.ts` does), and the success page's batch-scoped `COUNT(*)`
   fallback is only exact for sync because sync never had a promotion
   concept before — promotion breaks that premise the same way it was
   already broken for CSV. **Closed above** (item 6).

v3 addressed all three. A third outside-review round then found two more,
both real and confirmed against the actual code:

1. The v3 "clear transfer_pair_id to NULL on undo" design was itself wrong —
   a pending row can already be legitimately transfer-paired before this
   sync ever runs (`linkTransfersByBucket`'s candidate query, and the manual
   pairing/rejection functions, have no `isPending` guard), so a blind clear
   would erase a real, pre-existing pairing that had nothing to do with the
   promotion. **Closed above** (item 6 rewritten to snapshot-and-restore
   `priorTransferPairId` instead of clearing).
2. `bankTransactionNumber` was left untouched by promotion, but sync's own
   transfer matcher treats ANY non-null value as "already adjudicated by
   CSV" and routes the pair to manual review instead of auto-linking it —
   silently defeating PR1's own stated transfer-re-pairing goal for exactly
   the rows it exists to fix. **Closed above** (item 4: nulled on promotion,
   snapshotted for undo).

v4 (this revision) addresses both. Three rounds have now each found real,
confirmed structural gaps — a pattern, not noise. Given diminishing returns
on reviewing an unimplemented plan against increasingly narrow edge cases
versus this project's own established practice of catching the remainder
during `/ship`'s specialist + adversarial review passes (which is what this
exact file's documented history shows actually closing issues at this
depth), the next step is implementation, not a fourth plan-only review round.

### NOT in scope (this PR)

- TODOS.md:3463 (duplicate external_id across the D8.1 cutover boundary) —
  staged as PR2 below; different failure shape, needs its own design pass on
  the within-response tie-break rule.
- TODOS.md's other open P3/P4 items (touch targets, empty-state ambiguity,
  Strict Mode disclosure quirk, etc.) — none clear PLAN.md's severity bar for
  a new condition; left on TODOS.md as-is.

## Implementation Tasks (PR1)

- [ ] **T1 (P1, human: ~1h / CC: ~15min)** — `src/lib/contentCandidates.ts` —
  extract `buildContentCandidates` + `claimPendingCandidate` from
  `importBatch.ts`; re-verify `importBatch.test.ts` against the extraction.
  Files: `src/lib/contentCandidates.ts` (new), `src/lib/contentCandidates.test.ts`
  (new), `src/lib/importBatch.ts`.
- [ ] **T2 (P1, human: ~1h / CC: ~20min)** — `sync_promotions` migration —
  new table per item 5's field list. Files: `src/db/schema.ts`, a generated
  migration under `drizzle/`. Verify: `pnpm db:generate` && `pnpm db:migrate`.
- [ ] **T3 (P1, human: ~3h / CC: ~40min)** — staging loop + write-path
  redirect — route promotable rows through `entry.rows` with
  `promotionCandidateId`, redirect INSERT→UPDATE at write time with the
  race re-check, null `bankTransactionNumber`, skip categorization. Files:
  `src/lib/simplefin/sync.ts`.
- [ ] **T4 (P1, human: ~2h / CC: ~30min)** — undo + transfer-pairing
  extensions — `undoSyncBatch`'s promotion-revert step (prior-state restore
  including `transferPairId`), `linkTransfersByBucket`'s persist filter,
  `pairsLinkedCount` write. Files: `src/lib/simplefin/undoSync.ts`,
  `src/lib/simplefin/sync.ts`.
- [ ] **T5 (P2, human: ~2h / CC: ~30min)** — reporting — `promotedFromPending`
  counter, `accountWarnings` copy, `findLastSyncBatch`'s two-number count.
  Files: `src/lib/simplefin/sync.ts`, `src/lib/simplefin/undoSync.ts`.
- [ ] **T6 (P1, human: ~3h / CC: ~40min)** — full test suite per the Test
  plan above. Files: `src/lib/simplefin/sync.test.ts`,
  `src/lib/simplefin/undoSync.test.ts`, `src/lib/contentCandidates.test.ts`,
  `src/lib/importBatch.test.ts`.

## PR2 — cutover-boundary duplicate-id loss + reissued-external_id race (TODOS.md:3463 + the "different external ids" P2)

Bundled deliberately (`/plan-eng-review`, 2026-09-18): both are instances of
the same underlying question — how much can `syncSimpleFin` trust a
SimpleFIN `external_id` to be a stable identity for one real-world
transaction. Three outside-review rounds (Codex) ran against the design
before implementation began, each finding real, confirmed structural gaps in
the previous round's fix — the same cadence PR1 went through. See "What the
outside review changed" below for the full history; this section is the
converged design.

### Bug A — D8.1 cutover-boundary duplicate-id loss

When SimpleFIN sends the SAME `external_id` twice in one response and the
two occurrences straddle a card's cutover anchor (one dated on/before, one
strictly after), the staging loop's `seenExternalIds` set collapses them by
array order — whichever occurs FIRST wins the id slot and is the only one
that ever reaches `entry.rows`; the second is discarded as an ordinary
`duplicateByExternalId`. If the pre-anchor occurrence happens to come first,
the post-anchor, ELIGIBLE occurrence is silently, permanently lost — neither
one lands. Reproduced empirically (anchor `2026-08-20`, occurrences dated
`2026-08-15` and `2026-09-01`, same external id → `ROWS: []`).

### Bug B — reissued external_id for the same real transaction

`queryContentDedupCandidateRows` (`sync.ts:267-326`) excludes any row
already tagged `simplefin_source_account_id = feedId` from content-dedup
candidacy, on the assumption "the id pass already accounts for it" — true
when the same feed reissues a STABLE id across repeated fetches (the
ordinary case, caught upstream by `seenExternalIds` before content dedup is
ever consulted). False if the feed genuinely issues a NEW id for what's
really the same event across two overlapping fetches (reproduced with a
mocked concurrent-sync side effect landing a row mid-fetch under a different
id) — the id pass doesn't match (different ids), and candidacy exclusion
means content dedup doesn't either, so a genuine duplicate row lands.
Pre-existing on `main`, unmeasured on the live ledger.

### Design decisions locked

- **Bug A: defer the tie-break to the write transaction, never a
  staging-time heuristic on the stale pre-fetch anchor.** Rule 11's own
  reasoning applies directly — the fresh anchor is only known
  post-`await fetchAccounts`. A heuristic using the stale anchor as a
  tie-break signal was considered and rejected: the losing occurrence would
  be discarded before ever reaching the fresh-anchor check, reopening
  exactly the class of bug this file has already found and fixed three
  times (rule 11's own list).
- **Bug A: no date-swap.** An earlier design carried a single surviving row
  plus an `alternateDates` array, swapped in by `recheckCutoverAnchor` at
  write time. Rejected — `contentSignature` includes date, and the swap
  happened AFTER `recheckContentDedup` already ran against the pre-swap
  date, so a differently-provenanced existing row matching the ALTERNATE
  date would never be checked against, letting a genuine duplicate slip
  through uncaught. The converged design never swaps a row's date; each
  occurrence keeps its own real date from staging through insert.
- **Bug B: scope to this sync's own race window (the fetch round trip),
  never a "same-feed row absent from this fetch" heuristic.** The naive
  heuristic is unsafe: a same-feed row legitimately vanishes from a fetch
  just by aging past the 45-day lookback floor, which would wrongly match it
  against a coincidentally-identical, genuinely different transaction — the
  exact regression rule 3 already fixed once (two identical same-day
  coffees must both survive). The actual reproduction is a race (two
  overlapping `/sync` fetches), not a steady-state pattern, so the fix
  mirrors `recheckContentDedup`'s frozen/fresh diff on ROW IDENTITY, scoped
  to same-feed rows that appeared strictly during THIS sync's own fetch —
  snapshotted BEFORE `await fetchAccounts` (not alongside the post-fetch
  `originalContentBudget` capture, which would already include a row that
  landed during the fetch itself, missing the exact race that was
  reproduced).
- **Bug B: no re-tagging.** Once a race is detected, the incoming duplicate
  is dropped and the existing (older-id) row is left as-is. No schema
  change, no new undo/snapshot semantics.
- **Two residuals accepted, not fixed, both bounded and disclosed:**
  1. **Bug A** — a genuine SimpleFIN anomaly (two REAL, distinct
     transactions issued the SAME external_id, both surviving every recheck
     independently) has no principled resolution; one is inserted
     deterministically and the drop is warned, never silently absorbed.
  2. **Bug B** — whether a same-feed row appearing during the race window
     represents a genuine reissue of an incoming row (should drop) or a
     coincidentally-identical, genuinely separate transaction (should NOT
     drop) is undecidable from content alone — the same ambiguity rule 4
     documents for same-account reversals. Accepted as proportionate: the
     exposure window is bounded by `SYNC_TIMEOUT_MS` (60s, `sync.ts:108`),
     roughly 1/64,800th of rule 3's own already-accepted coincidental-content
     window (the full 45-day lookback, every ordinary sync, forever).
     Separately, if a reissue is genuinely PERMANENT (the feed's new id, not
     a one-off race artifact), every later ordinary sync reporting the new
     id will still insert it as a duplicate — dropping the raced occurrence
     doesn't touch the steady-state candidacy exclusion the fix
     deliberately leaves alone (touching it reopens rule 3's regression).
     TODOS.md's own reproduction is race-scoped, not permanent-reissue-
     scoped, so this closes exactly the reported bug; the broader case is
     out of scope for this PR.
  3. **Bug A, a narrower pre-existing residual found during implementation
     review** — `idsKnownBeforeThisRun` (an id already stored under this
     feed's provenance from a PRIOR sync) short-circuits unconditionally,
     before the signature registry ever runs: `duplicateByExternalId++` and
     `continue`, regardless of content signature. If SimpleFIN ever
     reissued an id ACROSS two separate syncs (not within one response —
     that is Bug A's own scope) for what is really a DIFFERENT real
     transaction, that new transaction would be silently absorbed as an
     ordinary duplicate, with no warning — the identical anomaly Bug A now
     warns about explicitly, just one sync apart instead of within one
     response. Not fixed here: closing it would mean re-evaluating an
     already-known id's signature on every ordinary sync, a materially
     larger and differently-shaped change than this PR's scope, for a case
     with the same zero-evidence status as the other two residuals above.

### Design — Bug A: signature-aware collapse, no swap

**Collapse ONLY on an exact signature match.** A per-response
`Map<string /* externalId */, Set<string> /* processed signatures */>`
records every occurrence's content signature the moment it is evaluated —
BEFORE the promotion/content-budget check, and regardless of whether that
check ends up dropping it. (This is the round-3 correction: recording only
STAGED rows' signatures is not enough — a content-dropped first occurrence
never reaches `entry.rows`, so a second, identical occurrence would
wrongly see "nothing processed yet" and get independently re-evaluated
against an already-spent budget, reproducing the same bug through a
different path.) When a within-response duplicate's signature EXACTLY
matches one already recorded for that external_id, it is dropped silently,
today's exact behavior, no new state beyond the signature registry.

When a duplicate's signature genuinely DIFFERS from every signature already
recorded for that external_id (the actual anomalous case — two dates for
one id), it is NOT collapsed. It runs through the identical
promotion-candidate / content-budget check any ordinary row gets, using ITS
OWN real signature — safe, because a distinct signature cannot double-spend
the budget slot an earlier, different-signatured occurrence already
consumed. If unmatched, it is pushed to `entry.rows` carrying the SAME
`externalId` as the earlier-staged occurrence. `entry.rows` can now
legitimately hold 2+ rows sharing one `externalId`, but only when their
signatures genuinely differ — the identical-repeat case, which the existing
counting machinery already handles, never produces this shape.

**No swap, ever.** Each row keeps its own real date from staging through
every recheck through insert. `recheckContentDedup` (diffs by signature) and
`recheckCutoverAnchor` (`isAfterAnchor` is already a per-row filter) both
already operate correctly and independently per row when 2 rows happen to
share an `externalId` with different signatures.

**Generalizing the drop-accounting machinery — the real scope growth, and
where it actually reaches (round 3 found more of it than round 1 knew
about).** Four producers currently report a drop as `Set<string>` of
external ids, all of which need to become row-identity-based
(`Map<number, StagedRow[]>` or equivalent) so a straddling pair's ONE actual
dropped row is counted as 1, not silently folded into a same-id survivor and
reported as zero:
1. `recheckLandedIds`
2. `recheckContentDedup`
3. `recheckCutoverAnchor` — needs more than a container-type change: its
   current derivation computes the dropped set as "all ids minus SURVIVING
   ids" (`sync.ts:2514-2516`), which for a straddling pair reports ZERO
   dropped (the id is still present among survivors, since the pair shares
   one external_id). This must become a direct row-identity subtraction
   (which specific ROWS failed `isAfterAnchor`), not an id-set difference.
4. `lateContentDropsByAccountId` — the write loop's own inline "fallback
   content check" (`sync.ts:1607-1628`), missed in round 1's scope: it feeds
   `applyDedupPruning` on both the success and `NothingVerifiedError`
   rollback paths and separately decrements `verifiedTotal`
   (`sync.ts:1508`, `1692`). Needs the identical conversion.

`applyDedupPruning`'s count decrement becomes `droppedRows.length`, not a
`Set.size` of ids. `expectedCardExternalIds` correctness (round 3
correction): an id can be legitimately expected via TWO populations that
never enter `entry.rows` at all — a row already known before this run
(`idsKnownBeforeThisRun`) and a row dropped by ordinary id/content match —
so the fix is NOT "intersect with final survivors" (which would erase a
legitimate expectation that was never staged in the first place). It is:
remove an id from the expectation set only when every row that WAS staged
under it failed to survive AND the id wasn't independently expected via one
of those other populations. `written`'s return shape and the rollback
path's discarded `cutoverChecked`/`contentChecked` intermediates need to
thread final survivor identity through explicitly rather than being
reconstructed after the fact.

**Insert-time identity guard — still needed, for the 2-survivor anomaly
only.** A transaction-scoped `Set<string>` keyed `` `${feedId}:${externalId}` ``,
checked before BOTH the ordinary INSERT and `tryPromoteCandidate`'s UPDATE
(closing round 1's finding: a repeated id must not claim identity twice via
either write path — one occurrence promoting a pending candidate while its
sibling reaches an ordinary INSERT still violates the unique index). The
claim is recorded only AFTER a successful INSERT or promotion, never after a
failed promotion attempt (round 3 correction — a failed promotion attempt
must fall through to the ordinary insert path exactly as
`tryPromoteCandidate`'s existing contract already requires, unblocked by a
premature claim). First successful claim wins; a later claim for the same
key is skipped with a warning, folded into `duplicateByExternalId`, and
must reduce `verifiedTotal` and the per-account `insertedCount` the same way
every other late drop does — reachable now only for the genuine anomaly,
since every routine case is already resolved before the write loop starts.

### Design — Bug B: `recheckReissuedIds`

New sibling recheck, same family as `recheckLandedIds` / `recheckContentDedup`
/ `recheckCutoverAnchor`, added to both the write path and the
`NothingVerifiedError` rollback path in the same position (after
`recheckContentDedup`, before `recheckCutoverAnchor`, so a row that is both
a reissued-id race AND genuinely pre-cutover gets one warning, not two
contradictory ones, matching the existing content-then-cutover chaining
precedent).

**Staging (new, small addition):** for every linked account, BEFORE
`await fetchAccounts` (not alongside the post-fetch `originalContentBudget`
capture — this timing is what makes the recheck actually cover the
reproduced race, where the concurrent write lands DURING the fetch), query
`SELECT id, external_id FROM transactions WHERE accountId=? AND
simplefin_source_account_id=feedId AND date >= floorIso` and freeze the id
set as `originalSameFeedRowIds` on the (soon-to-be) `Staged` entry.

**Recheck (`recheckReissuedIds(staged, db)`):** re-run the same query with
`date, amountCents, rawMemo` added, inside the write transaction. Filter to
rows whose `id` is NOT in `originalSameFeedRowIds` — same-feed rows that
appeared strictly during this sync's own fetch window (only a concurrent
writer can produce one; this sync hasn't inserted anything yet at this point
in its own transaction). Build a `Map<signature, count>` from these
newly-appeared rows, mirroring `recheckContentDedup`'s own `deltaRemaining`
decrement-per-match exactly (multiset-safe — one newly-appeared row
eliminates at most one incoming row, never every incoming row sharing its
signature). Skip any row carrying `promotionCandidateId`, mirroring
`recheckContentDedup`'s own established exemption for the same reason.
Reuses `applyDedupPruning(..., "duplicateByContent")` — this IS a
content-based duplicate find, just from a different candidate population.

**Warning text**, distinguishable from `recheckContentDedup`'s own: "N
transaction(s) on "X" matched a transaction already confirmed under a
different id while this sync was running, so it/they were skipped."

**No `recheckLandedIds` cross-check** (considered in an earlier revision,
removed) — whether to exclude a newly-appeared row already "used" by
`recheckLandedIds`'s own id-race drop doesn't actually prevent a real bug:
the underlying DB row is a fact regardless of what happened to some other
incoming occurrence of its own id, and excluding it would just as often
wrongly let a genuine reissue through as it would prevent a coincidence.

### What the outside review changed

**Round 1** (against a design that let both occurrences of a duplicate id
flow independently through the ordinary per-row pipeline, and captured
Bug B's snapshot alongside the post-fetch `originalContentBudget`): found
the independent-flow design would regress within-response duplicate
handling once budget is exhausted by the first occurrence; found
`applyDedupPruning` undercounts once 2 rows share one external_id; found
the insert-time guard needed to also cover `tryPromoteCandidate`'s UPDATE
path; found the post-fetch snapshot timing misses the exact race that was
reproduced (the concurrent write lands DURING the fetch); found the
signature match needed multiset-safe consumption; correctly identified that
"drop, don't retag" doesn't fully close a hypothetical permanent reissue.

**Round 2** (against a "collapse always, carry `alternateDates`, swap at
write time" design): found the swap bypasses content dedup, since
`contentSignature` includes date and the swap happens after
`recheckContentDedup` already ran against the pre-swap date; found the
round-1 regression-test citation was invalid — `hasPreExistingManualCardHistory`
(verified by reading it directly, `hasPreExistingManualCardHistory.ts:51-60`)
blocks the WHOLE account's feed processing whenever it carries any manual
row, so the cited test's assertion passes for that unrelated reason, not
because of within-response content-dedup logic (the underlying bug was
independently re-confirmed by hand-tracing a non-card account, so the
design conclusion stood even though the citation didn't); found the
`recheckLandedIds` cross-check for Bug B lacked the data to work and wasn't
solving a real problem; corrected the residual's scope (recurs on every
later sync reporting the new id, not just a one-off hypothetical).

**Round 3** (against the converged "no-swap, signature-aware collapse,
row-identity drop accounting" design): confirmed no wholesale redesign
needed. Found the signature registry must record EVERY processed signature
(including ones that were themselves content-dropped, never reaching
`entry.rows`), not just staged ones — otherwise an identical repeat of an
already-dropped occurrence reproduces the original bug through a different
path. Found `recheckCutoverAnchor`'s own existing drop derivation (surviving
ids subtracted from all ids) reports zero drops for a straddling pair
specifically because the survivor shares the dropped row's external_id —
a genuine bug in code this design was reusing, not just a container-type
mismatch. Found a fourth, previously-missed drop producer
(`lateContentDropsByAccountId`, the write loop's own inline fallback content
check) needing the identical conversion. Corrected the Bug B residual's
window from an unsupported "milliseconds" claim to the actual
`SYNC_TIMEOUT_MS` bound (60s) — the proportionality argument against rule
3's already-accepted risk still holds at the corrected scale (~1/64,800).

### Test plan

- **Bug A — identical-duplicate regression, corrected fixture.** A
  NON-card account (no `hasPreExistingManualCardHistory` interference) with
  an existing differently-provenanced row, and a feed response sending one
  external_id TWICE with IDENTICAL content matching that existing row —
  asserts NEITHER occurrence inserts, `duplicateByContent` incremented by
  exactly 1 (one event, one drop), regardless of which occurrence the
  signature registry happened to process first.
- **Bug A — identical-duplicate where the first occurrence is itself
  content-dropped (round-3 case).** Distinguishes "processed" from
  "staged": the first occurrence matches an existing row and is dropped
  before ever reaching `entry.rows`; the second, identical occurrence must
  still be recognized as already-processed and dropped too, not
  independently re-evaluated against an already-spent budget.
- **Bug A — core cutover repro**, no swap: anchor `2026-08-20`, occurrences
  dated `2026-08-15`/`2026-09-01`, same external_id — the post-anchor
  occurrence inserts under its own real date, the pre-anchor occurrence
  drops as `skippedBeforeAnchor`, with `insertedCount`/`expectedCardExternalIds`
  both correct for exactly 1 dropped row (not silently 0 via an id-set
  difference — the round-3-caught bug).
- **Bug A — TWO dropped occurrences sharing one id** (distinguishes
  `Set.size` from `StagedRow[].length`, per round 3 — a test with only one
  drop cannot tell the fixed code from the old, buggy one by coincidence).
- **Bug A — non-card account, duplicate id, differing dates** (no cutover
  filter ever runs): both occurrences reach the insert loop; the
  insert-time identity guard keeps exactly one, warns, increments
  `duplicateByExternalId`, and correctly reduces `verifiedTotal`/
  `insertedCount`.
- **Bug A — promotion-vs-insert identity race**, both orderings
  (promotion-first, insert-first) and a failed-promotion-then-survivor
  case: the identity claim is recorded only after a successful write, never
  after a failed promotion attempt.
- **Bug A — `expectedCardExternalIds` correctness** for an id that was
  never staged at all (`idsKnownBeforeThisRun`) alongside a straddling pair
  in the same run — the never-staged id's expectation must survive
  unaffected by the pair's own accounting.
- **Bug B — core repro, corrected timing**: the concurrent write happens
  during `await fetchAccounts` itself (not merely between staging and
  write), proving the pre-fetch snapshot actually covers the reproduced
  window.
- **Bug B — multiset guard**: two newly-appeared same-feed rows against two
  incoming rows sharing one signature — both incoming rows are correctly
  matched and dropped (not one drop wrongly absorbing both incoming rows,
  and not a bare set-membership check treating the pair as one match).
- **Bug B — promotion exemption**, mirroring `recheckContentDedup`'s own.
- **Bug B — rollback-path equivalent**, using a still-linked account whose
  OWN reissue drop is what causes `NothingVerifiedError` (an
  all-link-dropped setup excludes accounts before any recheck runs and
  cannot exercise this path).
- **Ordering/interaction**: a row that is both a reissued-id race match AND
  genuinely pre-cutover — exactly one warning fires, matching the existing
  content-then-cutover precedent test shape.

### What already exists (reused, not rebuilt)

- `contentSignature` (`src/lib/contentSignature.ts`) — unchanged, reused for
  both the signature registry (Bug A) and `recheckReissuedIds`'s multiset
  match (Bug B).
- `recheckContentDedup`'s `deltaRemaining` decrement-per-match shape — the
  exact multiset algorithm `recheckReissuedIds` mirrors, not reimplements.
- `applyDedupPruning` — generalized (row-identity instead of id-Set), not
  replaced; every existing caller's call SHAPE is unchanged.
- `isAfterAnchor` (`src/lib/accounts/isAfterAnchor.ts`) — unchanged;
  `recheckCutoverAnchor`'s per-row filter already does the right thing once
  fed rows with distinct signatures, no change to the eligibility test
  itself.
- The `NothingVerifiedError` rollback path's existing rebuild-every-recheck
  discipline — `recheckReissuedIds` slots into the SAME pattern
  `recheckLandedIds`/`recheckContentDedup`/`recheckCutoverAnchor` already
  established there, not a new mechanism.
- `AnyDb`/`SyncTx` dual-use typing — every new/changed function follows the
  same structural-generic `T extends {...}` pattern the three existing
  rechecks already use, per rule 11's own `_DB_IS_NOT_A_TX` discipline.

### Data flow — Bug A (per account, per external_id group)

```
feed response, one account
        │
        ▼
 for each txn (posted only) ──► seenExternalIds.has(id)?
        │                              │
        │ no                           │ yes
        ▼                              ▼
  record signature in          idsKnownBeforeThisRun.has(id)?
  registry[id] (ALWAYS,        (pre-existing DB row, ordinary case)
  before matching)                │              │
        │                        yes             no (within-response dup)
        ▼                         │              │
  promotion/content-budget        ▼              ▼
  check (as today)          duplicateByExternalId   registry[id].has(thisSignature)?
        │                   (drop, unchanged)         │            │
   ┌────┴────┐                                       yes           no
   │matched? │                                        │            │
   yes       no                                       ▼            ▼
   │         │                                     drop, no    independent
   ▼         ▼                                     new state   promotion/budget
 drop    push to entry.rows                                    check using ITS
(as today)  (may now share an                                  OWN signature
            externalId with an                                       │
            earlier row in this                                 ┌────┴────┐
            group, iff signatures                                matched? │
            differ)                                              yes    no
                                                                   │      │
                                                                   ▼      ▼
                                                                 drop  push (shares
                                                                       externalId,
                                                                       different sig)

        write transaction (fresh anchor known here)
        ────────────────────────────────────────────
        recheckLandedIds → recheckContentDedup →
        recheckReissuedIds → recheckCutoverAnchor
        (each now row-identity-aware; a straddling
        pair's pre-anchor row drops, post-anchor
        row survives, using ITS OWN real date)
                     │
                     ▼
        insert-time identity guard (feedId:externalId)
        — only reachable if 2+ rows for one id BOTH
        survived every recheck (genuine anomaly):
        first claim (INSERT or promotion UPDATE) wins,
        later claim warns + counts as duplicateByExternalId
```

### Failure modes

| Codepath | Realistic failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| Signature registry misses a content-dropped first occurrence | Reintroduces the original duplicate-content bug through a new path | Yes (round-3 test above) | N/A — correctness fix | Silent if untested; correct+silent if tested (matches existing dedup UX) |
| `recheckCutoverAnchor`'s own id-set-difference drop derivation | Under-reports drops for any straddling pair, corrupting `insertedCount` | Yes (two-dropped-occurrences test) | N/A — bookkeeping | A wrong number on `/sync`'s summary; no data loss, but a misleading count |
| Insert-time guard checked but not recorded until after write | A promotion that FAILS still lets a same-id INSERT through the guard | Yes (failed-promotion-then-survivor test) | Falls through to ordinary insert, by design | Correct row lands; no user-visible symptom |
| `recheckReissuedIds` pre-fetch snapshot query fails/times out | Sync fails open — no per-account isolation exists for a snapshot query failure today either (matches existing risk profile of every other staging-time query) | Not newly tested — same risk class as existing staging queries | Existing per-sync error handling (outcome returned as state, never thrown, per the file's own doctrine) | A failed sync reports failure, not a silent partial result |
| Genuine 2-survivor anomaly (Bug A) | A real SimpleFIN id collision between 2 distinct transactions | Yes | Deterministic pick + warning, never silent | Warning naming the account; one transaction visibly missing, explained |
| Permanent reissue (Bug B residual) | An id change that isn't a race artifact keeps re-duplicating | Not tested (out of scope, disclosed) | None — accepted residual | A duplicate row on a later sync, same as today's status quo |

No critical gap (untested AND unhandled AND silent) survives this design —
the two residuals are both handled (deterministic pick, or accepted
degrades-to-today's-behavior) and both disclosed, not silent-and-untested.

### Worktree parallelization strategy

Sequential implementation, no parallelization opportunity — every task (T1
through T5) touches the same single file (`src/lib/simplefin/sync.ts`) and
its one test file, with T2 (drop-accounting generalization) as a hard
prerequisite for T1's collapse logic and T3's insert-time guard to be
verifiable at all.

### NOT in scope

- Re-tagging the existing row's `external_id` on a Bug B match.
- Any change to `queryContentDedupCandidateRows`'s existing steady-state
  candidacy predicate — both accepted residuals above depend on it staying
  exactly as-is.
- A fully general "N occurrences, arbitrary field differences" resolution
  for Bug A — scoped specifically to occurrences differing in DATE (what
  was reproduced); an occurrence differing in amount/memo behaves as today
  (first-processed wins), unmeasured and out of scope.
- TODOS.md's separate P4 (`/sync` vs `/import/success` count-display
  mismatch on a promotion) and P3 (stale `transfer_pair_rejections` row
  surviving a promotion-undo) residuals — unrelated mechanisms, the latter
  explicitly deferred pending a product decision.

## Implementation Tasks (PR2)

- [x] **T1 (P1, human: ~2h / CC: ~30min)** — signature registry + collapse
  logic in the staging loop (Bug A). Files: `src/lib/simplefin/sync.ts`.
- [x] **T2 (P1, human: ~4h / CC: ~1h)** — generalize drop accounting to
  row-identity across all four producers (`recheckLandedIds`,
  `recheckContentDedup`, `recheckCutoverAnchor`'s own derivation fix,
  `lateContentDropsByAccountId`) plus `applyDedupPruning` and
  `expectedCardExternalIds` correctness. Files: `src/lib/simplefin/sync.ts`.
- [x] **T3 (P1, human: ~2h / CC: ~30min)** — insert-time identity guard
  covering both INSERT and `tryPromoteCandidate`'s UPDATE. Files:
  `src/lib/simplefin/sync.ts`.
- [x] **T4 (P1, human: ~3h / CC: ~40min)** — `recheckReissuedIds`: pre-fetch
  snapshot, multiset-safe write-time recheck, both call sites (write path +
  rollback path). Files: `src/lib/simplefin/sync.ts`.
- [x] **T5 (P1, human: ~4h / CC: ~1h)** — full test suite per the Test plan
  above. Files: `src/lib/simplefin/sync.test.ts`.

### Implementation review (2026-09-19, `/feature-dev`)

Three specialist review agents ran in parallel against the actual diff
(silent-failure-hunter, code-simplifier, pr-test-analyzer) — the first
implementation-level review this design received, as opposed to the three
design-level Codex rounds above. All three independently verified `tsc`
clean and the full suite green before reviewing. Findings, all fixed in the
same pass:

- **Correctness-adjacent (code-simplifier, independently confirmed
  not-currently-live by silent-failure-hunter):** `finalizeExpectedCardExternalIds`
  ran before the write loop's own two late-drop mechanisms
  (`lateContentDropsByAccountId`, `lateIdentityDropsByAccountId`) populated
  — correct today only because of two invariants living elsewhere (a late
  content drop can only ever be a promotion-candidate row, asset-only by
  construction; a late identity drop always shares its id with a surviving
  sibling), not because the code enforces it. Moved to run after both, on
  both the write path and rollback path, computing final survivorship by
  actually subtracting the late-dropped rows.
- **Re-opened hazard (code-simplifier):** a second, independent
  `isoDaysAgo(MAX_LOOKBACK_DAYS, now)` call for the pre-fetch snapshot
  agreed with the staging loop's own `contentFloorIso` only because both
  passed the same `now` — exactly the "agree by coincidence, not by
  construction" shape `Staged.contentFloorIso`'s own docstring says this
  file already fixed once. Hoisted to one call, threaded through both.
- **DRY (code-simplifier):** `lateIdentityDropWarnings` was a byte-for-byte
  copy of `lateContentDropWarnings` with one sentence swapped; the
  `recheckReissuedIds` consumption loop duplicated `recheckContentDedup`'s
  verbatim, including its promotion-exemption as an uncommented second
  implementation. Extracted `lateDropWarnings`/`consumeBySignature` shared
  helpers (the mechanical half only — each recheck's own DECISION, i.e.
  which signatures populate the budget, stays separate, per this file's
  established line for what `applyDedupPruning` shares vs. what it doesn't).
  `seenExternalIds` (a live, mutated Set) was also removable entirely once
  `processedSignaturesByExternalId` existed — verified logically equivalent
  before removing.
- **Critical test gap (pr-test-analyzer):** this plan's own Failure modes
  table cited a "failed-promotion-then-survivor" test as existing
  evidence for its "no critical gap survives this design" claim — it did
  not exist. Added, along with the reverse ordering (insert-first blocks a
  later promotion attempt entirely, candidate left stranded pending) and a
  card-specific genuine-2-survivor-anomaly test (the non-card case doesn't
  exercise `expectedCardExternalIds`/D8.4 interaction at all).
- **Test gap (pr-test-analyzer):** no test for Bug B's own "exactly one
  warning" ordering guarantee (reissued-id-and-pre-cutover), the same
  ordering-regression class the pre-existing content-vs-cutover test
  guards against for an older pairing. Added. Also added: a write-path
  (commit, not rollback) exercise of `written.reissuedDroppedByAccountId` —
  every original Bug B test happened to land on the rollback path.
- **Documentation-only (silent-failure-hunter):** a narrower, pre-existing
  residual — an id reissued ACROSS two separate syncs (not within one
  response) for a genuinely different transaction is silently absorbed by
  `idsKnownBeforeThisRun`'s unconditional short-circuit, with no warning.
  Recorded as a third named residual above; not fixed (same zero-evidence
  status as the other two, and closing it needs a larger, differently-shaped
  change).

Two review-time findings were caught and self-corrected before being
reported as fixed: an initial test for the identity guard used an
incorrect Unix timestamp (mapping to 2026-08-09, not the intended
2026-08-15), and a mutation-testing spot-check confirmed the guard's
"claim only after a successful write" ordering doesn't currently produce
an observably different outcome in this file's single-threaded, sequential
per-row loop (each row's own promotion-or-insert fully resolves before the
next row starts) — kept as a defensive, correctness-by-construction
invariant per round 3's own reasoning, not because a test demonstrates an
observable bug from getting it wrong today.

`pnpm exec tsc --noEmit`, `pnpm lint`, and the full project test suite
(2292 → 2307 tests) all pass. Two of the highest-value regression tests
(the `recheckCutoverAnchor` row-count fix and the Bug B pre-fetch-timing
fix) were independently verified by temporarily reverting each fix and
confirming the corresponding test fails, then restoring it.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Outside Review | Codex CLI, automatic | Independent 2nd opinion | 3 | issues_found → converged | Round 1: 6 findings (independent-flow content-dedup regression, `applyDedupPruning` id-vs-row counting, promotion-path identity gap, post-fetch snapshot timing miss, non-multiset match, residual scope). Round 2: 5 findings (date-swap bypasses content dedup, invalid test citation — verified by reading `hasPreExistingManualCardHistory` directly, unneeded cross-check removed, corrected residual scope). Round 3: 4 findings (signature registry must record dropped-not-just-staged occurrences, `recheckCutoverAnchor`'s own id-set-difference derivation undercounts, a 4th missed drop producer `lateContentDropsByAccountId`, residual window corrected from an unsupported "milliseconds" claim to `SYNC_TIMEOUT_MS`). Round 3 verdict: "no wholesale redesign is needed." |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open (resolved) | 2 architecture issues raised and resolved via `AskUserQuestion` (Bug A tie-break design; Bug B race-scoping design), plus a user-directed scope expansion (bundle both bugs into one PR, overriding the reviewer's initial split recommendation) and one accepted-lower-completeness call (drop rather than re-tag on a Bug B match). 0 code-quality or performance findings beyond the architecture decisions themselves. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run — backend-only change, no UI surface |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **OUTSIDE COVERAGE:** provider `codex`, phase `plan-review`, 3 completed
  passes (rounds 1–3), each finding real, confirmed structural issues in the
  prior round's design — verified independently against the live code and
  test suite before being accepted, not taken on faith. Round 3 explicitly
  reported no remaining need for a fourth round.
- **CROSS-MODEL:** No disagreement between the native review and the outside
  voice at any round — every Codex finding was independently verified
  against the actual source (line-level citations checked, one citation
  found genuinely wrong for an unrelated reason — `hasPreExistingManualCardHistory`
  — but the underlying defect it was cited for was independently
  re-confirmed by hand-tracing, so the design conclusion stood even though
  the specific test reference didn't) and incorporated rather than disputed.
- **VERDICT:** ENG REVIEW CLEARED (design converged after 3 outside-review
  rounds, 0 unresolved decisions) — implementation not yet started. This PR
  is design-locked, not shipped; `/ship`'s own review gate applies
  separately once T1–T5 are implemented.

NO UNRESOLVED DECISIONS
