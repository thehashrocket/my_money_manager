# Credit card transaction import (Citi), and the accounting cutover it needs

**Status:** IN PROGRESS (2026-09-09). Two stacked PRs; see "Delivery" below.
**Branch:** `thehashrocket/mortgage-card-txn-import-review`
**Ask:** "are we at a point where we can start importing mortgage and credit
card transactions now?"

Produced by `/plan-eng-review` (4 sections + an outside voice) on 2026-09-09.
Twenty-nine decisions, all resolved. This file is the record, because the
decisions are mostly about what NOT to build and that is the part a diff
cannot show.

---

## The answer to the question

**Mortgage: no, but this is the loan being NEW, not the feed lacking the
capability — corrected after this section first shipped.** The live feed was
probed on 2026-09-09. `Fixed Rate 1st Mortgage (#173)` returns **0
transactions over an 89-day window** while reporting a current balance of
exactly −$408,900.00. The first draft of this document read that as "there is
nothing on the other end of the pipe" and closed the question permanently.
That conclusion was wrong, and the evidence for the correction was sitting in
the same measurement: a balance that round is an origination principal, not
an amortized one; `prior_starting_balance_cents` equals `starting_balance_cents`
(the anchor has never moved); and zero of 1,581 checking/savings rows back to
2025-12-31 carry a mortgage/loan/escrow/principal memo. The loan was
originated in the last 1-2 weeks and has had no payments post — 0 rows is its
age, not Star One withholding loan transactions. Whether Star One exposes
loan transactions at all remains **genuinely unknown** and is only testable
once the first payment posts.

E1's double-count argument (importing interest/escrow/principal rows would
double-count a payment already budgeted on the checking side) is unaffected
by this correction and remains the reason `importsTransactions` returns
`false` for a loan today — that reasoning does not depend on why the feed
currently reports zero rows. What changes is the CERTAINTY claim: this is not
a closed question, it is an untested one, and revisiting it after the first
mortgage payment posts is the correct next step rather than a reopened
decision.

**A consequence worth acting on separately:** `accounts.prior_starting_balance_cents`
holds exactly one prior value, not a series (rule 9), and the sync balance
pass overwrites it every run. A brand-new mortgage sitting at its origination
principal is the only moment a complete balance/amortization history could be
started from — every sync after the first payment loses that starting point
permanently, since the mortgage has no transaction rows to reconstruct it
from (D3=A). This is a real, time-sensitive gap; see the TODOS.md entry.

**Cards: yes for Citi, and it is smaller than every document in this repo
claims.** Citi returns 9 transactions over 89 days with **0 pending**, feed
ids present on every row. Two of the three blockers `TODOS.md` names against
this work evaporate against real data.

**But not for AMEX or Bank of America**, which are not on the SimpleFIN feed
at all and never will be. Four accounts are on the feed: three Star One plus
Citi.

## The measurement that reframed it

Queried against the live container, 2026-09-09:

| merchant key | rows | total | category | paired |
|---|---|---|---|---|
| `AMEX EPAYMENT ACH PMT` | 7 | −$1,774.86 | uncategorized | 0 |
| `BANK OF AMERICA PAYMENT` | 6 | −$1,100.00 | uncategorized | 0 |
| `CITI CARD ONLINEPAYMENT` | 4 | −$1,120.00 | uncategorized | 0 |
| `BANK OF AMERICA BILL PAY` | 1 | −$300.00 | uncategorized | 0 |

**$4,294.86 across 8 months, 18 rows, every one uncategorized and unpaired** —
roughly $537/month of real money leaving checking that reaches no envelope.

Full Citi transaction import attributes **$1,120 of $4,294.86, i.e. 26%**.
The other 74% is reachable only by categorizing the payments. So the two
treatments cover **disjoint sets of cards** and were never alternatives:

- **Phase A** — file the card payments as spend. All three cards. No code.
- **Phase B** — import Citi's transactions. One card. This plan.

