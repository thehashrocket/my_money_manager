# Plan — Collapsible instructions on the budget month page

Locked via `/plan-eng-review` 2026-09-05.

## Why

`/budget/[year]/[month]` shows Left to Budget, Income/Expense bands, and Funds
with no explanation of the envelope-budgeting model (plan income → assign
every dollar → Left to Budget hits $0). A first-time or returning-after-a-gap
user has no in-page way to answer "what am I supposed to do here" without
reading the design doc or asking. `FirstRunCard` (`page.tsx:94`) only covers
the one-time zero-allocations render — it disappears the moment income is
planned, so there's no ongoing reference for band semantics (rollover vs
fund carryover, what "still unassigned" vs "over-budgeted" mean, why Funds
is read-only here).

## Approach

**Revised after outside-voice review (2026-09-05) — see decision log below.**
Original draft built this on Base UI's `Collapsible` + a persisted
`localStorage` toggle. Codex's review pass found that `/goals` (`page.tsx:176`,
`:204`) already solves "lightweight collapsible secondary content" with plain
native `<details>`/`<summary>` — zero JS, zero persistence, defaults collapsed
every page load. The original ask was "expand or collapse as needed," not
"remember my choice" — persistence was my own addition, not something
requested. Reuse ladder rung 3 (native platform feature) beats rung 4
(already-installed dependency): switched to `<details>`.

A single `<details>` "How this page works" panel, server-rendered, placed as
a sibling AFTER `MonthEditor` (moved here 2026-09-05 per ship-time design
review — an earlier draft placed it before `MonthEditor`, which put a
generic disclosure ahead of the actual Left-to-Budget hero on a top-to-bottom
scan; this position preserves the hero's primacy while still keeping the
panel a plain page.tsx-level sibling, never threaded through `MonthEditor`'s
client-boundary slots):

```
BudgetMonthPage (server, no new client component)
  │
  ├─ BacklogBanner / ReclassifyIncomeBanner   (unchanged)
  │
  ├─ MonthEditor (existing client island, unchanged — hero/bands render first)
  │
  └─ {!isFirstRun && <BudgetHelpPanel />}   ◄── NEW, plain server component
        <details>/<summary>, static JSX children, no props, no localStorage
        hidden on first-run (Issue 4) — FirstRunCard already owns onboarding
```

No client boundary, no hydration, no `useSyncExternalStore` — those problems
(the flash question, the same-tab `StorageEvent` gap Codex also found)
don't exist for a server-rendered element. Collapses again on every page
navigation, same as `/goals`' own `<details>` — an accepted tradeoff, not an
oversight (see NOT in scope).

**Eng review decision (Issue 4, 2026-09-05):** hides the panel when
`isFirstRun` is true. Without this, `page.tsx:191`'s `isFirstRun` and
`page.tsx:245`'s `FirstRunCard` render independently of anything this plan
adds, so a first-time user got both the full onboarding card and the
generic help panel stacked at once (confirmed by Codex, not caught in the
original draft). One boolean check already computed in `page.tsx`.

**Eng review decision (Issue 5, 2026-09-05):** this panel is a permanent
glossary/reference — it describes what each Left-to-Budget state means in
general, never which state currently applies. `LeftToBudget`
(`left-to-budget.tsx`) already owns live status; this panel takes no props
and must never grow one to report "current" anything. A future edit that
wants to say "you're currently unassigned" belongs in `LeftToBudget`, not
here.

### Copy (first draft, refine in review)

- What this page does: plan income, assign every dollar to a category, watch
  Left to Budget go to $0.
- What all five Left to Budget states mean, as a glossary (no-income /
  progress / unassigned / over / success) — mirrors `left-to-budget.tsx`'s
  `resolveState`, never reports which one currently applies (Issue 5). Ship-time
  red team review caught the original draft covering only 4 of 5 states
  (missing `success` — "every dollar has a job") despite the panel's own
  opening line framing $0.00 as the goal; added as the fifth entry.
- Why Funds is read-only here (link to `/goals`).
- Why Spent can be wrong (link to `/categorize` when backlog > 0) — this one
  overlaps `BacklogBanner`'s own message; keep the panel's line short and
  let the banner stay the authority on the live count.

**Ship-time Codex adversarial pass caught two more copy-accuracy bugs (2026-09-05):**
1. The `success`-state entry originally said "Nothing more to do this month" —
   but `resolveState()` reaches `success` from `leftToBudgetCents === 0` alone,
   with no awareness of the uncategorized-transaction backlog (DS36 already
   documents that `Spent` can be incomplete regardless of allocation state).
   A user could hit $0.00, trust that copy, and stop categorizing while Spent
   stayed silently wrong. Fixed: the entry now says Spent can still be
   incomplete, matching DS36's existing framing instead of overclaiming.
