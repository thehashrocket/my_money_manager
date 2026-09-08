# Design Reference — my_money_manager

Ledger Paper design system. Warm, analog, personal — feels like a notebook, not a bank.

Source of truth for visual decisions. See `design_handoff_nav_and_design_system/README.md` for the full handoff. See `design_handoff_nav_and_design_system/Design System.html` and `Nav Prototype.html` for live specimens.

---

## Design system summary

### Fonts (all loaded in `layout.tsx`)
| Role | Font | CSS var |
|------|------|---------|
| Display / headings / envelope names | Newsreader (serif) | `font-display` |
| UI / body | Geist | `font-sans` |
| Money / labels / timestamps / mono chrome | Geist Mono | `font-mono` |

### Color tokens (all defined in `globals.css`)

| Token | Role |
|-------|------|
| `--paper-0/1/2/3/4` | Warm neutral surfaces (bg → dividers) |
| `--ink-1/2/3/4` | Warm neutral text (primary → disabled) |
| `--accent-terracotta` | Primary action, brand |
| `--accent-ledger` | Positive money, success |
| `--accent-redbrown` | Negative money, destructive |
| `--accent-amber` | Backlog / warning |
| `--accent-indigo` | Info, transfer-paired |
| `--money-pos/neg/zero` | Semantic money colors |
| `--rule-faint/regular/strong` | Divider lines |

Tailwind utilities: `text-terracotta`, `text-ledger`, `text-redbrown`, `text-amber-accent`, `bg-paper-0`, `bg-paper-2`, `text-ink-2`, etc.

#### Amber inventory (T17d/DS48)

`--accent-amber` carries more than one meaning, distinguished today only by context — nothing in the codebase enforces the split. DS40 (T15) already resolved the one pair that used to render identically (an envelope at 80% vs 120%, §"Envelope card" below). Auditing every remaining use, on the token (not the raw Tailwind `amber-*` palette, called out separately):

| Meaning | Where | Uses the shared `color-mix(…, var(--accent-amber) …)` formula? |
|---|---|---|
| Uncategorized backlog exists | `BacklogBanner.tsx`; dashboard's `BacklogTile` (`src/app/page.tsx`); Spine's `.spine-tab.backlog .tab-count` chip (`globals.css`) | Yes |
| Left to Budget: month started, still unassigned | `left-to-budget.tsx`'s `AMBER_MIXED` | Yes |
| F1 misconfiguration (no income category) | `_reclassify-income.tsx`'s banner | Yes |
| Sync warnings (drift, stale balance, connection issue) | `sync/page.tsx`, `sync/ActionForm.tsx` | Yes (banners); `text-amber-700 dark:text-amber-400` at `sync/page.tsx:478` does not — raw Tailwind, not the mixed formula |
| Expense envelope progress bar, warn/over fill (DS40) | `budget/[year]/[month]/_month-editor.tsx`'s `BAR_CLASS.amber` (`envelope-card.tsx`'s `FILL_COLORS` is gone — D8 deleted the component, which held a drifted redbrown-on-overspend copy of this rule) | N/A — a fill color, not text; the 3:1 contrast concern DS8′/DS13 raised is text-specific |
| Import preview: calendar-invalid rows, pending badge | `import/preview/[id]/page.tsx` | **No** — raw `amber-300`/`amber-50`/`amber-800`/`amber-700`, not Ledger Paper tokens at all |
| Categorize/transactions sticky backlog banners | `categorize/_categorize-ui.tsx`, `transactions/_transactions-ui.tsx` | Yes — converted by D21 (merchant-drilldown PR); same 18%/45%/50% mix as `BacklogBanner` |
| Uncategorized row badge | `transactions/_transaction-row.tsx`'s `CategoryBadge` | Yes — converted by D21. D20 made this one load-bearing: it is the only badge colour encoding a *state* rather than a label, which is why it stays amber while every other category badge is monochrome |
| Trend chart's 4th category color | `globals.css`'s `--chart-4: var(--accent-amber)` | N/A — categorical chart color, not a warning at all; coincidence of hue, not shared meaning |