Phase A is a prerequisite in one direction only: the A-filed payments become
harmless once B pairs them, because `transfer_pair_id IS NOT NULL` excludes a
row from every spend query regardless of its category.

## What already exists, and is reused unchanged

| Existing | Status |
|---|---|
| Every spend query (`loadSpendForMonth`, `computeMtdSpent`, the rollover prefix scan, `loadMonthlyTrends`) | **Reused as-is.** None filters by account or account class, so a categorized card charge enters its envelope with zero query changes. The read side was already done. |
| `linkTransferPairManually` cross-date support | **Reused; was going to be rebuilt.** Its date guard sits INSIDE the `a.accountId === b.accountId` block (`sync.ts:1565-1584`), so a cross-account pair is already date-unchecked. D8.2 replaced a new fuzzy matcher with an entry point onto this. |
| `partitionLinkedAccounts`' partition-not-filter structure | **Extended, not replaced.** Liability ids stay in `accountIds` for the single `fetchAccounts` call (E2). |
| Partial unique index on `(simplefin_source_account_id, external_id)` | Reused. Citi dedup needs no new index and no new column. |
| `findLinkedTransferPairs` | Reused. It filters `NOT_MANUAL`, so a pair of two REAL rows appears in `/sync`'s "Linked pairs" list with a working "Not a transfer" button. The unlink path for a hand-linked card payment already exists. |
| `createCardActivity`'s anchor refusal (`manualTransaction.ts:250`) | **Promoted to a shared predicate.** D8.1's cutover is the same comparison; see D-CUT. |
| `undoSyncBatch`, `createSnapshot`, `pruneSnapshots` | Reused. Citi's first import is undoable and pre-snapshotted for free. |
| `accountClass` / `isCreditCard` / `isLongTermLiability` / `hasAnyTransactionRows` | Reused. A fifth sibling predicate joins them rather than a fourth inline derivation. |
| `resolveBalanceAction` / `resolveUtilizationDisplay` / `resolveStalenessDisplay` | Reused as the SHAPE for `resolveCardAffordances`. |
| `TODOS.md`'s proposed `resolveCardAffordances` | **Closed by this plan**, not added to. |

---

## Decisions

