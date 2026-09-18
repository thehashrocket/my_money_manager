# Cache Components migration

Closes TODOS.md's line-1335 P2: `next.config.ts` sets only `output: "standalone"`,
so `cacheComponents` is off, and `/categorize`'s `_pending-pick.ts` (231 lines) exists
purely to fake — via `sessionStorage` + `useSyncExternalStore` — what React's
`<Activity>` component would preserve for free once the flag is on: a parked category
pick that survives leaving `/categorize` to check a merchant's history on
`/transactions` and coming back.

## Decision: audit-first, staged by risk — not a flag flip

**What changed between the triage pass that picked this and this plan.** The triage
recommendation sized this as "flip a flag, delete a workaround, ~1-2 hours" based on
the *route-config* migration surface (searchParams, cookies, `dynamic`/`revalidate`
exports), which is genuinely tiny in this app — 13 routes, only `/transactions` and
`/categorize` read `searchParams`, zero `cookies()`/`unstable_cache`/edge-runtime
usage. That part of the sizing was right. What it missed: enabling `cacheComponents`
does not just change *caching*, it changes *navigation*. Per Next's own docs
(`node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`):

> Cache Components uses Activity automatically at the route level... Next.js
> preserves up to 3 routes. Beyond that, the oldest route is evicted.