**What DS48 anticipated vs. what's actually here:** DS48 named four meanings (backlog-exists, categorize-count, late-assigning, `stale`). The real count is higher — sync warnings, the F1 banner, the progress-bar fill, and the chart color all also use the token, and **one** surface still uses the *raw* Tailwind amber palette instead of the token at all — `import/preview` — which is a second, separate kind of drift `mm-design-system-documented-not-adopted` already named. It was three: D21 (the merchant-drilldown PR) converted the two sticky backlog strips and the transaction row badge, and deliberately left `import/preview` alone because it sits on the import path, the most correctness-critical code in the repo. That last one is tracked in `TODOS.md`. Distinguishable today by context; enforced by nothing. No consolidation in this pass — recorded so a future change to `--accent-amber` (or a future addition of a fifth meaning) has one place to check for blast radius, per DS48's own scope.

### Money display rules
- **Positive**: no sign, `text-money-pos` in summaries. Neutral in transaction rows.
- **Negative**: parentheses `($1,204.50)`, `text-money-neg` in totals and overspend. Neutral in rows.
- **Zero**: `$0.00`, `text-money-zero` (never red).
- **Liability balance** (stored negative): `plain` — full-strength body ink,
  never `text-money-neg`. See "Money weight" below.
- Always `[font-variant-numeric:tabular-nums]` wherever money appears.
- Thousands are grouped: `($302,480.11)`. `formatCents()` emits both the parens
  and the separators — use it everywhere. (It used a bare `.toFixed(2)` until
  liability accounts made four-figure-plus amounts routine, so the formatter
  and this rule silently disagreed.)
- **Parens are SILENT to a screen reader.** Any always-negative figure needs
  an explicit `aria-label` (`owed $2,148.00`, `negative $291,212.87`) — DS66.

### Radii
`radius-xs` (4px) → `radius-sm` (6px) → `radius-md` (10px) → `radius-lg` (14px) → `radius-xl` (20px). Use `999px` only for chips and pill toggles.

### Shadows
Whisper only. `shadow-soft` for raised surfaces. `shadow-lift` for floating panels. Never blur >24px.

### Spacing cadence
4 / 8 / 12 / 16 / 20 / 28 / 40 / 56 px. Avoid the shadcn 24/48/64 cadence.

**Adopted app-wide as of v0.16.0.** This rule was documented from the start
and followed almost nowhere: every page shell in `src/app/` used `p-6` (24px)
and section rhythm was a mix of `space-y-6` (24px) and `space-y-8` (32px,
which is not on the scale at all). The settled values are:

| Role | Class | px |
|---|---|---|
| Page gutter | `p-5` | 20 |
| Section rhythm | `space-y-7` | 28 |

`space-y-7` was already what `/budget/[year]/[month]` used, so the rhythm
matched the most on-system page rather than inventing a third answer. The
gutter went down rather than up because a 375px screen has little to spare and
this branch's 44px touch targets already claim vertical space.

One coupling to remember: the sticky backlog strips (`_categorize-ui.tsx`,
`_transactions-ui.tsx`, `BacklogBanner.tsx`) bleed to full width with a
negative margin that must EQUAL the page gutter (`-mx-5` against `p-5`). Change
one without the other and the strip overhangs the page by the difference.

### Motion (DS41)
Two durations, one easing, defined once in `globals.css`'s `:root`:

| Token | Value | Use |
|-------|-------|-----|
| `--motion-quick` | 160ms | state feedback (PR2a's cell `saving`/`saved` border, T16c's copied-row highlight) |
| `--motion-settle` | 240ms | completion (the Left to Budget zero-transition, DS6′) |
| `--motion-ease` | `cubic-bezier(0.2, 0, 0, 1)` | both |

