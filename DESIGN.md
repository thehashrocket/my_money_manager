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

5. **Monthly summary strip**: four cells in a `grid grid-cols-2 sm:grid-cols-4`. Same visual as the `SummaryStrip` in `src/app/budget/[year]/[month]/page.tsx` — don't extract a shared component yet (two uses, different contexts).

6. **Backlog tile** (when count > 0): amber-tinted surface using `color-mix(in oklch, var(--accent-amber) 18%, var(--background))`. Count in `font-bold text-foreground`, amount in amber-muted. "Categorize backlog →" link right-aligned.

7. **Quick links** at the bottom: two `btn-outline` buttons — "Open budget" → `/budget`, "View transactions" → `/transactions`.

8. **Remaining card** coloring: `text-money-pos` when positive, `text-destructive` when negative, `text-money-zero` when zero. Same logic as `RemainingCell` in the budget page.

### What the dashboard is NOT

- Not the envelope table (that lives on `/budget/[year]/[month]`)
- No trend chart (Weekend 5, Recharts not yet in stack)
- No subscription insights (Weekend 4)
- No goals progress (Weekend 5)

---

## Envelope card

Signature component. Already implemented at `src/components/ledger/envelope-card.tsx`.

Key detail: `::before` pseudo-element creates a folded-flap corner top-right (`position: absolute; top: -22px; right: -22px; width: 60px; height: 60px; background: var(--bg-inset); transform: rotate(45deg); border-bottom: 1px solid var(--border)`).

Progress bar fill states:
- Normal: `bg-accent-ledger`
- Warning (≥80%): `bg-amber-500`
- Over: `bg-destructive`

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

Not yet built as shared components. Inline them in the dashboard empty state for now.