This is **global and immediate** the moment the flag flips — there is no per-route
opt-out for it. `instant = false` (the guide's "incremental adoption" mechanism) only
defers *validation* (whether a route renders instantly); it does nothing to disable
Activity-based state preservation for that route. So "convert one route at a time"
only applies to route-config migration, not to the behavior change that actually
carries risk here.

**Why that risk is real in this specific codebase, not generic caution.** This app's
correctness — not just its UX — leans on "navigating away unmounts the component,
which resets its local state" in at least three places, each already hardened by a
real, documented incident:

- `_month-editor.tsx` (`/budget/[year]/[month]`) computes "Planned to date"/"Left to
  target" from **live, unrevalidated editor state**
  (`pendingCommitsRef`/`dirtyRef`/`livePlannedToDateCents`), and flushes it to the
  server via an effect **cleanup** keyed on `[year, month]` — the mechanism the
  file's own comment says exists specifically so "client-side navigation from one
  month to another" doesn't strand unflushed edits. TODOS.md documents the bug this
  replaced: three numbers in one `<TableRow>` that couldn't all be true, because the
  refresh was gated on focus leaving the whole island.
- `_card-terms-form.tsx`/`_balance-forms.tsx` (`/accounts`) explicitly split into
  "toggle wrapper + remountable inner form" — a **local** conditional-render
  unmount/remount, confirmed by reading the file — specifically so
  Cancel-then-reopen gets a clean `useActionState`/`values` slate instead of the
  stale-message bug their own comments describe as already having shipped once.
- `/sync`'s `ActionForm.tsx`/`_action-feedback.tsx` are built around a row's own
  **list-membership** unmount (leaving `linkedPairs`) to drop a stale success/error
  message — plus this session's own memory carries a pinned pitfall
  (`react19-form-replay-defeats-hydration-gate-fix`, confidence 10/10) about this
  exact route's `useFormStatus`/hydration-replay interaction breaking in a
  non-obvious way under a *different* well-intentioned fix. `/sync` gets the most
  scrutiny of any route in this migration for that reason alone.

**Investigation finding: most of the above are not actually at risk.** Effect
*cleanups* run identically whether a component unmounts or Activity hides it
("React runs effect cleanup functions just like it does on unmount" — same doc). And
several of the `unmount` references this plan's own grep turned up (`_row-menu.tsx`,
`_category-menu.tsx`, `sync/ActionForm.tsx`'s list-item case, `_card-terms-form.tsx`)
turned out to be **local conditional-render unmounts** — `{open && <X/>}` inside an
already-mounted route — which Activity does not touch at all; it only wraps route
*segments*, not arbitrary JSX branches. The two that remain genuinely open questions
are `_month-editor.tsx` (does a route Activity restores on return get a fresh
server render, or the stale one from when it was hidden?) and `/sync` broadly (given
the pinned pitfall). Both get explicit browser verification before being trusted,
not an inference from reading the docs.

**Staged by risk, not by file count.** Convert routes in ascending order of how much
their correctness depends on the unmount-resets-state assumption, verify each stage
in a real browser against a specific repro before moving to the next, and treat any
stage that fails verification as a **stop-and-fix-in-place**, not a reason to revert
the whole flag (the config-migration half of the work is unconditionally worth
keeping regardless of how the state-preservation audit lands).

## What already exists (reused, not rebuilt)

- `_pending-pick.ts` itself — not deleted blind. Its guarantee (survives **any**
  navigation depth within the tab, indefinitely) is actually *stronger* than
  Activity's (survives up to 3 preserved routes, LRU-evicted beyond that) — see
  Stage 2 below for the keep-vs-delete call, made after the real behavior is
  observed, not assumed.
- `guardRefresh`/`revalidateAfterWrite.ts` — unchanged. `revalidatePath` "is
  unchanged from the previous caching model" per the migration guide; nothing here
  needs to move to `cacheTag`/`updateTag`, since this app fetches directly from a
  local synchronous `better-sqlite3` connection, not `fetch`, and has no CDN layer
  for `use cache` to help with.
- `src/lib/now.ts` — the app's one documented synchronous-time-read site
  (CLAUDE.md's `.toISOString()` timezone bug history). Checked in Stage 0 for any
  call sitting in a prerender path (`new Date()`/`Date.now()` outside a
  request-scoped function would hard-fail the build under Cache Components,
  unlike the soft "insight" a `searchParams` read produces).

## NOT in scope

- **Any `use cache`/`cacheLife`/`cacheTag` adoption.** This app has no CDN, is
  `output: "standalone"`, self-hosted, single-user — there is no cached-response
  reuse to configure. The only thing this migration buys here is the navigation
  model (Activity) and the deletion of `_pending-pick.ts`'s workaround, if the
  audit clears it.
- **Building the narrower alternative** (hoisting pending-pick state to a shared
  layout instead of adopting Cache Components at all) — considered in the prior
  triage turn, rejected by explicit user choice in favor of doing this properly.
- **The `next-cache-components-adoption` skill / codemod.** Installing a new
  external tool for a 13-route app with no `dynamic`/`revalidate`/`fetchCache`
  usage to migrate is disproportionate — the mechanical surface is small enough to
  do by hand and is not the risky part anyway.
- **Reworking `/sync`'s `$$reactFormReplay` interaction.** If Stage 3's `/sync`
  verification surfaces a real regression there, that is new scope requiring its
  own plan — not something to absorb into this one under review pressure, per this
  project's own documented pattern of deferring rather than rushing a fix into an
  unrelated branch.

## Stage 0 — mechanical config migration (do first, independent of the risk audit)

1. `next.config.ts` — add `cacheComponents: true`.
2. Remove `export const dynamic = "force-dynamic"` from `src/app/sync/page.tsx` and
   `src/app/api/health/route.ts` — both error under Cache Components ("route
   segments that still export `dynamic`... will error"); neither needs it, since
   "not needed, all pages are dynamic by default" is the documented replacement.
3. Grep `src/` for `new Date(`, `Date.now(`, `Math.random(`, `crypto.randomUUID(`
   outside a function body called only from an event handler or Server Action —
   these hard-fail the build if reachable from a prerender path, unlike the two
   `searchParams` reads below (soft "insight," not a build error). Expected result:
   none, since this app's timestamps come from `src/lib/now.ts` called at request
   time inside Server Actions/data loaders, not at module or render scope — confirm
   rather than assume.
4. `pnpm build` — confirm it succeeds and note every validation insight the dev
   overlay/build output surfaces for `/transactions` and `/categorize` (their
   `searchParams` reads, expected) and anything unexpected.
5. `pnpm test` — expect no change; the migration touches no `src/lib/` pure
   functions this suite covers.

## Stage 1 — low-risk routes (verify, expect no code changes)

`/`, `/budget/categories`, `/goals`, `/import`, `/import/preview/[id]`,
`/import/success/[batchId]`, `/subscriptions`, `/accounts`.

For each: browser-verify against the two patterns Next's guide calls out as the
actual failure modes (not a code read — a live repro), since "I read the file and
it looks safe" is exactly the kind of claim CLAUDE.md's evidence discipline (and
this skill's "Claimed Limitations Need Evidence") requires backing with a probe,
not a read:

- **Dialog/disclosure re-open after navigating away and back.** Every toggle this
  plan's grep found (`ReconcileDisclosure`, `_charge-dialog.tsx`,
  `CardTermsForm`, `_goal-forms.tsx`, `_create-account-form.tsx`,
  `_categorize-buttons.tsx`, `_unarchive-button.tsx`) is a **local**
  conditional-render unmount by construction — confirmed by reading
  `_card-terms-form.tsx`'s own docstring, which describes the toggle as "a genuine
  mount/unmount boundary" independent of routing. Expected: no change needed, since
  Activity does not wrap local JSX branches, only route segments. Verify anyway:
  open a disclosure, navigate to a different route and back within the 3-route
  window, confirm the disclosure is closed and its form fields blank (not merely
  "probably fine because the code says so").
- **Stale `useActionState` success/error messages surviving a return visit.** Every
  form using `useActionState` on these routes (`_balance-forms.tsx`,
  `_card-terms-form.tsx`, `_goal-forms.tsx`, `_create-account-form.tsx`) —
  verify: submit successfully, navigate away, come back, confirm the success
  message is gone rather than stale (Next's guide names this as the single most
  common regression: "if the user navigated away while the dialog was open,
  Activity preserves `isDialogOpen: true`" and the init effect doesn't re-fire).
  Where local unmount already resets it (the `_card-terms-form.tsx` split above),
  expect a pass; treat any failure as a real Stage 1 finding, not a false alarm.

Any finding here gets fixed in place (typically a `useLayoutEffect` cleanup per the
guide's "Resetting stale status messages" pattern) before moving to Stage 2 — these
routes are lower-risk in scope, not exempt from verification.

## Stage 2 — `/categorize` (the target route)

1. Flip the actual behavior on first, before touching `_pending-pick.ts`: pick a
   category on a `/categorize` row, follow "See all N transactions" to
   `/transactions?merchant=…`, click back (or navigate to `/categorize` directly).
   Confirm the pick is restored — this is Activity doing, for free, what
   `_pending-pick.ts` fakes today.
2. **Test the guarantee gap directly, not just the happy path**, since it's real:
   `_pending-pick.ts` survives *any* navigation depth in the tab; Activity survives
   only the 3 most recently visited distinct routes. Repro: park a pick, visit
   `/transactions?merchant=A`, then `/budget/2026/9`, then
   `/transactions?merchant=B` (three distinct pathnames visited since leaving
   `/categorize` — `/categorize` itself is the 4th route competing for the 3 slots),
   then return to `/categorize`. If the pick is gone, that is Activity's documented
   LRU eviction working as designed, not a bug — but it means `_pending-pick.ts`'s
   guarantee is strictly stronger, and deleting it is a real, user-visible
   regression in an edge case, not a pure win.
3. **Decision point (record the outcome, don't guess it here):** if step 2 shows
   eviction happens in practice with this app's actual navigation patterns (a
   `/categorize` session realistically involves checking several merchants before
   returning — exactly the eviction-prone shape), keep `_pending-pick.ts` as a
   fallback layer rather than deleting it — read it from `_merchant-row.tsx` only
   when Activity's own preserved state comes back empty. If step 2 shows the
   3-route window comfortably covers real usage (most `/categorize` sessions check
   one merchant, not three, before returning), delete `_pending-pick.ts` and the
   `useSyncExternalStore` plumbing in `_merchant-row.tsx` entirely, per TODOS.md's
   original framing.
4. Verify `prunePendingPicks`' job — "a pick outlives the thing it was about" — has
   an Activity-native equivalent if step 3 kept the module: a stale parked pick for
   a merchant that already got filed elsewhere must not resurface. If the module is
   deleted, confirm this can't happen at all under Activity (fresh `initialGroups`
   arriving via `revalidatePath` on the *visible* route should just not contain the
   stale merchant — verify, don't assume the fresh-props story extends cleanly from
   a *hidden* route being revalidated then re-shown).

## Stage 3 — high-risk routes (most scrutiny, do last)

### `/budget/[year]/[month]`

The specific open question from the Decision section: **when Activity restores a
previously-hidden month, does it re-render with fresh server data, or replay the
exact DOM/state snapshot from when it was hidden?** This determines whether
`_month-editor.tsx`'s flush-on-leave effect (which already handles the "am I
leaving with unflushed edits" half) is sufficient, or whether a second gap opens on
the *return* side — showing a September row's numbers as they were at the moment
you left, even though a `/categorize` action filed a September transaction in the
meantime.

Repro: allocate a category in September, tab through without blurring the whole
island (edits pending, not yet flushed), navigate to October, back to September —
confirm the September edit flushed and is reflected. Then, separately: view
September, navigate away, file a transaction elsewhere that changes September's
spend, return to September within the 3-route window — confirm the spend figure is
current, not the frozen pre-departure snapshot. If the second repro shows staleness,
that is a real finding requiring either an explicit revalidation trigger on
becoming visible again (the guide's `useLayoutEffect`-on-mount idiom, adapted) or,
if that proves disproportionate, recording this route's own scope decision to keep
its current unmount-driven-freshness behavior another way (e.g., `instant = false`
plus documenting that this specific page trades the Activity win for correctness) —
a decision to bring back to this plan's review, not to resolve silently.

### `/sync`

Full flow, not spot checks, given the pinned `react19-form-replay-defeats-hydration-
gate-fix` memory: hydration timing already interacts with this route's forms in a
non-obvious way once. Verify: the reversal review queue's list-membership unmount
(a linked/rejected pair leaving `linkedPairs`) still drops its stale message
correctly (expected: unaffected, this is local list reconciliation, not route-level
Activity — verify to confirm, not assume); `SyncButton`/`_submit-button.tsx`'s
`useFormStatus`-driven `PendingFieldset` behaves correctly on a page that was
Activity-hidden mid-pending-state (navigate away while a sync is in flight — a
scenario this route did not have to consider before, since leaving used to unmount
the in-flight request's UI entirely); and the `intent`-field fail-safe (rule 4's
`LINK_INTENT`/`REJECT_INTENT`) still refuses correctly rather than defaulting after
an Activity-restored re-render of the reversal card.

### `/transactions`

`_retarget-form.tsx` already carries two open TODOS.md P4 findings about stale
state surviving a searchParam-only merchant navigation (not keyed by
`normalizedMerchant`) — both assessed as low-severity *because* the server
re-verifies everything and the blast radius is a misleading UI default, not data
corruption. Activity-based preservation across a full route departure-and-return
plausibly widens the window for the same class of staleness (now also reachable via
"leave `/transactions` entirely, come back" not just "change the merchant
search param"). Re-verify both TODOS.md findings' severity assessment holds under
the new model before calling this route clear; if the widened window changes the
risk calculus, resolve `key={normalizedMerchant}` on `<RetargetForm>` here rather
than leaving it deferred a second time.

## Tests

This migration has no `src/lib/` pure-function surface — every real risk is in
`"use client"` UI components, which CLAUDE.md's own convention already excludes
from automated test coverage ("Tests for UI components (categorization logic
only)"). Verification is entirely the browser repro steps named per stage above,
which is a deliberate departure from this plan's normal "boil the ocean" test bias:
there is no unit-testable surface here to boil.

`pnpm test` and `tsc --noEmit` still gate every stage as a regression backstop for
anything the migration touches outside the UI layer (route-config exports, the
`next.config.ts` change itself).

## Failure modes

| Codepath | Failure | Verified how | User sees |
|---|---|---|---|
| `/sync`, `/api/health` `dynamic` export | Build error under Cache Components | `pnpm build` in Stage 0 | N/A — caught before merge |
| Any route with unreachable sync IO in a prerender path | Build error | `pnpm build` + grep in Stage 0 | N/A — caught before merge |
| Stage 1 dialog/form re-open after nav-away-and-back | Stale state shown | Live browser repro per route | Confusing UI (wrong toggle state, stale success message) — not data-unsafe |
| `_month-editor.tsx` restored-but-stale figures | Wrong spend/planned number shown after returning to a month | Live browser repro, Stage 3 | Same class of bug TODOS.md already documents as previously shipped once |
| `/sync` mid-pending navigation-away | Unknown until verified — this is the point of Stage 3's dedicated pass | Live browser repro, Stage 3 | TBD — recorded as a finding, not guessed here |
| `_pending-pick.ts` guarantee gap (Stage 2) | A parked pick lost after >3 intervening routes, if module deleted | Live browser repro, Stage 2 | Same UX regression D19 originally fixed, in a narrower case |

## Worktree parallelization

Sequential by design — each stage's verification gates the next, and Stage 3's
findings may change what Stage 2 does (e.g., if `/sync`'s Activity interaction
turns out to need `instant = false` broadly, that changes whether the flag is worth
flipping app-wide at all vs. scoping this differently). Do not parallelize stages.

## Implementation Tasks

- [x] **T1 (P2)** — Stage 0: flipped `cacheComponents: true`. Removed the two
  `dynamic` exports. The sync-IO grep and `pnpm build`'s route table together
  found THREE real, unanticipated problems, not two, and they split into two
  distinct root causes rather than one (pre-landing review, maintainability
  specialist — the original version of this entry conflated both under "both
  are synchronous better-sqlite3 reads," which was only true of the first).
  **(a) Silent build-time freezes** — `/api/health` and `/budget/categories`
  both do a plain synchronous `better-sqlite3` read with no other tracked
  dynamic API of their own, which the Cache Components validator cannot see
  (unlike `fetch`/`cookies`/`searchParams`), so both were silently eligible
  for static prerendering rather than raising a build error the way a
  `new Date()` read does — fixed with `await connection()` on each.
  **(b) A hard `pnpm build` FAILURE, not a freeze** — `Spine`'s root-layout
  `connection()` call (already present before this migration) blocked the
  static shell of every route with nothing else to make it dynamic, chiefly
  `/_not-found`; separately, `SpineMonth`/`SpineTabs` read `usePathname()`,
  a client hook unavailable pre-hydration, which blocks the same shell for a
  different reason. Fixed with a `<Suspense>` split (`Spine`/`SpineFallback`/
  `SpineContent`, plus the same treatment for `SpineMonth` and `SpineTabs`,
  both of which read client hooks that block an unwrapped static shell).
  `pnpm build` + `pnpm test` clean.
- [x] **T2 (P2)** — Stage 1: verified all 8 low-risk routes live. Found the bug
  class the "expected: no change needed" reasoning missed — Activity preserves
  a route's ENTIRE subtree, including local disclosure toggles that stay open
  with a stale success message after leaving and returning, not just
  route-level data. Fixed 4 real instances (`CardTermsDisclosure`,
  `ReconcileDisclosure`, `/goals`' two forms, `/import`'s `CreateAccountForm`)
  with two new shared hooks.
- [x] **T3 (P2)** — Stage 2: verified `/categorize`'s Activity-native pick
  preservation and ran the eviction-gap repro — survived 8+ intervening
  distinct-route visits on both `pnpm dev` and a production standalone build,
  well past the documented "3 routes" figure. **Decision: DELETE
  `_pending-pick.ts`.** Replaced with plain `useState` in `_merchant-row.tsx`
  (actually a stronger guarantee than the old sessionStorage version — no
  `prunePendingPicks` needed, since component state has no afterlife to prune).
- [x] **T4 (P2)** — Stage 3a: ran both restored-freshness repros live
  (unflushed edit surviving a month-to-month round trip; a remote spend change
  showing up fresh on return). Both correct with zero code changes — effect
  cleanups fire on Activity-hide the same as unmount, and `revalidatePath`
  correctly busts the Activity-cached RSC payload.
- [x] **T5 (P2)** — Stage 3b: ran the navigate-away-mid-pending-sync repro
  live against a real (demo) SimpleFIN connection — the sync completed in the
  background and the page rendered its result correctly on return, no stuck
  pending state, no console errors. Cleared.
- [x] **T6 (P2)** — Stage 3c: the widened window (full route departure, not
  just a searchParam-only merchant change) changes TODOS.md's original risk
  scoping for `_retarget-form.tsx`'s two deferred P4 findings, so resolved
  `key={merchant}` on `<RetargetForm>` now rather than leaving it deferred a
  second time.
- [x] **T7 (P2)** — TODOS.md's line-1335 entry and both `_retarget-form.tsx`
  P4 entries marked closed with the actual outcome. CHANGELOG.md entry still
  pending the version bump at ship time.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Outside Review | — | Independent 2nd opinion | 0 | unavailable | not run this session |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 1 major finding during Step 0 (the flag's global, non-incremental state-preservation behavior, and its interaction with three unmount-dependent correctness patterns) — surfaced to the user via AskUserQuestion, who chose to proceed with an audit-first staged plan rather than drop the work; the finding is what this plan's Decision/Stage structure exists to resolve, not an unresolved risk left in the plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run — no new UI surface, only navigation-model behavior of existing UI |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **OUTSIDE COVERAGE:** Not run this session. Worth noting for whoever picks up
  Stage 3: an outside-voice pass specifically on `/sync`'s Activity interaction,
  given the pinned cross-model pitfall about that route's hydration-replay
  behavior, would be higher-value there than a generic second opinion on the whole
  plan.
- **VERDICT:** SHIPPED (2026-09-17). All 7 tasks complete; every decision point
  was resolved by a live repro rather than inference, per this project's own
  "Claimed Limitations Need Evidence" discipline. `pnpm build`, `pnpm test`
  (2241 tests), `tsc --noEmit`, and `pnpm lint` all clean. Two build-time
  freeze bugs and four live stale-state regressions were found and fixed along
  the way — none were anticipated by the plan's own Stage 1 "expected: no
  change needed" reasoning, which is exactly why this was staged and verified
  live rather than flipped blind. See TODOS.md's line-1335 entry for the full
  outcome writeup and file list.

NO UNRESOLVED DECISIONS
