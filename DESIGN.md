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
| Expense envelope progress bar, warn/over fill (DS40) | `budget/[year]/[month]/page.tsx`'s `BAR_CLASS.amber`, `envelope-card.tsx`'s `FILL_COLORS.warn` | N/A — a fill color, not text; the 3:1 contrast concern DS8′/DS13 raised is text-specific |
| Import preview: calendar-invalid rows, pending badge | `import/preview/[id]/page.tsx` | **No** — raw `amber-300`/`amber-50`/`amber-800`/`amber-700`, not Ledger Paper tokens at all |
| Categorize/transactions sticky backlog banners | `categorize/_categorize-ui.tsx`, `transactions/_transactions-ui.tsx` | **No** — raw `amber-400`/`amber-100`/`amber-900`/`amber-950`/`amber-100` |
| Uncategorized row badge | `transactions/_transaction-row.tsx` | **No** — raw `amber-200`/`amber-900`/`amber-900`/`amber-100` |
| Trend chart's 4th category color | `globals.css`'s `--chart-4: var(--accent-amber)` | N/A — categorical chart color, not a warning at all; coincidence of hue, not shared meaning |

**What DS48 anticipated vs. what's actually here:** DS48 named four meanings (backlog-exists, categorize-count, late-assigning, `stale`). The real count is higher — sync warnings, the F1 banner, the progress-bar fill, and the chart color all also use the token, and three whole surfaces (`import/preview`, `categorize`/`transactions`' sticky banners, the transaction row badge) use the *raw* Tailwind amber palette instead of the token at all, which is a second, separate kind of drift `mm-design-system-documented-not-adopted` already named. Distinguishable today by context; enforced by nothing. No consolidation in this pass — recorded so a future change to `--accent-amber` (or a future addition of a fifth meaning) has one place to check for blast radius, per DS48's own scope.

### Money display rules
- **Positive**: no sign, `text-money-pos` in summaries. Neutral in transaction rows.
- **Negative**: parentheses `($1,204.50)`, `text-money-neg` in totals and overspend. Neutral in rows.
- **Zero**: `$0.00`, `text-money-zero` (never red).
- Always `[font-variant-numeric:tabular-nums]` wherever money appears.
- `formatCents()` from `src/lib/money.ts` already emits parens for negatives — use it everywhere.

### Radii
`radius-xs` (4px) → `radius-sm` (6px) → `radius-md` (10px) → `radius-lg` (14px) → `radius-xl` (20px). Use `999px` only for chips and pill toggles.

### Shadows
Whisper only. `shadow-soft` for raised surfaces. `shadow-lift` for floating panels. Never blur >24px.

