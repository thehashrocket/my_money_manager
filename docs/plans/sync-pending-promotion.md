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

## PR2 — cutover-boundary duplicate external_id loss (TODOS.md:3463)

Narrower and compound (needs a genuinely duplicate `external_id` in one feed
response AND that duplicate straddling a card's D8.1 cutover anchor). Sketch
only, to be designed in detail once PR1 lands: prefer, among same-external-id
occurrences within one response, the one that survives cutover under the
*fresh* (post-await) anchor rather than blind array order — using the stale
pre-fetch anchor only as a tie-break signal, not as the decision itself, to
avoid reopening rule 11's read-before-await trap. Needs its own
`recheckLandedIds`-style verification and its own regression tests before
being called done, matching this file's now-established review cadence for
every change in this function.