One global `@media (prefers-reduced-motion: reduce)` rule (also in `globals.css`) disables every `transition-*`/`animate-*` app-wide. Individual components reference the tokens (`duration-[var(--motion-settle)]`) and do **not** add their own `motion-reduce:` variant — that used to mean remembering reduced-motion once per animated element, which is how it ended up honored on only one of four motions.

---

## Navigation — Spine

Fixed left rail, 240px. Main content: `pl-[290px]` (240 + 50 gutter). Below 820px: stacks above content, full width.

```
┌─────────────────────┐
│ my money manager    │  ← Newsreader italic, terracotta accent word
│ jason · local       │  ← mono xs, ink-3
│                     │
│ ‹ April 2026 ›      │  ← month picker, links to /budget/year/month
│                     │
│ ◇ Dashboard  ←──── active tab: translateX(8px), right border erased
│ ▤ Accounts          │  ← DS68: position 2 — the two "where do I stand"
│ ▣ Budget            │     surfaces before the three "what do I do" ones
│ ≡ Transactions      │
│ ! Categorize [12]   │  ← amber chip when backlog > 0
│ ↻ Subscriptions     │  ← disabled, tooltip "Coming Weekend 4"
│ ★ Goals             │  ← disabled, tooltip "Coming Weekend 5"
│ ─────────           │
│ ⟳ Sync              │
│ ↥ Import            │
│                     │
│ PEEK · BALANCES ›   │  ← DS68: a <Link> to /accounts, with a visible
│                     │     affordance (hover underline + persistent ›).
│ Checking  $3,482    │  ← balance peek, mono sm — ASSETS ONLY (DS50)
│ Savings   $8,210    │
│ ──────────────      │
│ cash    $11,692     │  ← D4=A: "cash", not "total". Liabilities never
└─────────────────────┘     render here.
```

**The peek is assets-only, and the subtotal is `cash` (DS50 + D4=A).** The rail
answers "can I afford this", and net worth cannot. Listing a mortgage above a
subtotal labelled `cash` would produce a figure that visibly does not sum its
own rows — a closure violation on every page in the app. Debt lives on `/` and
`/accounts`, which you reach deliberately. Side benefit: no truncation rule is
needed in a 240px rail, where `($302,480.11)` in 13px mono leaves ~100px for a
name and `.peek-acct` has no `min-width` or ellipsis.

**Rail background**: subtle horizontal gradient — 10% terracotta tint at far left fading to `--paper-1`.

**Binding stitch**: dashed vertical line at `left: 18px` — `repeating-linear-gradient` of 6px dashes, ink-1 @ 25%.

**Active tab**: `translateX(8px)`, `::after` pseudo-element at `right: -1px` with `width: 2px, background: var(--bg-raised)` to erase the right border seam. Left-only border-radius: `radius-md 0 0 radius-md`.

**Hover**: `translateX(2px)`, background gets 50% of raised.

**Month picker**: shows the currently-viewed budget month when on `/budget/...`, otherwise real current month. Uses `usePathname()`.

Spine is implemented at `src/components/ledger/spine.tsx`. Mounted as a Server Component in `src/app/layout.tsx`.

---

## Dashboard page (`/`)