### Spacing cadence
4 / 8 / 12 / 16 / 20 / 28 / 40 / 56 px. Avoid the shadcn 24/48/64 cadence.

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
│ ▣ Budget            │
│ ≡ Transactions      │
│ ! Categorize [12]   │  ← amber chip when backlog > 0
│ ↻ Subscriptions     │  ← disabled, tooltip "Coming Weekend 4"
│ ★ Goals             │  ← disabled, tooltip "Coming Weekend 5"
│ ─────────           │
│ ⟳ Sync              │
│ ↥ Import            │
│                     │
│ Checking  $3,482    │  ← balance peek, mono sm
│ Savings   $8,210    │
│ ──────────────      │
│ total   $11,692     │  ← text-money-pos (ledger green)
└─────────────────────┘
```

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
│  ┌──────────────┐  ┌──────────────┐                  │
│  │ Checking     │  │ Savings      │  ← AccountTile   │
│  │ $3,482.19    │  │ $8,210.04    │                  │
│  └──────────────┘  └──────────────┘                  │
│  Total  $11,692.23  ← ledger green, mono             │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ This month                                   │    │
│  │ Allocated $4,200  Spent $2,140  Remaining $2,060 │ │
│  └──────────────────────────────────────────────┘    │
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
| Account tiles + total | `loadAccountBalances()` from `src/lib/accounts/loadAccountBalances.ts` |
| Monthly summary strip | `loadMonthView(db, year, month).summary` from `src/lib/budget/loadMonthView.ts` |
| Backlog tile | `loadMonthView(db, year, month).uncategorizedBacklog` |

### Implementation notes

1. **`await connection()`** at the top of the page — required (Next 16 prerender freezes `new Date()` without it). Same pattern as `src/app/budget/page.tsx`.

2. **Empty state** when `accounts.length === 0`: a single centered card with `∅` mark, muted text "No accounts yet", and a link to `/import`. Use the same card shell as the other states (see `Section 06` in `Design System.html`).

3. **BacklogBanner**: reuse `src/app/_components/BacklogBanner.tsx` with `variant="budget"`. Show only when `backlog.count > 0`. The banner already uses `--accent-amber` tokens.

4. **Account tiles**: `--bg-raised`, `--radius-lg`, `--shadow-soft`. Account name in `text-sm text-ink-2 font-mono uppercase tracking-wide`. Balance in `text-2xl font-mono`. Type badge (`checking` / `savings`) as a neutral chip.

5. **Monthly summary strip**: renders through the shared `SummaryStrip` (`src/components/ledger/summary-strip.tsx`, `cells: {label, cents, tone?}[]` contract) with `variant="plain"` — the dashboard's original bordered-card look, kept on purpose (DS45) rather than importing the budget page's `"ledger"` ruled-surface restyle onto a page whose own redesign hasn't been reviewed (§8). `"ledger"` is what `/budget/[year]/[month]` uses. Delete `"plain"` when the dashboard lands its own restyle — at that point every caller is `"ledger"`.

6. **Backlog tile** (when count > 0): amber-tinted surface using `color-mix(in oklch, var(--accent-amber) 18%, var(--background))`. Count in `font-bold text-foreground`, amount in amber-muted. "Categorize backlog →" link right-aligned.

7. **Quick links** at the bottom: two `btn-outline` buttons — "Open budget" → `/budget`, "View transactions" → `/transactions`.

8. **Remaining card** coloring: `text-money-pos` when positive, `text-money-neg` when negative, `text-money-zero` when zero — the `SummaryStrip` cell's own `tone` prop, not a bespoke component. The budget page's per-row remaining figure uses the same three-way split, but reads its tone from `resolveRowDisplay` (`src/lib/budget/resolveRowDisplay.ts`, C1) rather than this cell-level prop; `RemainingCell` (the pre-PR1b component this used to reference) no longer exists.

### What the dashboard is NOT

- Not the envelope table (that lives on `/budget/[year]/[month]`)
- No subscription insights (those live on `/subscriptions`)
- No goals progress (that lives on `/goals`)

The 6-month trend chart did land here in v0.7.0 — `SpendingTrends` sits between the monthly summary and the backlog tile, rendered by `src/components/ledger/trend-chart.tsx`.

---

## Envelope card

Signature component. Already implemented at `src/components/ledger/envelope-card.tsx`.

Key detail: `::before` pseudo-element creates a folded-flap corner top-right (`position: absolute; top: -22px; right: -22px; width: 60px; height: 60px; background: var(--bg-inset); transform: rotate(45deg); border-bottom: 1px solid var(--border)`).

Progress bar fill states (`FILL_COLORS` in `envelope-card.tsx`, tone from `resolveRowDisplay`'s `barTone`):
- Normal (`"ledger"`): `bg-[var(--accent-ledger)]`
- Warning/over (`"amber"`, ≥80% including past 100% — DS8′/DS40): `bg-[var(--accent-amber)]`
- (`"redbrown"` exists as a `BarTone` but `resolveRowDisplay` never returns it for a bar fill — overspend renders as a `redbrown` 2px overflow tick instead, layered on the still-amber bar. See T15/DS40 for the amber warn/over split this table doesn't yet capture.)

---

## Backlog banner

`src/app/_components/BacklogBanner.tsx`. Two variants: `"budget"` (shows CTA link) and `"categorize"` (omits CTA, caller handles the counter). Uses `--accent-amber` via `color-mix`.

---

## State components (empty / loading / error / success)

Shared card shell, swap the accent:

| State | Mark | Accent surface |
|-------|------|----------------|
| Empty | `∅` | `--bg-inset` (neutral) |
| Loading | `◐` (spinning) | `--bg-inset` |
| Error | `!` | `color-mix(in oklch, var(--accent-redbrown) 12%, var(--bg))` |
| Success | `✓` | `color-mix(in oklch, var(--accent-ledger) 12%, var(--bg))` |

Built at `src/components/ledger/state-card.tsx` (C5): `<StateCard variant="empty" | "loading" | "error" | "success" title description? primaryAction? secondaryAction? />`. `error.tsx` and `loading.tsx` boundaries render through it rather than one-off markup per route (T14, T17c). The dashboard's own inline empty state (`src/app/page.tsx`) predates this and hasn't been migrated — same `mm-design-system-documented-not-adopted` shape this table used to describe from the other direction.