| # | Decision | Chosen | Why |
|---|---|---|---|
| D1 | Mortgage transaction import | **No for now; genuinely untested, not closed** | Feed returns 0 rows over 89 days, but the loan was originated 1-2 weeks ago with no payments posted — 0 rows is age, not a proven capability limit. Corrected 2026-09-09 after this document first shipped the wrong conclusion (see "The answer to the question"). Revisit after the first mortgage payment posts. `importsTransactions` still returns `false` for a loan today, on E1's independent double-count argument. |
| D2 | Card treatment | **Phase A + Phase B, A first** | They cover disjoint card sets. A is an hour and reaches $3,174.86 the feed cannot see. |
| D3 | Which cards import | **Feed-linked cards only** | AMEX/BofA are not on the feed and are not accounts. |
| D5.1 | The importing-card predicate | **`importsTransactions(account)` in `src/lib/accounts/`** | Rule 9 says do not add a second independent derivation. This is the fifth sibling, exhaustive switch, totality test — `isCreditCard.ts`'s exact shape. |
| D5.3 | `BANK OF AMERICA BILL PAY` | **Check the raw memo before filing** | 1 row, different normalized key from its sibling. Rule 6: a rule trained on a guess is silent forever. |
| D5.4 | Envelope shape | **One "Credit Card Payments" category** | Phase B shrinks it rather than emptying a dedicated Citi envelope to $0, and rule 8 would then lock that envelope's kind. |
| D4.3 | The permanent `has-rows` warning | **Partition so importing cards never enter `balanceOnlyAccounts`** | Structurally impossible to fire, rather than suppressed. A permanent warning is one people learn to skip. |
| **D8.1** | **The accounting cutover** | **Hard cutover at the card's anchor: import only rows dated strictly after it** | **The one critical gap.** Phase A files payments as spend in Jun/Jul/Aug; without this, Phase B imports charges into those same months and bills the same dollars twice. Aligns with rule 1's strict `>` so imported rows and the balance sum agree by construction, and no historical month ever changes. |
| D8.2 | Card-payment pairing | **Manual cross-date entry point; NO fuzzy matcher** | Measured offsets 1, 3, 1, 1 days — zero of four would auto-pair on `(date, |amount|)`. But `linkTransferPairManually` already accepts cross-date cross-account pairs, so the missing piece was an entry point, not an engine. Supersedes D4.2 and D6.2. |
| D8.3 | The synthetic mirror trap | **Refuse mirror creation on an importing card** | `markAsCardPayment` fabricates a card row dated from the CHECKING leg with an invented memo. The real Citi credit arrives on a different date with a different memo, so content dedup cannot collapse them and the card shows the payment twice. Made unrepresentable, not warned about. |
| D8.3b | The identical trap on `createCardActivity` | **Refuse a hand-typed charge/refund on an importing card too** | Found in implementation review, not the original transcript: a hand-typed charge's `rawMemo` is the user's own text, not the bank's, so the same content-dedup mismatch that motivated D8.3 applies to an ordinary "Add a charge" entry once a card imports. Not a warning — unlike D4.1's categorized-payment case, a hand-typed charge on an importing card has no legitimate reason to exist once the feed reports the same event on its own, so there is no transition it would block. Reconcile stays reachable (D9.2 puts every importing card there regardless), so the account is never left with no way to correct its balance. `_account-row.tsx`'s `canAddCharge` gate was extended to match, per rule 8 (an offer the server always refuses is worse than an absent one). |
| D-RACE | The cutover anchor read before the fetch `await` | **Re-verify inside the write transaction, AND in the `NothingVerifiedError` rollback fallback** | Found in implementation review: `cutoverAnchor` in the staging loop is read from `linked`, captured BEFORE `fetchAccounts`' round trip — the exact precondition-across-an-`await` class rule 11 names for the link and the id-dedup pass beside it, missed on the first pass of this same change. A hand Reconcile landing in another tab during the fetch moves the anchor forward; without a re-check, a row legitimately staged against the OLD anchor could insert on-or-before the NEW one — reproducing D8.1's own "inconsistent state" through a race instead of an ordinary sync. `recheckCutoverAnchor` (`sync.ts`) is dual-use (`AnyDb`, the same idiom `hasAnyTransactionRows` uses) so ONE function serves both the in-transaction success path and the read-only rollback path, rather than two hand-written copies drifting apart the way `verifyStagedLinks`/`verifyStagedLinksReadOnly` already had to be kept in sync by hand. |
| D-D8.4FIX | D8.4's false positive on correct dedup | **Never add a content-deduped id to `expectedCardExternalIds`** | Found in implementation review: the original D8.4 implementation tracked every non-excluded feed transaction id regardless of how dedup resolved it, including ids matched by CONTENT (a hand-entered charge, or a row tagged under a re-minted feed id, rule 3). Those rows genuinely land — that IS correct dedup — but under a DIFFERENT row's provenance, which will never carry the new feed's external id. The original design reported this as "missing" on every ordinary case of that dedup path succeeding, permanently (reloading never clears it). Fixed at the source: a content-dedup match is never added to the expected-id set in the first place. |
| D-DUPID | Within-response duplicate external id | **Only push into `expectedCardExternalIds` on `duplicateByExternalId` if the id was in the DB BEFORE this run** | Found by a red-team pass on D8.4's own fix: `seenExternalIds` is a live Set the staging loop mutates, so a SECOND occurrence of the same id in one feed response read as "already known" purely because the FIRST occurrence added it moments earlier — even when that first occurrence was itself correctly dropped by content-dedup and never written under this feed's tag. Fixed with a frozen pre-loop snapshot (`idsKnownBeforeThisRun`); the live set still does its original job (catching within-response and DB duplicates), only the D8.4 "findable" inference was narrowed to the case that's actually true. |
| D-WARNFLUSH | Omitted-account warning lost on the up-to-date path | **Flush `accountWarnings` before the `totalToInsert === 0` early return too** | Found by Codex adversarial review: `accountWarnings` (e.g. "SimpleFIN returned nothing for X") was only ever flushed on the write-commit path (`verifyStagedLinks`), never on the up-to-date early return — a dead connection for an account with nothing new to insert reported a clean "up to date" with no warning. Pre-existing for ASSETS before this plan touched the file; newly reachable for CARDS because a linked card's connection can now break too. |
| D-MARKPAY-ORDER | D8.3's refusal ran before E10's idempotency check | **Move the `importsTransactions` refusal to AFTER the idempotency re-read** | Found by Claude adversarial review: a double-submitted `markAsCardPayment` request for a pairing that ALREADY existed (created before the card started importing) returned "would count the payment twice" instead of E10's correct "already recorded" no-op success — misleading for a request that changes nothing. D8.3 only needs to fire for a genuinely NEW write. |
| D-INVESTIGATE | Pre-existing manual history at cutover | **Documented, not fixed — user decision 2026-09-09** | Found independently by three adversarial passes (cross-model agreement: a Claude subagent, Codex exec, Codex structured review): a card's manual history from BEFORE it was linked is neither reconciled nor guarded at the moment it starts importing, and would double-count if any exists. Does not affect this ship — Citi's live manual-row count is 0. A real fix needs its own design pass (refuse vs. warn, how a user clears the condition) — tracked as a P1 TODO, deliberately not built under ship pressure. |
| D8.4 | Completeness monitor | **Compare the feed's `external_id` SET against stored ids** | A COUNT comparison diverges on every ordinary resync, because dedup legitimately drops rows it has already seen. A set diff is resync-stable and names WHICH row is missing. |
| D9.1 | Citi's opening balance | **Reconcile by hand once at cutover** | The feed-written anchor came from an INSTANT on 2026-09-08, not a close-of-day figure. Freezing it bakes an unverifiable intra-day error into every future balance. |
| D9.2 | The zero-row linked card's dead Refresh button | **`resolveBalanceAction` consumes `importsTransactions`** | After D4.3 the card is out of the refresh pass, so Refresh would do nothing. One function still owns the balance control; same relay pattern v0.27.0 used to un-nest `CardControls`. |
| D6.1 | Where the card affordance decisions live | **`resolveCardAffordances()` in `src/lib/accounts/`** | Two of these decisions guard money leaving an envelope, and CLAUDE.md rules UI-component tests out of V1 — so in a `.tsx` they are untestable by construction. |
| D4.1 | Pairing a CATEGORIZED source row | **Warn before, do not refuse** | Under Phase B, pairing a categorized payment is the CORRECT action, so a server-side refusal would block the transition Phase B needs. |
| D5.2 | The always-refusing "Not a card payment" item | **Gate it on the pair being app-created** | v0.24.0's `assignableKinds` lesson: a refusal the user can only discover by triggering it is worse than an absent control. |
| D7.1 | Matcher query shape | **One query per run, closure-based** | `transferRejections.ts` already states the rule for the neighbouring matcher. |
| D-CARD | Card rows and the automatic matcher | **Excluded from `linkTransfersByBucket` + `findAmbiguousTransfers`; KEPT in `findSameAccountReversalCandidates`** | See "The exclusion that is not yet an exclusion" below. |
| D-ANCHOR | Reconcile moves the anchor forward | **Warn in the Reconcile form** | Silent and monetary; see "Residuals" below. |
| D-STALE | The permanent amber staleness label | **Accept and document; TODO filed** | Changing `resolveStalenessDisplay` touches a shared classifier read by four surfaces to fix a card-specific effect — the same objection that killed D7.2=A. |