**Option A: Command center.** Not a repeat of `/budget`. Higher-level overview: where am I financially, what needs attention, where do I go next.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  [BacklogBanner if count > 0]                        │
│                                                      │
│  April 2026  ← page heading, Newsreader, text-xl     │
│                                                      │
│  ASSETS                     ← DS49: ruled row-lists,  │
│  ┌──────────────────────────────┐   not a card grid   │
│  │ Checking          $3,482.19  │                     │
│  │ ──────────────────────────── │                     │
│  │ Savings           $8,210.04  │                     │
│  │ ──────────────────────────── │                     │
│  │ Cash             $11,692.23  │ ← recessed subtotal │
│  └──────────────────────────────┘                     │
│  LIABILITIES                                          │
│  ┌──────────────────────────────┐                     │
│  │ Visa             ($1,448.00) │                     │
│  │ Mortgage      ($302,480.11)  │ ← muted (DS59)      │
│  │ ──────────────────────────── │                     │
│  │ Debt          ($304,351.61)  │                     │
│  │   paid down $500.00 this mo. │ ← DS58, omitted at 0│
│  └──────────────────────────────┘                     │
│  ══════════════════════════════   ← ledger double rule│
│  NET WORTH      ($291,212.87)  ← SAME size as the two │
│                                   subtotals (DS51)    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ This month                                   │    │
│  │ Allocated $4,200  Spent $2,140  Remaining $2,060 │ │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  CLOSEST TO LIMIT           ← DS53, ruled list, 5/3   │
│  ┌──────────────────────────────────────────────┐    │
│  │ Groceries                    ($100.00) left  │    │
│  │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▮  │    │
│  │ $600.00 of $500.00 · $100.00 over            │    │
│  └──────────────────────────────────────────────┘    │
│  (section omitted entirely when no leaf has either   │
│   an allocation or spend this month)                 │
│                                                      │
│  Spending — last 6 months  ← demoted one slot: the   │
│                              only section read       │
│                              monthly, not daily      │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ ! 14 uncategorized transactions  ($842.00)   │    │
│  │                      Categorize backlog →    │    │
│  └──────────────────────────────────────────────┘    │
│  (hidden when backlog = 0)                           │
│                                                      │
│  → Open budget    → View transactions                │
└─────────────────────────────────────────────────────┘
```

### Data sources
| Section | Source |
|---------|--------|
| Asset / liability row-lists | `loadAccountBalances()` + `summarizeBalances()` (`src/lib/accounts/`) |
| `paid down … this month` | `paidDownCents()` — paired positives only (E13) |
| Closest to limit | `rankByProximity(view.sections.flatMap(s => s.categories), phase, 5 \| 3)` — the SAME `loadMonthView` object the summary strip already reads. No new query. |
| Monthly summary strip | `loadMonthView(db, year, month).summary` from `src/lib/budget/loadMonthView.ts` |
| Backlog tile | `loadMonthView(db, year, month).uncategorizedBacklog` |

### Implementation notes

1. **`await connection()`** at the top of the page — required (Next 16 prerender freezes `new Date()` without it). Same pattern as `src/app/budget/page.tsx`.

2. **Empty state** when `accounts.length === 0`: a single centered card with `∅` mark, muted text "No accounts yet", and a link to `/import`. Use the same card shell as the other states (see `Section 06` in `Design System.html`).

3. **BacklogBanner**: reuse `src/app/_components/BacklogBanner.tsx` with `variant="budget"`. Show only when `backlog.count > 0`. The banner already uses `--accent-amber` tokens.

4. **Balance section — ruled row-lists, NOT tiles (DS49).** `AccountTile` (a
   `grid-cols-1 sm:grid-cols-2` of bordered boxes) is gone. Codex's
   outside-voice pass hard-rejected it on two counts — "#1 generic SaaS card
   grid as first impression" and "#7 app UI made of stacked cards instead of
   layout" — and adding liability tiles plus proximity tiles on top of it is
   what makes the mosaic. A card whose entire content is a name and a number
   is a `<div>` with a border tax. Same idiom as `/accounts`, deliberately:
   two surfaces answering "where do I stand" should not look like two
   different products.

   Account name in `font-display text-base`; balance in `font-mono text-lg`
   with `moneyToneClass(cents, { context })`. Subtotal rows (`Cash`, `Debt`)
   are recessed `--bg-inset`, carry no date and no action, and are the last
   row INSIDE their panel. Net worth sits under a ledger double-rule at
   **subtotal size** (DS51) — the rule already carries the "bottom line"
   signal, and type size on top of it is shouting a six-figure negative at
   someone who opened the page already anxious about debt.

   A mortgage renders muted with no bar and no action (DS59), derived from
   `isLongTermLiability(type)` and never from the absence of a credit limit
   (E7). Every liability figure carries `aria-label={`owed ${…}`}` — DESIGN.md
   mandates accounting parens, and parens are SILENT to a screen reader
   (DS66).

9. **Closest to limit (DS53)** sits between the summary strip and the trend
   chart. Ranked by `rankByProximity` (`src/lib/budget/rankByProximity.ts`),
   **not** by `barPct`: `resolveRowDisplay` caps `barPct` at 100 *and*
   flattens zero-allocation overspend to exactly 100, so an envelope at
   100.0%, one at 400%, and one with no budget and $600 spent all sort
   identically. Four keys — overflow badge amount desc, `barPct` desc,
   absolute headroom asc, then name. 5 rows desktop / 3 mobile via a
   `hidden sm:block` pair. Rows use `display.amountPlaceholder` to say
   "no budget set" rather than rendering `of $0.00` (DS14).

5. **Monthly summary strip**: renders through the shared `SummaryStrip` (`src/components/ledger/summary-strip.tsx`, `cells: {label, cents, tone?}[]` contract) with `variant="plain"` — the dashboard's original bordered-card look, kept on purpose (DS45) rather than importing the budget page's `"ledger"` ruled-surface restyle onto a page whose own redesign hasn't been reviewed (§8). `"ledger"` is what `/budget/[year]/[month]` uses. Delete `"plain"` when the dashboard lands its own restyle — at that point every caller is `"ledger"`.

6. **Backlog tile** (when count > 0): amber-tinted surface using `color-mix(in oklch, var(--accent-amber) 18%, var(--background))`. Count in `font-bold text-foreground`, amount in amber-muted. "Categorize backlog →" link right-aligned.

7. **Quick links** at the bottom: two `btn-outline` buttons — "Open budget" → `/budget`, "View transactions" → `/transactions`.

8. **Remaining card** coloring: `text-money-pos` when positive, `text-money-neg` when negative, `text-money-zero` when zero — the `SummaryStrip` cell's own `tone` prop, not a bespoke component. The budget page's per-row remaining figure uses the same three-way split, but reads its tone from `resolveRowDisplay` (`src/lib/budget/resolveRowDisplay.ts`, C1) rather than this cell-level prop; `RemainingCell` (the pre-PR1b component this used to reference) no longer exists.

### What the dashboard is NOT

- Not the envelope table (that lives on `/budget/[year]/[month]`)
- No subscription insights (those live on `/subscriptions`)
- No goals progress (that lives on `/goals`)

The 6-month trend chart did land here in v0.7.0 — `SpendingTrends` is
rendered by `src/components/ledger/trend-chart.tsx`, and now sits one slot
lower, below `Closest to limit` (DS49): it is the only section on this page
read monthly rather than daily.

As of v0.19.0 its bars carry a **signed** spend figure (a refund nets against
the category's spend, matching `/budget`), so the stack uses Recharts'
`stackOffset="sign"`: a negative group draws below the axis instead of being
painted back over its neighbour above it, and the tooltip keeps negative
values rather than filtering to positives — otherwise a refund-heavy category
disappeared from the hover panel while its bar stayed on screen. In the
tooltip those figures take the three-way money tone rather than a fixed
`text-money-neg`: outflow reads `text-money-neg`, a net refund reads
`text-money-pos`, and exactly zero is muted, because painting $0.00 red reads
as an outflow. A group that
nets to exactly zero is dropped from the chart and its legend, so "empty"
means nothing to draw rather than no rows.

---

## Accounts page (`/accounts`)

The second "where do I stand" surface, in the same idiom as the dashboard's
balance section. Grouped ruled row-lists with the subtotal as the last row
inside each panel, and a ledger double-rule above net worth.

```
  Accounts                                    ← Newsreader, modest. Not a hero.

  ASSETS                                      ← mono uppercase, --ink-3, --text-xs
  ┌──────────────────────────────────────────────────────────────────┐
  │ Checking          updated Sep 6              $3,482.19           │  ← no icon (DS60)
  │ ──────────────────────────────────────────────────────────────── │
  │ Savings           updated Sep 6              $8,210.04           │
  │ ──────────────────────────────────────────────────────────────── │
  │ Cash                                        $11,692.23           │  ← recessed --bg-inset,
  └──────────────────────────────────────────────────────────────────┘     no date, no action

  LIABILITIES
  ┌──────────────────────────────────────────────────────────────────┐
  │ Visa                                       ($2,148.00)           │
  │   ▬▬▬▬▬▬▬▬▬░░░░░░░░░░░  $2,148.00 of $5,000.00                   │  ← terracotta, no
  │   min. payment $50.00 · reconciled Sep 6                         │     threshold (DS62)
  │   paid down $500.00 this month                                   │  ← omitted at $0 (DS58)
  │   [ Reconcile ] [ Add a charge ]                                 │  ← 44px targets (DS66)
  │ ──────────────────────────────────────────────────────────────── │
  │ LONG-TERM                                                        │  ← a real <h3> (DS66)
  │ Mortgage                                 ($302,480.11)           │  ← muted ink, no bar (DS59)
  │   as of Sep 6                            [ Refresh ]             │
  │ ──────────────────────────────────────────────────────────────── │
  │ Debt                                     ($304,628.11)           │
  │   paid down $500.00 this month                                   │
  └──────────────────────────────────────────────────────────────────┘
  ════════════════════════════════════════════════════════════════════  ← ledger double rule
  NET WORTH                                   ($292,935.88)             ← SAME size as the two
                                                                           subtotals (DS51)