2. The `no-income` entry said "there's nothing to assign yet" — but this page
   explicitly supports a month with expense allocations already set and zero
   planned income (`page.tsx`'s own DS30 comment), and `resolveState()` still
   labels that state `no-income`. Fixed: the entry no longer claims nothing is
   assigned, just that income specifically hasn't been planned yet.

**Codex structured review (`codex review`) caught two more, both self-inflicted
by the placement fix above:**
3. The opening paragraph and the "still unassigned" entry both said "below" —
   accurate when the panel rendered before `MonthEditor`, wrong once it moved
   to render after it (the editable categories are now above the panel, not
   below). Fixed: dropped the directional language entirely rather than
   flipping it, since panel position could change again and spatial claims in
   copy are fragile by nature.
4. The Funds paragraph unconditionally asserted "Funds are read-only here,"
   but the Funds band only renders when `view.summary.fundCount > 0` — an
   account with zero fund categories would read a reference to a UI section
   that doesn't exist on their page. Fixed with a conditional phrasing ("If
   you have Funds categories...") rather than adding a `hasFunds` prop — this
   is a stable per-account setup fact, not the kind of live monthly status
   Issue 5 ruled out, but the simpler no-prop wording fix was preferred over
   reopening that question for a single sentence.

**Eng review decision (Issue 2, 2026-09-05, still applies post-pivot):** the
Left-to-Budget state descriptions are hand-written prose, not derived from
`LeftToBudgetState`. Add a code comment in `_help-panel.tsx` pointing at
`left-to-budget.tsx`'s `resolveState` as the source of truth, so a future
change to that function's states/labels has a pointer back to this copy —
full type-level derivation was considered and rejected as more ceremony than
a handful of lines of static help text warrants.

## Styling

Ledger Paper tokens throughout (page is now fully on-system post-v0.13.0,
not the 0:35 shadcn-default state recorded before D9A landed — verified
directly against the current `page.tsx`/`state-card.tsx`, not assumed from
memory): `bg-[var(--bg-raised)]`, `shadow-soft`, `rounded-lg`,
`text-ink-1`/`text-ink-2`, `font-mono text-xs uppercase tracking-wide` on the
`<summary>`, matching `StateCard`/`SummaryStrip`'s existing shell
conventions — deliberately not copying `/goals`' plain `text-muted-foreground`
treatment for `<summary>`, since this page is on-system and that one isn't.

## Accessibility

`<details>`/`<summary>` are native disclosure semantics — correct
`aria-expanded`-equivalent state, keyboard-operable (Space/Enter on
`<summary>`) with no hand-wiring, for free, in every browser. Nothing to
implement or get wrong here.

## Tests

CLAUDE.md: no UI component tests in V1 (categorization logic only) — this
component is static markup with no logic to unit test (no state, no storage,
no client JS). Verify manually in the browser: default collapsed, hidden on
a first-run month, expand/collapse via mouse and keyboard, collapses again
after navigating to another month (expected, not a bug).

## Files touched

- `src/app/budget/[year]/[month]/_help-panel.tsx` (new — plain server
  component, no `"use client"`)
- `src/app/budget/[year]/[month]/page.tsx` (one import + one JSX insertion,
  gated on `!isFirstRun`)

## NOT in scope

- Per-band inline help (e.g. a `?` next to "Funds") — one page-level panel
  covers the ask; per-band affordances are a separate, larger design pass.
- Persisting open/closed state across page loads — the original ask was
  "expand or collapse as needed," not "remember my choice"; `/goals`' own
  `<details>` don't persist either, and adding it back would reintroduce
  the client-boundary machinery this pivot removed (see Approach).
- Rewriting `FirstRunCard`'s copy to point at this panel — they're now
  mutually exclusive by construction (Issue 4: panel hidden on first-run),
  not worth coupling further.

## What already exists

- `src/app/goals/page.tsx`'s native `<details>`/`<summary>` — this plan's
  final architecture, not a new one.
- `theme-toggle.tsx`'s `useSyncExternalStore`/storage-event pattern —
  evaluated in Issue 1, superseded once the panel dropped persistence
  entirely; the pattern remains the right one for any *future* budget-page
  feature that genuinely needs a persisted client toggle.
- `StateCard`/`SummaryStrip`'s Ledger Paper shell conventions — reused for
  this panel's styling rather than inventing a new visual treatment.

## Review

Ran through Architecture, Code Quality, Test, and Performance review
sections plus an outside-voice pass (Codex, gpt-5.4). The outside voice
found a real architectural miss the in-house review didn't catch (native
`<details>` already used on `/goals`) and two confirmed bugs in the original
draft (first-run duplication, no actual flash-free guarantee for the
localStorage approach) — the plan above reflects the post-review design,
not the original draft. 5 issues raised, all resolved with the user,
0 unresolved, 0 critical gaps. Test coverage: 0 automated (matches
CLAUDE.md's UI-test exclusion and `theme-toggle.tsx` precedent), 4 manual
verification flows captured in the test-plan artifact. No parallelization
opportunity — one small sequential change.

NO UNRESOLVED DECISIONS
