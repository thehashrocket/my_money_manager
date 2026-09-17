# Card paydown target

Closes the "consumer waiting on the answer" gap named in TODOS.md's PR3 fund-progress
entry (line 1149): `paidDownCents` already reports what you actually paid toward a
liability this month (`/accounts`, dashboard), but nothing lets you plan a paydown and
check whether you hit it.

## Decision (D2, 2026-09-17): scoped narrow, decoupled from funds

The original TODO sketch — `categories.account_id` FK, relax `assertAssignableCategory`
for `kind='fund'`, teach the fund band to compute progress from money that moved — is
**not** what this builds. That design was already killed once by Codex's outside-voice
review (decision D13=B) for three reasons that still hold: `categorizeTransaction`
rejects `kind='fund'`, `categories` has no FK to `accounts`, and reusing the fund
mechanism for "money moved" would reopen DESIGN.md's closed 1.0.0 gate #2 ("a fund
number is money PLANNED, not money moved") for one flavor of fund only.

Instead: a new nullable `accounts.paydown_target_cents`, same shape and same table as
`credit_limit_cents` / `minimum_payment_cents` (both liability-display fields, cards-only
per rule 9). Compared against the existing `paidDownCents(accountId, year, month)` on
`/accounts`. Zero involvement of `categories`, `assertAssignableCategory`, or the
fund/`kind` machinery — no risk to the settled gate #2 decision.

**Issue 1A (resolved): recurring standing value, not month-scoped.** Matches
`minimum_payment_cents`'s existing pattern on this exact table — one number that holds
until edited, not a per-month row. A month-scoped version (varying goal per month, with
history) is a legitimate product upgrade but needs `budget_periods`-shaped plumbing,
which is exactly the scope this decision avoids reopening. The recurring column can
become the default for a later month-scoped version without losing data.

## What already exists (reused, not rebuilt)

- `paidDownCents(accountId, year, month, db)` (`src/lib/accounts/paidDownCents.ts`) —
  the actual-paid figure. Unmodified.
- `credit_limit_cents` / `minimum_payment_cents` on `accounts`, and their read
  (`loadAccountBalances.ts`), validate (`validateCardTermsInput.ts`), write
  (`updateCardTermsAction`), and form (`_card-terms-form.tsx`) paths — `paydown_target_cents`
  rides the identical pattern rather than inventing a new one.
- `optionalPositiveDollarsSchema` (`src/lib/import/accountAnchorFields.ts`) — the
  empty-string-clears-to-NULL schema already shared by both existing card-terms fields.

## NOT in scope