```

**No icon badges (DS60).** Every generated mockup put a circular tinted icon
badge left of each account name. That is AI-slop blacklist item 3, and it is
not this app's icon idiom: the Spine established bare monochrome text glyphs
(`◇ ▤ ▣ ≡ ! ↻ ★ ⟳ ↥`) with no circles and no tint. The account name is set in
a serif display face and already says "Checking".

**Rows are inert.** No chevrons, no drill-in. A per-account detail page has
almost nothing to show — a card carries a handful of manual rows and the
mortgage has literally zero by D3=A — so it would be a route that renders an
empty list.

**Exactly one balance action per row, never both, never neither (DS55).**
Derived by `resolveBalanceAction(account, hasAnyRows)`: a feed-linked account
with no transaction rows offers `Refresh`, everything else offers `Reconcile`.
It is per-row rather than a page-level button because eligibility is a
per-account property — a page-level "Refresh balances" would silently do
nothing for the Visa and owe the user a sentence like "1 refreshed, 2
skipped".

**Zero liabilities keeps the section (DS54).** One neutral `--bg-inset` row
reading "No liabilities tracked yet" plus "Add a credit card or loan →".
Hiding it would leave a page named Accounts with no path to the account type
the feature exists to add.

---

## Utilization bar

`resolveUtilizationDisplay(balanceCents, creditLimitCents) → { pct, hasLimit }`.

**Always terracotta. There is no warn threshold, and this is deliberate.** A
"your utilization is high" state would be financial advice — the one thing
cut from every generated mockup (variant C invented *"Your debt is 20.7% of
your assets. A good rule of thumb is to keep this under 30%. Learn more →"*:
invented advice with an external link, in an app whose premise is that nothing
leaves the machine). `--accent-amber` also already carries nine distinct
meanings per the amber inventory below; 43% utilized is not a warning and must
not add a tenth.

`hasLimit: false` means render no bar at all — absence of a limit is absence of
something to show, and is NOT what decides the muted long-term treatment (E7).
The bar is `aria-hidden`; the `$2,148.00 of $5,000.00` caption beside it is the
accessible value.

---

## Money weight — the muted long-term treatment

A third money weight beside the three states above: `text-ink-3` on a
liability whose `isLongTermLiability(type)` is true.

A mortgage is a fact about your life; a card balance is a problem you are
solving this month. Rendered identically, a $302k figure sets the emotional
register of a page whose real subject is the $2,148 you can act on. Because
lower-contrast ink is invisible to a screen reader, `LONG-TERM` is a real
grouping heading, never muting alone (DS66).

`moneyTone(cents, { context })` (`src/lib/money.ts`) owns the sign→token rule
for all four tones. In `liability` context a negative balance returns `plain`
(full-strength body ink), never `negative`: owing money is the normal state of
the account, and an alarm that can never be cleared is not an alarm, it is
just a red page.

---

## Backlog banner

`src/app/_components/BacklogBanner.tsx`. Two variants: `"budget"` (shows CTA link) and `"categorize"` (omits CTA, caller handles the counter). Uses `--accent-amber` via `color-mix`.

`_categorize-ui.tsx`'s `BacklogHeader` and `_transactions-ui.tsx`'s `BacklogStrip` are near-duplicates that reimplement the shell rather than reuse it, each for something the component does not expose (a live client-side count and a progress counter; a `Bulk →` link). D21 put all three on the same amber formula so the colour can no longer drift three ways — the shell still can. Collapsing them onto a `trailing` slot is tracked in `TODOS.md`.

---

## Focus ring

`src/components/ledger/focus-ring.ts` exports `FOCUS_RING`, the one focus treatment for interactive elements **outside** `components/ui` — links, `<summary>` disclosures, and buttons written inline. The shadcn primitives carry their own `focus-visible:ring-*` and are not in scope for it.

`outline`, not `ring`: an outline is drawn outside the border box and takes no part in layout, so `outline-offset` can push it clear of a control without displacing its neighbours in a dense ruled row — a `ring`'s box-shadow spread has to be budgeted against the row's own padding instead. It **does** follow `border-radius` (CSS UI 4, honoured by every browser this app targets), so it is not a way to get a rectangle around a rounded control — but it is also not a reason to expect a rounded one: of the 17 `${FOCUS_RING}` interpolations across six files, 7 carry `rounded-md` and get a rounded ring, and the other 10 are bare links and `<summary>` disclosures with no radius at all — the two classes the constant exists for — so they get a rectangle, because that is the shape of their border box. No consumer carries `rounded-[999px]`; the one pill control that does (the merchant chip's `×`) deliberately opts out of `FOCUS_RING` for a paper-coloured ring against the terracotta fill. It is also not immune to an ancestor's `overflow-hidden` — that clips an outline exactly as it clips a box-shadow. The choice buys layout independence, not shape and not clipping.

Known divergence: `FOCUS_RING` uses `--accent-terracotta` at full strength while `globals.css` defines `--ring` as the same accent at 55%, which is what every shadcn control uses. Two treatments, not one. Tracked in `TODOS.md`; changing it makes the hand-rolled ring visibly softer, so it wants both seen side by side first.

---

## State components (empty / loading / error / success)

Shared card shell, swap the accent:

| State | Mark | Accent surface |
|-------|------|----------------|
| Empty | `∅` | `--bg-inset` (neutral) |
| Loading | `◐` (spinning) | `--bg-inset` |
| Error | `!` | `color-mix(in oklch, var(--accent-redbrown) 12%, var(--bg))` |
| Success | `✓` | `color-mix(in oklch, var(--accent-ledger) 12%, var(--bg))` |

Built at `src/components/ledger/state-card.tsx` (C5): `<StateCard variant="empty" | "loading" | "error" | "success" title description? primaryAction? secondaryAction? />`. `error.tsx` and `loading.tsx` boundaries render through it rather than one-off markup per route (T14, T17c). Nine of the ten route `error.tsx` boundaries now go through a shared `RouteErrorCard` (`src/app/_components/RouteErrorCard.tsx`) instead of duplicating the `StateCard` wiring per route — it always surfaces `error.digest` for prod log correlation and takes an optional `reassurance` slot for routes with a real snapshot-before-write guarantee (CLAUDE.md rule 5); `src/app/sync/error.tsx` predates it and hasn't been migrated. The dashboard's own inline empty state (`src/app/page.tsx`) predates this and hasn't been migrated — same `mm-design-system-documented-not-adopted` shape this table used to describe from the other direction.