---

## The exclusion that is not yet an exclusion

`matchTransfers` has **zero account-type awareness**, by design, and imports
nothing from `src/lib/accounts/`. Credit-card rows are excluded from it today
only as a **side effect** of `NOT_MANUAL` (`sync.ts:1433`): every row a card
can currently hold is `import_source='manual'`, because CSV import refuses a
liability `accountId` (`assetAccountGuard.ts`, E6/E18) and sync never stages
one (E1).

The moment Citi imports `simplefin` rows, that side effect stops holding and
cards enter the bucket matcher for the first time in the app's life. A Citi
**purchase** could then auto-pair with an unrelated same-day checking deposit
of the same magnitude and vanish from every spend surface, silently. The
counting argument that justifies auto-linking without asking does not defend
against this — the bucket is balanced, so it links.

So the exclusion becomes explicit, in the two queries that feed the automatic
matcher. It is deliberately **not** applied to
`findSameAccountReversalCandidates`: a disputed charge and its provisional
credit on one card is precisely that queue's use case, and that queue never
auto-links.

The stale comment at `matchTransfers.ts:26-32` ("only two accounts ever carry
rows") is updated by the same change. Its third guard stops being dormant.

## Residuals — known, accepted, and written down

**REGRESSION R1 fires, as predicted.** `resolveStartDate` widens to the full
45-day floor whenever any `importAccounts` entry has no history
(`known.length !== latestDates.length`). Citi joins `importAccounts` with zero
rows and — at 1.7 charges/month plus the cutover — may stay row-less for
weeks, so every sync re-runs content dedup over 45 days of checking rows until
Citi's first row lands. Benign (better-sqlite3, synchronous, ~272 rows), one
account, self-healing on the first imported row. Named rather than fixed.

**The reconcile/cutover interaction is silent and monetary.** Every hand
Reconcile pushes the anchor forward, and the cutover then permanently refuses
any feed row dated on or before it. Reconcile on the 20th and an un-imported
charge from the 15th is unreachable forever. This is rule 1's strict `>` doing
exactly its job — the same trade `createCardActivity` documents — but the
Reconcile form now says so (D-ANCHOR). Sync before reconciling.

**Citi's staleness label goes amber and stays amber.** After the D9.1
reconcile the card is `balance_source='manual'` with `balance_as_of=NULL`, so
`resolveStalenessDisplay` reads `starting_balance_date` and paints amber at 35
days — permanently, on an account whose computed balance is current precisely
because imports are maintaining it. This is D4.3's own objection reappearing
on `/accounts` instead of `/sync`. Accepted for now (D-STALE); TODO filed.

**The drift check is often silent on the days it matters most.**
`classifyBalanceFreshness` reports real drift only when the bank's figure is
dated strictly after the ledger's newest row. Citi's `balance-date` and its
newest imported row will frequently be the same day. That is rule 1's
deliberate conservatism, and it is why D8.4's set check exists as a second,
date-independent monitor rather than as a nicety.

---

## NOT in scope

- **Mortgage transaction import.** Untested, not closed — the loan is too new to have measured (D1). Revisit after its first payment posts.
- **AMEX / Bank of America transaction import.** Not on the feed. Phase A is
  the only treatment they get, ever.
- **Historical Citi attribution.** D8.1's hard cutover means Jun–Aug card
  purchases are never imported. Filed in `TODOS.md`.
- **An automatic card-payment matcher.** D8.2 defers it to a manual entry
  point. Filed in `TODOS.md`.
- **Retroactive rewriting of budget months.** Explicitly rejected in D8.1.
- **A debt trend line / payoff modelling.** Still needs a `balance_snapshots`
  table. Unchanged by any of this.
- **`contains`/`regex` rules for card charges.** Rule 10: unrepairable by
  backfill. Exact rules only.
- **Restoring feed-maintained balances for a card that imports.** The two are
  mutually exclusive by rule 1 (E16). This plan picks import.

---

## Delivery

Two stacked PRs, plus a manual pass on the live ledger.

**PR1 — "the feed imports card transactions"**

| Task | What |
|---|---|
| T3 | `importsTransactions(account)` — new predicate + tests |
| T-ANCHOR | `isAfterAnchor(dateIso, anchorIso)` — the ONE spelling of rule 1's strict `>`, shared by the cutover, `createCardActivity` and (in PR2) `resolveCardAffordances` |
| T4 | Three-way partition + **3 mandatory regression tests** |
| T2 | The D8.1 cutover + an acceptance test on per-month monetary totals |
| T5 | `resolveBalanceAction` consumes `importsTransactions` (D9.2) |
| T10 | `external_id` SET completeness check (D8.4) |
| T11 | Card rows out of the automatic matcher (D-CARD) |
| T8 | Refuse synthetic-mirror creation on an importing card (D8.3), widened to `createCardActivity`'s charge/refund path too (D8.3b) and the "Add a charge" UI gate |
| T-ANCHOR2 | Reconcile-form warning (D-ANCHOR) |
| T13 | This file, `CLAUDE.md`, `PLAN.md`, `TODOS.md` |

T8 rides PR1 rather than waiting for its replacement in PR2: otherwise the
duplication trap is live in the gap between merges. Its refusal points at
Phase A ("file it under a category"), which is true in both PRs.

**PR2 — "linking a card payment to the real row"**

| Task | What |
|---|---|
| T7 | `resolveCardAffordances()` (D6.1) — closes `TODOS.md`'s entry |
| T9 | Manual cross-date card-payment link: candidate picker → `linkTransferPairManually` (D8.2) |
| D4.1 | Warn before pairing a categorized source row |
| D5.2 | Gate the always-refusing "Not a card payment" item |

**Manual pass (live ledger)**

| Task | What |
|---|---|
| T1 | Phase A — file 18 card-payment rows, train 4 exact rules, after settling D5.3 |
| T6 | Reconcile Citi by hand once at cutover (D9.1) |

## The three mandatory regression tests (T4)

Not offered as a choice. The describe block
`"syncSimpleFin — liability partition and balance pass (E1/E2, T7)"` holds 9
tests and every one is loan-shaped; its lead assertion is
`"does NOT stage a linked loan's transactions (F9)"`. This plan **inverts that
behavior for cards**, and there is no card-shaped equivalent to invert — an
absence-assertion is only coverage if something in the codebase can make it
present.

1. `DOES stage a linked card's transactions` — the inverse of F9
2. `keeps a linked loan out of transaction staging after the split` — F9 stays green
3. `does not warn has-rows for a card that imports` — proves D4.3 removed the
   noise structurally rather than by suppression

## Failure modes for the new codepaths

| Codepath | Realistic failure | Tested | Silent? |
|---|---|---|---|
| `importsTransactions()` | Returns true for a loan after a type change | Yes | no — totality test |
| Three-way partition | Citi drops out of both lists | Yes (T4) | would be — T4 covers it |
| **Cutover boundary** | **An off-by-one lets one historical charge in** | **Yes — acceptance test on per-month totals** | **would be, and it is money** |
| Card excluded from matcher | A real same-day payment stops auto-pairing | Yes | no — intended (D8.2) |
| `external_id` set check | A content-deduped row (manual entry, re-minted feed id) reported as permanently missing | **Yes — was a real bug, fixed (D-D8.4FIX)** | would have been — every reload, forever |
| **Cutover race** | **A hand Reconcile mid-fetch admits a row that should now be excluded** | **Yes — both the in-transaction and rollback-fallback paths (D-RACE)** | **would be, and it is money — the identical failure the cutover itself prevents, reached via a race** |
| Mirror refusal | Refuses on an unlinked card too | Yes | no — refusal is visible |
| `createCardActivity` on an importing card | A hand-typed charge double-counts against the next sync's posted row | **Yes (D8.3b)** | would be — same class as the mirror trap, found in review |