- **Dashboard aggregate (`src/app/page.tsx`'s `debtPaidDown`).** Per-account display only;
  a summed "planned vs. actual across all cards" figure is a small follow-on, not bundled
  here to keep the diff to the account-row surface.
- **Month-scoped targets / history.** See Issue 1A above — deliberately deferred, not
  forgotten.
- **Reopening fund-progress semantics or the linked-fund design.** D2's whole point.
- **Reusing `minimum_payment_cents` as the comparison baseline.** Considered and rejected
  in D2: conflates "required minimum" with "planned goal," which are usually different
  numbers.

## Implementation

### Schema + migration
`src/db/schema.ts` — add `paydownTargetCents: integer("paydown_target_cents")` beside
`minimumPaymentCents` (same nullable, cards-only pattern; comment states the recurring
decision so a future reader doesn't have to re-derive it). `pnpm db:generate` produces a
plain `ALTER TABLE accounts ADD COLUMN paydown_target_cents INTEGER` — nullable column
add, no table rebuild, so rule 7's `scripts/migrate.mjs` path applies but hits none of
its rebuild-specific hazards. `pnpm db:migrate` to apply.

### Validation
`src/lib/accounts/validateCardTermsInput.ts` — add `paydownTarget: optionalPositiveDollarsSchema`
to `cardTermsInputSchema`, transform to `paydownTargetCents` the same way the other two
fields transform (`v.x === null ? null : Math.round(v.x * 100)`).

### Write path
`src/app/accounts/actions.ts`'s `updateCardTermsAction` —
- Parse `raw.paydownTarget` through the extended schema.
- **Critical: mirror the existing absent-vs-empty guard exactly.** The patch only sets
  `paydownTargetCents` when `raw.paydownTarget !== undefined`, matching the guard already
  on `creditLimit`/`minimumPayment` (the function's own comment documents this as a real,
  previously-shipped bug: a field missing from the POST used to silently NULL a value
  present in the DB). Getting this wrong for the new field reintroduces that exact bug
  for a third field.
- Non-card refusal (`isCreditCard(account.type)`) already covers the new field for free —
  no separate check needed.

### Form
`src/app/accounts/_card-terms-form.tsx` — add a third controlled field next to Credit limit /
Minimum payment, following the identical pattern (controlled state initialized from the prop,
reset on Cancel, `min-h-11` touch target, `aria-label`). **Labeled "Paydown target" at first
implementation; renamed to "Monthly paydown goal" during `/ship`'s pre-landing review** — an
outside-voice design pass flagged the original label as ambiguous with a target BALANCE rather
than a monthly amount. Same rename also applied to the field's validation-failure error message.
Placeholder text: "none" (matches the other two — empty means "no target set," not $0).

### Read model
`src/lib/accounts/loadAccountBalances.ts` — add `paydownTargetCents: number | null` to the
`AccountBalance` type (beside `minimumPaymentCents`) and to the row mapping.

### Display
`src/app/accounts/_account-row.tsx` — extend the existing "paid down" line (currently
`account.paidDownCents !== null && account.paidDownCents > 0`):
- When a target is set (`paydownTargetCents !== null`) **and** `paidDownCents !== null`,
  always render the line — including at $0 progress — as "paid down $X of $Y planned this
  month." Deliberately reverses the existing DS58 zero-suppression rule for this case: DS58
  suppresses $0.00 because an ambient, always-on figure reading $0 "reads as a reproach";
  here the line only appears at all once the user has opted in by setting a goal, which
  makes $0-of-$Y the same useful "haven't started yet" signal a fund's "Left to target"
  already gives elsewhere in the app.
- When no target is set, behavior is unchanged (existing $0-suppression stands).
- When `paidDownCents === null` (mortgage, or a linked card with zero rows), still omit
  the line even if a target is set — showing "$0 of $Y" against an uncomputable actual
  would be the same false-precision problem DS58 already avoids for the plain figure.

## Tests (Issue 3A, resolved: backfill full action-layer coverage)

`updateCardTermsAction` has **zero existing action-layer test coverage** — confirmed by
grep; only the pure `validateCardTermsInput` schema is unit-tested today. New
`src/app/accounts/actions.card-terms.test.ts` covers, for **all three** fields
(backfilling the two pre-existing ones alongside the new one, since the harness cost —
seed one card account, call the action, assert the DB row — is paid once regardless of
scope):
- Refuses a non-credit-card account.
- Refuses a missing/invalid `accountId`.
- Each field: valid dollar value → correct cents stored; `""` → clears to `NULL`; a field
  **absent from the FormData entirely** → existing stored value is preserved, not nulled
  (the regression case for the documented absent-vs-empty bug, now pinned for real).
- Out-of-range value (reusing `STARTING_BALANCE_DOLLARS_MAX`) is rejected with the correct
  per-field message.

`validateCardTermsInput.test.ts` — add cases for `paydownTarget` mirroring the existing
`creditLimit`/`minimumPayment` cases (valid, empty-clears, out-of-range, missing).

`loadAccountBalances.test.ts` — assert `paydownTargetCents` flows through the mapping
(stored value round-trips; `null` when unset).

`_account-row.tsx` is a UI component, excluded from automated coverage per CLAUDE.md's
"Tests for UI components" exclusion — verified instead by running the dev server and
checking the row renders correctly with target unset / set-and-zero-progress /
set-and-partial-progress, per this skill's UI verification requirement.

## Failure modes

| Codepath | Failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| `updateCardTermsAction`, `paydownTarget` absent from POST | Would silently NULL the stored target | Yes (new regression test) | Yes (existing guard pattern, extended) | No error — correct behavior (value preserved) |
| `updateCardTermsAction`, out-of-range value | Rejected | Yes (new test) | Yes (`fail()` with field-specific message) | Inline error on the form |
| `updateCardTermsAction` on a non-card account | Refused | Yes (new test) | Yes (`isCreditCard` guard) | `fail("... is not a credit card.")` |
| `_account-row.tsx`, target set but `paidDownCents === null` | Line omitted | N/A (UI, browser-verified) | Yes (existing null-check pattern extended) | No line rendered — no false claim |

No critical gaps: every new codepath has either a test or is UI-only and covered by the
existing browser-verification convention this codebase already applies to
`_account-row.tsx`.

## Worktree parallelization

Sequential implementation — schema → validation → action → form → display all touch the
same feature in one small dependency chain, and the whole change is ~6 files. No
parallelization opportunity.

## Implementation Tasks

- [x] **T1 (P2)** — Add `paydown_target_cents` column to `accounts` in `src/db/schema.ts`; generate + apply migration. (`drizzle/0022_cool_whistler.sql`, plain nullable `ALTER TABLE ADD COLUMN`, no rebuild)
- [x] **T2 (P2)** — Extend `cardTermsInputSchema` in `validateCardTermsInput.ts`; extend its test file.
- [x] **T3 (P2)** — Extend `updateCardTermsAction` (absent-vs-empty guard mirrored exactly); new `actions.card-terms.test.ts` covering all three fields, including the regression case for the documented absent-vs-empty bug.
- [x] **T4 (P2)** — Extend `AccountBalance` type + mapping in `loadAccountBalances.ts`; extend its test file.
- [x] **T5 (P2)** — Add the third form field to `_card-terms-form.tsx`; threaded through `_card-controls.tsx` and `_account-row.tsx`.
- [x] **T6 (P2)** — Extend the paid-down display line in `_account-row.tsx`.
- [x] **T7 (P2)** — Browser-verified on a seeded scratch ledger (`pnpm db:seed-dev`, never the real `data/money.db`): target-set-with-partial-progress renders "paid down $500.00 of $600.00 planned this month"; target-set-with-uncomputable-actual (zero-row Amex) correctly omits the line rather than showing a false "$0 of $200.00"; no-target behavior unchanged.

**Shipped as v1.5.0** — 2262 tests pass (2256 baseline already included this plan's own 7 new cases; +6 more from `/ship`'s coverage audit backfilling the accountId guard and the two pre-existing field-message branches), `tsc --noEmit` clean, lint clean (pre-existing unrelated warnings only). See CHANGELOG.md.

## `/ship`'s pre-landing + adversarial review (2026-09-17)

What actually shipped is not what T1-T7 above describe alone — `/ship`'s review army and four
rounds of adversarial red-teaming (a native checklist pass, 6 specialists, a design pass, and
then Red Team / Claude adversarial / Codex adversarial / Codex structured review, each re-run
after every fix until a pass produced zero new findings) found and fixed real bugs in the write
path this plan's own T3/T7 had called done:

1. **Stale-tab overwrite (CRITICAL).** The browser form always posts all three fields, so the
   original absent-vs-empty guard could never tell "untouched" from "re-confirmed" — a second
   tab's save of an unrelated field silently reverted a more recently saved field. Fixed with
   snapshot-diffing (a parallel `<field>Snapshot` hidden input per field).
2. **Cancel-during-pending (CRITICAL).** Cancel had no `disabled={pending}` guard, so closing
   the form while a Save was still in flight could seed the next reopen from pre-write props,
   reintroducing (1) through a different door.
3. **Stale `useActionState` across reopen (CRITICAL).** `CardTermsDisclosure` never unmounted
   on close, so a stale success/error message (and, combined with (2), stale `values`) survived
   a Cancel-then-reopen. Fixed by splitting into a toggle wrapper + remountable inner form,
   mirroring the existing `ReconcileDisclosure`/`ReconcileForm` pattern in `_balance-forms.tsx`.
4. **Presence-guard regression (CRITICAL, found independently by Codex and a Claude subagent).**
   The fix for (1) REPLACED the presence check with the snapshot check instead of layering them,
   which reintroduced destructive-by-omission for a request that drops a field but keeps a
   stale Snapshot input. Fixed by ANDing `raw.field !== undefined` back in as a precondition.
5. **Canonicalization drift (CRITICAL, found independently by both Codex passes).** The form
   stays open after a successful save, but `values` was never resynced to the canonical
   (`centsToDollarString`, always 2 decimals) string — a raw-typed "60" would permanently
   mismatch a freshly-recomputed "60.00" snapshot, silently reposting the untouched field on
   every later save. Fixed with this codebase's own adjust-state-during-render pattern.
6. **$0-goal nonsensical copy (informational).** An explicit `paydownTargetCents === 0` rendered
   "paid down $0.00 of $0.00 planned this month." Fixed by treating a stored 0 as null for
   display, same as `resolveUtilizationDisplay` already does for a $0 credit limit.

Every fix was verified with a live two-tab (or Save/Cancel-race) browser repro, not just a unit
test — (5) in particular was only visible by watching the "Minimum payment" field literally
change from `60` to `60.00` on screen after Save. Two things the review flagged were deliberately
**not** changed (same-field genuine conflicts resolve last-write-wins; a stale-but-matching
untouched field correctly skips the write) — see TODOS.md's card-paydown-target follow-ups
section for the reasoning, and for the one accepted low-confidence residual (no DB-level CHECK
constraint on `paydown_target_cents`).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Outside Review | — | Independent 2nd opinion | 0 | unavailable | not run this session (scope kept small; see note) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 2 issues found, both resolved (Issue 1A: recurring vs month-scoped target; Issue 3A: test backfill scope) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (one-line display change, no new surface) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **OUTSIDE COVERAGE:** Not run this session. This review already reversed one
  previously-outside-voice-rejected design (the linked-fund sketch, D13=B) by choosing a
  smaller, decoupled mechanism instead of reopening it — the outside-voice objection that
  killed the original design does not apply to what's actually being built here.
- **VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
