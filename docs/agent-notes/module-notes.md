<!-- Extracted verbatim out of CLAUDE.md's `## Layout` section on 2026-09-16 to keep CLAUDE.md itself under Claude Code's 150k-char memory-file limit. Referenced from CLAUDE.md via `@docs/agent-notes/module-notes.md` — Claude Code resolves `@`-imports recursively, so this is purely a relocation, not a change in what any agent session sees. -->

## Layout

```
src/
  app/             Next.js 16 App Router pages + server actions
  app/_components/ Shared RSC components co-located with the app (e.g. BacklogBanner)
  components/      UI components (shadcn in components/ui, ledger/ design-system components)
  components/ledger/action-status.tsx
                   ActionStatus / StatusWarning / warningOf / statusRole / statusTone —
                   the ONE inline status line for a returned-state Server Action, and
                   the renderer for guardRefresh's warning. It takes a STRUCTURAL
                   ActionState ({idle} | {ok, message, warning: string | undefined} |
                   {error, message}) rather than any route's own union, so /accounts,
                   /import, /goals and /budget can all satisfy it with no cast and no route importing
                   another route's private component — the shape four hand-rolled
                   copies had already drifted on. warningOf is where "a warning can
                   only ride on SUCCESS" is spelled once: putting one on error sends a
                   committed write back down the failure branch, which is the whole
                   defect guardRefresh exists to prevent
  components/ledger/remember-checkbox.tsx
                   RememberCheckbox({rememberUi, checked, onChange, reasonId,
                   minTouchTarget?}) — added in v1.3.3, the checkbox `<input>`
                   plus its wrapping `<label>`: the render half of the
                   consolidation resolveRememberUi/useRememberConsent already
                   did for the logic half. Shared by /categorize's
                   _merchant-row.tsx, /transactions' _transaction-row.tsx and,
                   as of the same release, _retarget-form.tsx — the three had
                   already drifted into a third verbatim-structure copy of
                   this exact sub-tree before the extraction. The reason `<p>`
                   below it stays un-extracted on purpose: its layout
                   genuinely differs per caller (a flex-wrap sibling needing
                   `basis-full` on two surfaces, a plain block on the third),
                   which is real per-context difference, not drift.
                   `minTouchTarget` defaults to false rather than being
                   unconditional — only /categorize's row currently gives this
                   checkbox DS66's 44px touch floor (`min-h-11`);
                   _transaction-row.tsx and _retarget-form.tsx don't yet, a
                   pre-existing gap the extraction surfaced rather than
                   introduced (TODOS.md)
  components/ledger/use-remember-consent.ts
                   useRememberConsent(normalizedMerchant, action, pendingCategoryId) —
                   the "Remember" checkbox's consent state, shared as of v1.3.2 by
                   /categorize's _merchant-row.tsx and /transactions'
                   _transaction-row.tsx (then the last verbatim-identical logic left
                   between the two once resolveRememberUi absorbed the verdict
                   derivation itself), and as of v1.3.3 by _retarget-form.tsx too —
                   closing TODOS.md's 2026-09-15 P2, where RetargetForm's checkbox
                   had been the one Remember control on /transactions with no
                   guard at all. Masks `checked` against
                   ruleActionSignature (lib/categorize/keyTrainability.ts) and
                   INVALIDATES on a mismatch rather than merely masking it — a
                   mask-only first version let a re-pick land back on a signature
                   the user had already consented to under a different rule state,
                   silently re-checking the box with no new click (a real,
                   no-crafted-input bug an adversarial review reproduced).
                   consentedSignature is this hook's OWN per-call useState, never a
                   module-level or shared store, so each row keeps its own
                   independent consent exactly as the three components' local state
                   already did — only the CODE moved here, not the state
  db/              Drizzle schema + client singleton
  lib/             Pure functions: parsers, normalizer, categorization, money, utils
  lib/accounts/    loadAccountBalances — live per-account balance queries
                   loadAccountBalancesForRequest — the same, React-cache'd per request
                   listAccounts — {id, name} picker for the /transactions account filter
                   listCardAccounts — cards only, for the "Mark as payment to" row menu
                   listImportingCardAccounts — PR2/T9's exact complement: cards whose
                   OWN transactions come in from the feed, for the "Link to a card
                   charge" row menu. The same importsTransactions split that gets
                   markAsCardPayment's mirror refused on these cards (D8.3) is why they
                   need a different affordance instead of being excluded outright
                   accountClass, isLongTermLiability, isCreditCard, importsTransactions
                   — the four type predicates; nothing re-derives these inline (see
                   rule 9). importsTransactions is NOT "can this account hold rows" —
                   it is "does a SimpleFIN sync stage this account's rows", which is
                   true for a linked asset OR a linked card and false for a loan
                   (probed: the feed returns 0 mortgage transactions over 89 days) or
                   any unlinked account. partitionLinkedAccounts, resolveBalanceAction
                   and markAsCardPayment's mirror refusal all read it rather than
                   re-deriving "linked and not a loan" independently
                   deriveStartingBalance — the CSV anchor derivation itself
                   (rule 1): only writes an anchor when the file's running
                   `Balance` column forms a consistent chain, and only ever
                   moves the anchor forward in time. Full mechanics — the
                   same-day-nets-to-zero ambiguity, the bounds checks shared
                   with validateCreateAccountInput/validateUpdateAnchorInput
                   — are in rule 1, not repeated here
                   isAfterAnchor — the ONE spelling of rule 1's strict `>`, as of the
                   card-transaction-import plan. Three callers: createCardActivity's
                   before-anchor refusal, the sync accounting cutover (D8.1, card rows
                   on or before the anchor are dropped), and _account-row.tsx's
                   chargeableDateExists (canAddCharge's gate) — the third had already
                   drifted from `<=` to a local `<` once with no test catching it, which
                   is why all three read one function now rather than two of three
                   hasAnyTransactionRows — EXISTS with no anchor filter (E16); gates
                   the feed balance pass, Reconcile-vs-Refresh, and paidDownCents.
                   Takes AnyDb rather than Db so the balance pass can re-ask INSIDE
                   its per-account write transaction: a row imported during the fetch
                   window makes the account ineligible, and the answer read before the
                   await could say otherwise (rule 11)
                   summarizeBalances — assets / debt / net worth for /, /accounts, Spine
                   resolveBalanceAction — per-row Reconcile-vs-Refresh, total over its inputs
                   resolveUtilizationDisplay, resolveStalenessDisplay, paidDownCents
                   — "paid down this month" counts positive card rows that are paired
                   ACROSS accounts (rule 9); same-account pairing is a reversal, not a
                   payment
                   manualTransaction — the third write path: hand-entered card activity.
                   createCardActivity writes a charge; removeCardActivity takes it
                   back out, and until v0.27.0 nothing did. It was the only write in
                   the app with no reverse — the sole transaction deletes were
                   undoSyncBatch (a whole batch) and unmarkCardPayment (its own
                   synthetic mirror) — which mattered because ONE row flips a
                   feed-linked card off resolveBalanceAction's `refresh` branch for
                   good (E16). Six guards and one cleanup, and the first two are the
                   ones that matter: confirmedIrreversible (absence is a REFUSAL —
                   there is no undo and no snapshot for this delete, so the
                   confirmation is a fact the SERVER checks, rules 4 and 8) and
                   import_source='manual' ONLY, so a bank row is never deletable
                   here. A paired row is refused and pointed at unmarkCardPayment,
                   because deleting one leg strands the other (E12). The cleanup is
                   the row's import_batches row, scoped to source='manual' so a
                   mis-set import_batch_id can never take a CSV or sync batch — and
                   every other row's provenance — with it. The row menu filters only
                   TWO of the six (not a transfer, import_source='manual'), and TWO
                   of the remaining four — the unpaired payment mirror and not-a-card
                   — are reachable from a RENDERED item rather than only from a stale
                   tab, which is why each names the tool to use instead. The other
                   two, not-found and unconfirmed, name no tool: there is none
                   validateCardTermsInput — credit limit + minimum payment repair
                   resolveCardAffordances.ts — T7 (card-transaction-import plan, PR2):
                   canAddCharge/canEditTerms/showReconcile as ONE pure decision instead
                   of three separately-computed booleans agreeing by hand — the same
                   three-gate combination that regressed twice inside v0.27.0's own
                   review cycles. showReconcile is a straight RELAY of
                   resolveBalanceAction's answer, never a second derivation of it. As of
                   v1.3.4 the same function also returns allowsPositiveBalance (!longTerm)
                   — rule 9's sign guard for the Reconcile form's "You owe"/"You're owed"
                   toggle, relayed through _account-row.tsx/_card-controls.tsx rather than
                   a fourth hand-computed !isLongTermLiability agreeing with this module by
                   hand, the exact drift shape it exists to prevent (found by /ship's
                   pre-landing review). The
                   same module carries D4.1's pairingWarnsOnCategorized (should linking
                   a checking payment to a real card row warn rather than proceed
                   silently — yes, once the source row is already categorized, because
                   pairing excludes it from every spend query) and D5.2's
                   isSyntheticCardPaymentMirror / isAppCreatedCardPaymentPair — the ONE
                   spelling of the structural test unmarkCardPayment already used
                   inline, needed a second time so the /transactions row menu can
                   decide whether to OFFER "Not a card payment" at all rather than
                   render a refusal the user can only discover by clicking it (rule 8)
                   loadCardPaymentCandidates — T9's candidate list, ONE query per
                   importing card rather than one per row on the page: every unpaired
                   POSITIVE, non-pending, non-manual row on the card, unfiltered by
                   date or amount; the row menu's picker narrows to the source row's
                   exact magnitude client-side. import_source <> 'manual' keeps a
                   hand-typed row — or an orphaned markAsCardPayment mirror whose
                   partner was removed by undoSyncBatch — out of the picker; both would
                   otherwise read as legitimate, linkable candidates with no way to
                   detect the corruption afterward
                   linkCardPayment — T9's manual entry point onto the
                   ALREADY-EXISTING linkTransferPairManually (D8.2). The missing piece
                   for pairing a cross-date, cross-account card payment (Citi's
                   checking-to-card offsets measured at 1, 3, 1, 1 days — zero of which
                   matchTransfers would ever auto-pair) was an entry point, not a new
                   matching engine, since that function's date guard sits entirely
                   inside its same-account branch. Guards the source leg's sign and
                   account class the same way markAsCardPayment already does for its
                   own source leg — mirrored rather than trusted to the UI, since a
                   Visa charge marked as a Mastercard payment already inflated
                   paidDownCents once — and re-checks the target row's import_source
                   itself rather than trusting the picker (D8.3's "never trust the
                   picker alone" precedent). Lives beside, not inside,
                   manualTransaction.ts: that module's functions each WRITE or delete a
                   row; this one only links two that already exist
                   hasPreExistingManualCardHistory — the P1 fix (2026-09-15,
                   corrected same day by /ship's own adversarial review):
                   refuses to stage a card's transactions AT ALL on sync when
                   it carries ANY import_source='manual' row, closing the
                   direction D8.3 does not — a charge hand-typed BEFORE the
                   card was ever linked, whose bank-reported counterpart then
                   arrives as an unrelated-looking second row once import
                   starts (different memo, and Star One's posted date is a
                   settlement date that routinely lands a day or more after
                   the hand-typed purchase date, so content dedup cannot
                   collapse them). Deliberately NOT anchor-scoped: a first
                   version restricted the check to manual rows dated after
                   the anchor and offered reconciling forward as an
                   alternative remedy, and both were wrong — the bank's
                   settlement date can still land after a reconciled anchor
                   for the SAME event, and the anchor read (before `await
                   fetchAccounts`, never re-verified) was itself rule 11's
                   stale-precondition shape. Checking for ANY manual row
                   removes both problems at once; the only remedy that
                   actually closes the hole is `removeCardActivity`. Because
                   D8.3 makes a NEW manual row impossible on an already-linked
                   card, this population can only ever shrink post-link, so
                   unlike an anchor read it needs no re-check inside sync's
                   write transaction
  lib/budget/      loadMonthView, resolveRowDisplay — month read model + row tone/badge decisions
                   FundRow is EDITABLE as of v0.23.0, not the read-only stub DS19
                   described: it carries hasAllocation, carryoverPolicy, targetCents,
                   the same {allocated, rollover, effective} triple LeafRow does, and
                   plannedToDateCents from loadFundPlannedToDate (query #6, scoped to
                   the fund ids and skipped entirely when there are none). Fund leaves
                   also join rolloverCategoryIds — they were excluded while the band
                   was read-only, which made a rollover fund's carried balance appear
                   only after the first keystroke. plannedToDateCents is deliberately
                   NOT loadGoals' progressCents: it is allocated ALONE, because what
                   `withdrawn` should mean is the question rule 1's loadGoals note
                   parks.
                   loadFundPlannedToDate has NO lower bound and a HARD UPPER one at
                   the month being viewed. The upper bound is not optional: the route
                   is editable for future months and nothing gates a commit on phase,
                   so without it the figure was month-INVARIANT — allocate next month,
                   navigate back, and an earlier month reported money not yet planned,
                   with fundTargetGap rendering a green "Funded" for a target reached
                   later. It is a (year, month) PAIR comparison, never month alone
                   (2026-01 must not pick up 2025-12); both directions are pinned.
                   allocationFor is the ONE spelling of the {allocated, rollover,
                   effective} triple, called by both leafRows and fundRows — they ran
                   verbatim-identical copies until v0.23.0, with only the fund copy
                   carrying a comment saying so, which is how the pair drifts.
                   FundRow.hasAllocation has NO reader: both fund row components
                   branch on getAllocation() !== null, and it is kept only for parity
                   with IncomeLeafRow (whose copy IS read) — its docstring called
                   itself load-bearing until the v0.23.0 review, which was backwards.
                   The rendered "Planned to date"/"Left to target" cells are computed
                   from LIVE editor state (livePlannedToDateCents in _month-editor),
                   not from the server prop: commitAllocationAction deliberately does
                   not revalidate and revalidateBudgetSurfacesAction only fires when
                   focus leaves the WHOLE island, so tabbing between fund rows — the
                   pass the band exists for — left three numbers in one <TableRow>
                   that could not all be true
                   upsertAllocation, validateAllocateInput — the per-cell allocate write path
                   categoryKindLock.ts — isCategoryUsed / assignableKinds (pure) +
                   loadCategoryKindUsage (drizzle): the ONE spelling of rule 8 + X1,
                   read by the writer that enforces it (setCategoryKind) AND the read
                   model that renders the menu (loadMonthView). They ran independent
                   derivations until v0.24.0, which is how CategoryMenu came to offer
                   a kind change the server would always refuse
                   kindsImplyUsed.ts — kindsImplyUsed + ALL_KINDS: the ONE spelling of
                   "this kind list came from a USED category, so the only change on
                   offer is X1, so it cannot be undone". Exact rather than heuristic —
                   assignableKinds returns all three kinds iff !isCategoryUsed — and its
                   own file rather than a function in categoryKindLock.ts, which imports
                   drizzle and @/db while both callers here are "use client": a value
                   import would pull better-sqlite3 into the browser bundle, the measured
                   +376 KB limits.ts shape. categoryKindLock.ts therefore does NOT
                   re-export it. ALL_KINDS exists because the literal 3 was the
                   CARDINALITY of the schema enum with nothing tying it there
                   manageCategories, archiveCategory, setCategoryKind, loadAllCategories —
                   category CRUD, archive/unarchive, and expense→income reclassification
                   copyMonth, monthOfIso, transactionsDrilldownHref — /budget → /transactions
                   per-category-per-month link builder (dateFrom/dateTo, not year/month)
                   merchantDrilldownHref — /categorize → /transactions exact-merchant link,
                   URLSearchParams-built (17 of 363 real keys carry `# * ? /`) and `null`
                   for an empty key. Parked here beside its sibling; TODOS.md tracks moving
                   it to lib/transactions/, which now owns the param it emits
  lib/categorize/  Bulk-categorize logic and validators, plus the two read models:
                   loadMerchantGroups — /categorize rows; sampleMemos (≤3 distinct memos,
                   excluding ones equal to the key — 9.8% of rows) and totalRowCount
                   (all NON-TRANSFER rows for the key, filed included — the transfer
                   exclusion is what makes it agree with the drilldown it links to,
                   pinned by a test) are deliberately not `count`; filedCategoryIds
                   ships the IDS rather than a finished verdict, because the verdict
                   depends on the category the user has picked and only the row
                   component knows that
                   loadTransactions + summarizeByCategory — both build their WHERE through
                   one shared buildPredicates, so the /transactions header and the list
                   under it can never disagree about WHICH ROWS MATCH. That is a predicate
                   guarantee, not a snapshot one: they are two separate reads, so a
                   categorize action committing between them (a second tab, an in-flight
                   Undo) can still leave the header a beat behind. As of PR2/D5.2 a row
                   also carries pairIsAppCreated — computed from the PARTNER leg's
                   import_source/category_id (a correlated subquery, joined in JS
                   through isAppCreatedCardPaymentPair rather than a second SQL
                   spelling of that predicate) — false whenever transferPairId is null.
                   It is what lets the row menu tell an app-created pair
                   (markAsCardPayment's mirror, or T9's linkCardPayment) apart from an
                   ordinary bank-to-bank transfer the automatic matcher paired, so
                   "Not a card payment" is offered only where it can do something.
                   As of v1.3.0 a row also carries filedCategoryIds (this row's
                   merchant key's already-filed categories, with the row's OWN
                   category dropped when it is the sole contributor — count === 1 —
                   emulating the server's excludeTxnIds=[row.id] for the
                   retarget-in-place case) and existingRule (the merchant's current
                   exact rule, if any) — each from its OWN batched query per page
                   (loadFiledCategoryCountsByMerchant for the first,
                   loadExactRulesByMerchant for the second) rather than one round
                   trip per row. This is what lets
                   TransactionRowForm disable "Remember" the way /categorize's
                   MerchantRow already did, instead of only warning in the toast
                   after a refused submit
                   keyTrainability — the "Remember" guard's PURE half:
                   classifyKeyTrainability(key, filedCategoryIds, pendingCategoryId)
                   + LOSSY_MERCHANT_KEYS. The pick is a SEPARATE parameter, not
                   pre-unioned by the caller: the verdict needs the union, the message
                   must not have it, and this is where a non-id (0 from an empty select,
                   NaN from a corrupt parked pick) is filtered out once for both sides.
                   ZERO RUNTIME IMPORTS (an `import type` for `ExistingRule` is erased
                   at build time), same client-graph constraint as limits.ts and
                   merchantLabel.ts, because /categorize AND /transactions both evaluate
                   the verdict in the browser to disable the checkbox against the
                   category currently picked.
                   describeRuleAction(key, verdict, existingRule, pendingCategoryId) —
                   added in v1.3.0 as the client-side mirror of applyRuleWrite's
                   shouldDelete formula (rule 6). Disabling the checkbox flatly on
                   `!trainable` also disabled the ONE repair path rule 6 documents for
                   a poisoned rule: a refusal that CONTRADICTS an existing exact rule
                   still deletes it server-side, but a disabled checkbox can never
                   submit rememberMerchant=true to reach that branch. Returns
                   {kind: "train"|"remove-conflicting"|"none"}; "remove-conflicting"
                   also carries a reason: "lossy-key"|"contradicted", and
                   ruleActionLabel(action) (the ONE shared spelling, read by both
                   _transaction-row.tsx and _merchant-row.tsx) relabels the checkbox
                   from it rather than from kind alone — "Remove unusable rule" for
                   lossy-key, "Remove conflicting rule" for contradicted, because a
                   lossy key's removal is not a conflict with the pick (the pre-reason
                   version said "conflicting" for both, which was wrong for the
                   coincidental-match case: a lossy key whose pick happens to already
                   match the rule it's about to remove). Either reason keeps the
                   checkbox ENABLED even though no new rule will be trained.
                   No non-real pendingCategoryId (null, 0, NaN, negative — the same
                   isRealCategoryId guard classifyKeyTrainability uses) ever returns
                   "remove-conflicting" — there is no real pick yet to contradict
                   anything with. Its existingRule
                   input comes from loadExactRulesByMerchant (src/lib/rules.ts),
                   extracted from loadMerchantGroups' own inline copy so /transactions
                   could get the same per-merchant rule /categorize's MerchantGroup
                   already carried, without a second hand-rolled copy of the join
                   resolveRememberUi(normalizedMerchant, filedCategoryIds,
                   existingRule, pendingCategoryId) — added in v1.3.2, folding
                   classifyKeyTrainability + describeRuleAction + the
                   enabled/message/label derivation each render site used to
                   compute by hand into ONE call, returning
                   {action, enabled, message, label}. Closes the one way
                   describeRuleAction could be handed a verdict computed from a
                   DIFFERENT key than its own normalizedMerchant argument — both
                   are now derived from the same inputs in the same call. Replaced
                   ~40 hand-duplicated lines each in _merchant-row.tsx and
                   _transaction-row.tsx (TODOS.md, 2026-09-15 P2)
                   ruleActionSignature(normalizedMerchant, action,
                   pendingCategoryId) — a RuleAction's identity for consent
                   invalidation, read by useRememberConsent
                   (components/ledger/use-remember-consent.ts): two renders whose
                   signatures match are consenting to the exact same write. `kind`
                   ALONE is not enough — a `remove-conflicting` action can repoint
                   WHICH rule it would remove while `kind` and the pick both stay
                   put (a sibling row's write repoints the existing rule), so
                   `message` is folded into the signature too, sound because
                   `categories_name_unique` (src/db/schema.ts) pins one category
                   per name. `pendingCategoryId` is REQUIRED even for "train",
                   which carries no target in its own message — a bare "train"
                   signature let stale consent survive an UNRELATED bulkRetarget
                   silently resyncing the row's picker to a new category, with the
                   box staying checked for a write the user never confirmed against
                   the new target. `normalizedMerchant` is REQUIRED one layer up
                   for the same reason: _transaction-row.tsx keys its rows by
                   transaction id, not merchant, so a row's component instance
                   SURVIVES pnpm db:backfill-merchants renaming its
                   normalized_merchant in place (rule 10) — the one write path
                   that changes a row's key without changing which row it is — and
                   a ticked box would otherwise submit a rule for the NEW merchant
                   under consent given for the OLD one. Both gaps were found by
                   Codex structured/adversarial review after the signature-based
                   consent mask itself had already shipped
                   filedCategoryIdsAfterMove(filedCategoryIds, movingFromCategoryId)
                   — added in v1.3.3 for RetargetForm's Remember guard: what
                   filedCategoryIds reads once every row filed under the FROM
                   category has moved. bulkRetarget's matchingRows selects
                   exactly (merchant, categoryId = fromCategoryId,
                   transferPairId IS NULL), so dropping that id out of the
                   list is mathematically identical to passing the whole
                   moved set as resolveKeyTrainability's own excludeTxnIds,
                   without RetargetForm needing the row ids client-side —
                   pinned by a parity test in resolveKeyTrainability.test.ts
                   against the real DB-backed exclusion, not just the claim.
                   Closes TODOS.md's 2026-09-15 P2: RetargetForm had been the
                   one Remember checkbox on /transactions with no guard at
                   all (`filed` comes from summarizeByCategory, which unlike
                   filedCategoryEvidenceWhere does not skip an archived
                   category, so it was the wrong evidence source to build a
                   client verdict from) — `page.tsx` now threads a separate
                   filedCategoryIds prop from loadFiledCategoryIds instead
                   resolveKeyTrainability — the drizzle half: loadFiledCategoryIds +
                   resolveKeyTrainability(db, key, pendingCategoryId, excludeTxnIds).
                   excludeTxnIds are the already-filed rows the caller is about to
                   retarget, which makes the verdict the same on either side of the
                   caller's own UPDATE (it used to carry a "call me first" warning
                   instead). Also exports filedCategoryEvidenceWhere — the ONE spelling
                   of "which filings count as evidence", shared by its two DIRECT
                   callers: loadFiledCategoryIds (one key) and
                   loadFiledCategoryCountsByMerchant (batched over a page's
                   merchants, WITH per-category counts — what lets loadTransactions
                   self-exclude a row's OWN sole-contributed category from its own
                   evidence, emulating excludeTxnIds=[row.id] for every row on the
                   page without a per-row query). loadFiledCategoryIdsByMerchant is
                   NOT a third direct caller — it reaches the predicate only THROUGH
                   loadFiledCategoryCountsByMerchant, with the counts dropped, for
                   loadMerchantGroups, which has no single row to self-exclude —
                   every row it groups is category_id IS NULL already. The two direct
                   callers take the merchant condition as a parameter because eq() vs
                   inArray() is the only part that legitimately differs between them;
                   the batched query was hand-duplicated between loadMerchantGroups
                   and loadTransactions until the v1.3.0 client-disable work pulled it
                   here, and a parity test still pins the callers against each other
                   applyRuleWrite — the ONLY place that decides what happens to a key's
                   exact rule: upsert, withhold, or withhold AND remove. Shared by all three
                   categorize write paths; the two that predate it ran hand-maintained
                   copies that had already drifted (bulkRetarget is newer and never had
                   one). Owns the allowRuleRemoval opt-in (rule 6)
                   assertAssignableCategory — "may a transaction be filed under this
                   category?", the ONE spelling. Four checks (exists, not a fund, not
                   archived, not a parent) that bulkCategorize and categorizeTransaction
                   each carried a hand-maintained copy of and bulkRetarget would have
                   made three. Every one is DEFENSIVE — CategoryCombobox already filters
                   all four classes out of the picker, so they only fire on input the UI
                   could not have produced (a stale tab, a second tab, a crafted post),
                   which is exactly the class of check that must not be allowed to drift.
                   Order is load-bearing in one place: kind is tested before archivedAt,
                   so an archived fund reports as a fund rather than telling the user to
                   unarchive something that still would not be assignable
                   bulkRetarget + undoBulkRetarget — the THIRD categorize write path and
                   the repair for a bulk categorize that went to the wrong category.
                   Moves every non-transfer row for one key off fromCategoryId onto
                   categoryId. Until it existed, applyToPast on both other paths only
                   touched category_id IS NULL rows, so once a group was filed the only
                   way back was one row at a time after the 10s undo expired — and
                   /categorize stops listing a fully-filed group, so the repair could not
                   live on the page the mistake was made on. Reachable only from
                   /transactions?merchant=…. Three properties are decisions, not
                   conveniences: the SOURCE is a category (not "everything for this
                   merchant"), so every moved row shares one prior category and the
                   snapshot needs a single fromCategoryId; the row set is the whole KEY,
                   not the filtered list, so no filter state round-trips through a write
                   path; and excludeTxnIds is the whole moved set, which is what lets
                   Remember RETRAIN a rule on a move that makes the key unanimous rather
                   than refusing on evidence this very call is erasing. The source gets a
                   name lookup and NONE of assertAssignableCategory's checks — rows are
                   moving OFF it, so archived/parent/fund are reasons to be here.
                   Both categories' rollover chains recompute on the next read;
                   there is no cache to invalidate (migration 0021).
                   Throws rather than no-oping on an empty row set or a same-source
                   destination (bulkRetargetErrors), because applyRuleWrite keys off the
                   MERCHANT and not the rows: a zero-effect "move" would still retrain or
                   DELETE the key's rule
                   validateBulkRetargetInput / validateBulkRetargetSnapshot — the pure
                   halves, mirroring the bulkCategorize pair field for field including
                   its two load-bearing decisions (matchType is z.literal("exact"), so a
                   crafted Undo cannot install a {regex, ".*"} catch-all; no .min(1) on
                   either key, because "" is a real stored key). earliestDate is
                   z.iso.date() and non-nullable, and its ORIGINAL reason is gone — worth
                   recording as gone rather than quietly restating. It fed parseIsoMonth ->
                   invalidateForwardRollover, where a shape-valid 2026-13-01 matched no
                   budget_periods row and left a rollover cache stale for the rest of the
                   year. That cache was deleted (migration 0021), so NOTHING consumes
                   earliestDate today: bulkRetarget still produces it and the client still
                   round-trips it, but every reader was an invalidation call. It stays
                   validated because a field the client can hand back is part of this
                   schema's contract whether or not today's code reads it. Removing it is
                   tracked in TODOS.md and is a wire-format change, not a cleanup.
                   Both also carry CROSS-FIELD refinements the object shape cannot
                   express: fromCategoryId !== categoryId (a pure invariant, so it
                   belongs in the pure layer — SameCategoryRetargetError stays as the
                   backstop for a second writer, but the contradiction no longer
                   reaches an open write transaction), and, on the snapshot only,
                   priorRule.matchValue === normalizedMerchant. That second one closes
                   the half of undoBulkRetarget that was unbounded: its ROW update is
                   merchant-scoped, but restorePriorRule was not, and its third
                   mechanism (onConflictDoUpdate on (match_type, match_value))
                   REPOINTS whatever rule holds that slot — so a hand-edited payload
                   could retarget an unrelated merchant's rule to any category, and
                   reorder rule priority while doing it, since the restore writes
                   updated_at back to influence compareRules
                   runBulkRetarget / runUndoBulkRetarget — the two /transactions retarget
                   Server Action BODIES, minus revalidatePath, taking an explicit db.
                   Two reasons, both load-bearing. (1) Outcomes are returned as STATE,
                   never thrown: Next.js replaces a thrown Server Action's message with
                   a generic digest in production builds, and this app ships one
                   (Dockerfile → next start), so every sentence in bulkRetargetErrors.ts
                   was dev-only text — including NoRowsToRetargetError, which its own
                   docstring calls reachable from ordinary use and whose whole payload
                   is "reload to see the current counts". Same shape /sync uses.
                   (2) A test can drive the REAL path: actions.test.ts used to MIRROR
                   the body by hand, re-declaring {allowRuleRemoval: true} itself, so
                   deleting the opt-in from the action left all 1,755 tests green while
                   claiming in its own docstring to pin it. Anything after the commit
                   (describeRuleRefusal does its own read; SQLITE_BUSY is live here)
                   degrades the MESSAGE rather than failing the result — a throw there
                   reported "Move failed." for a move that succeeded and discarded the
                   only copy of a deleted rule's priorRule with the Undo toast
                   priorRuleSnapshot — PriorRuleSnapshot + toPriorRuleSnapshot, with
                   matchType narrowed to "exact"; it used to live in bulkCategorize.ts,
                   so the undo path type-depended on a write path
                   refusalNotice — describeRuleRefusalPostCommit (wrapping a
                   module-private describeRuleRefusal, not exported since
                   v1.2.2 — every real caller sits after a committed write, so
                   a fourth caller reaching the raw read directly is now a
                   compile error rather than a convention): the refusal
                   turned into the ONE sentence both surfaces render,
                   server-side because the fact that matters is the NAME of a
                   removed rule's category
                   postCommitRead.ts — guardPostCommitRead, the sibling of
                   guardRefresh (lib/revalidateAfterWrite.ts) for READS rather
                   than revalidation: a lookup a write path does purely to
                   describe what it just did (a category NAME behind an id)
                   must not turn a committed write into a reported failure if
                   the lookup itself throws (SQLITE_BUSY is live — WAL mode,
                   VACUUM INTO snapshots and `pnpm db:export` all hold
                   readers). Degrades to the caller's `fallback` and logs
                   rather than swallows. refusalNotice.ts is its first
                   caller; categorizeSubscriptions.ts (lib/subscriptions/)
                   and /categorize's actions.ts also call it directly
                   describeRuleUndo — the matching clause for the undo toast, so a
                   restore, a no-op and an untouched rule stop reading identically
                   restorePriorRule — puts a priorRule snapshot back whether the original
                   call OVERWROTE the rule or DELETED it. Three mechanisms, because
                   uniqueness is on (match_type, match_value) and not on id: UPDATE by
                   id, else INSERT re-using the id, else merge onto whatever now holds
                   that slot. Shared by both undo paths on purpose
  lib/transactions/ /transactions' URL contract, extracted from page.tsx so it is testable:
                   searchParams — the `.strict()` zod schema + flatten() + resolveIsPending;
                   a filter key must be accepted HERE and emitted by
                   filterValuesToSearchParams or it drops silently on page 2 (shipped
                   broken twice). The contract has THREE edges and the third is the one
                   that keeps failing: a key can exist in the schema and never be added to
                   TransactionsFilterValues, which is exactly how `pageSize` escaped a guard
                   written to catch it — the guard enumerates the type, so it is structurally
                   blind to a key the type lacks. That third edge is now a compile-time
                   assertion; the first two are exhaustive runtime checks driven off the
                   type's own keys, in
                   _filter-bar.test.ts. A FOURTH gate is separate machinery: "Apply filters"
                   is a GET form, so a field also needs a visible control or a hidden input,
                   now derived from the serializer (VISIBLE_FIELDS is the complement) rather
                   than hand-listed one <input> at a time
                   flatten DROPS a blank key rather than passing it on as undefined —
                   .strict() rejects an unknown key even when its value is undefined, so
                   retaining it made one empty foreign param (`?merchant=X&ref=`) 404 a
                   request whose real filters all parsed
                   limits — MAX_SEARCH_LENGTH / MAX_PAGE_SIZE / DEFAULT_PAGE_SIZE in a
                   zod-free module, because _filter-bar.tsx is client-side and importing them
                   from the schema pulled zod into the route bundle (+376 KB, measured)
                   merchantLabel — merchantLabel() / hasMerchantName() / NO_MERCHANT_NAME,
                   the ONE answer to "how is an empty normalized_merchant shown to a
                   person". The empty key is reachable (a blank Memo cell normalizes to ""),
                   and before this the two ends of the drilldown disagreed: /transactions
                   rendered a fallback while /categorize rendered the key verbatim — an
                   unreadable row with an sr-only label ending in "Category for ". Zero
                   imports on purpose, same client-graph constraint as limits
  lib/transferRejections.ts
                   The ONE place that knows how "these two are not a pair" is
                   stored: `transfer_pair_rejections`, keyed on the unordered
                   pair (`low < high`), replacing the single-valued column that
                   could not express two rejections against one row. Shared by
                   the CSV ±1 matcher (`importBatch.ts`) and the feed matcher
                   (`simplefin/sync.ts`); both load ONE set per run and pass a
                   closure, never a query per candidate pair
  lib/revalidateAfterWrite.ts
                   guardRefresh(scope, run) — the ONE spelling of "this revalidation
                   follows a COMMITTED write". Applied by all eight src/app/*/actions.ts
                   files; the doctrine, and why it is one function rather than an eighth
                   copy, is in the "Automated sync" section below
  lib/refreshWarning.ts
                   REFRESH_FAILED_WARNING — the sentence itself, split out because
                   revalidateAfterWrite.ts imports next/navigation for unstable_rethrow
                   and _month-editor.tsx is "use client". Same client-graph constraint as
                   limits.ts, merchantLabel.ts and kindsImplyUsed.ts
  lib/import/      Import orchestration and validators
  lib/simplefin/   Automated sync: client (zod-validated), mapping, bucket transfer
                   matcher, link/unlink, undo, input validation
                   sameAccountReversals — findSameAccountReversals (buckets on
                   (accountId, date, |amount|) and returns ONLY SameAccountBucket[], a
                   type that is structurally separate from matchTransfers'
                   CrossAccountBucket so neither review queue can be wired to the
                   other's server action; never auto-links) and overlappingRowIds (the ids both review queues claim,
                   surfaced in both rather than silently taken by one). Rule 4 owns the
                   reasoning; sync.ts holds the DB half
                   (findSameAccountReversalCandidates) and the two hand-driven writes
                   (linkTransferPairManually's allowSameAccountReversal opt-in,
                   rejectTransferPairManually)
                   feedAccountId — FeedAccountId + asFeedAccountId, the ONE mint. Rule 3
                   makes "which feed produced this row" a different fact from "which
                   account holds it", and the codebase has already paid for conflating
                   them (migration 0020). Unbranded, a `feedId: string` parameter also
                   accepts row.externalId (the TRANSACTION id, unique only WITHIN a feed),
                   an account name, or "" — which compares unequal to every real link, so
                   a guard taking it drops every account with a plausible "was re-linked"
                   warning and reports a clean sync. asFeedAccountId rejects "". Zero
                   runtime imports, same constraint as limits.ts
                   test/syncFixtures — the shared harness for the two syncSimpleFin
                   suites: the fixed clock, seedAccount, feedTxn/feedAccount and the
                   outcome narrowers. seedAccount here was the 21st hand-copy of a helper
                   CLAUDE.md already tracks as duplicated across 13+ test files, and the
                   two suites had drifted on it inside one branch. What CANNOT move here
                   is the vi.hoisted mock trio and the vi.mock factories — vi.mock is
                   hoisted per FILE, so a shared module cannot register mocks for a caller
drizzle/           Migration output (committed)
data/             money.db + pre-import snapshots (gitignored)
.context/         Design artifacts, CSV samples, deltas (gitignored)
DESIGN.md         Source of truth for visual decisions — Ledger Paper design
                   system (fonts, color tokens, component specs). Living doc,
                   updated alongside features; not a one-time handoff. See
                   "When in doubt" below
design_handoff_nav_and_design_system/  The ORIGINAL prototype handoff — two
                   HTML/CSS/JS specimens (Design System.html, Nav Prototype.html)
                   plus README. DESIGN.md was built from these and is what's
                   current; this directory is a historical reference, not
                   something to recreate against directly
docker/           entrypoint.src.mjs (committed source) + entrypoint.mjs (esbuild-bundled, gitignored)
```

