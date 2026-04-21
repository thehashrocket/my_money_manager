# Handoff — Navigation + Design System (Ledger Paper)

## Overview

This bundle adds **primary navigation** and a first-pass **design system** to `my_money_manager`. Up until now the app has had no chrome (pages were reachable only by URL) and no shared visual language. These designs introduce both at once under a single aesthetic — **Ledger Paper**: warm, analog, personal. The brief was to feel less like a bank and more like a notebook you actually use.

**Scope delivered:**
1. A token-level design system (color, type, spacing, radii, shadows, money display rules) in `tokens.css`.
2. A set of primitive components (buttons, chips, inputs, envelope cards, transaction tables, states) in `primitives.css`.
3. **Three navigation variants** — Spine, Ticker, Dock — explored as one prototype. The **Spine** is the recommended default (see "Recommended choice" below).

## About the design files

The two HTML files in this bundle are **design references**. They are prototypes built in plain HTML/CSS/JS to communicate look, structure, and interaction — they are **not** production code to copy directly into the app.

Your job is to recreate them inside the existing `my_money_manager` codebase, which is:

- Next.js 16 (App Router, Turbopack) + React 19 + TypeScript
- Tailwind v4 + shadcn/ui (base-nova style, Base UI primitives)
- Geist + Geist Mono already loaded via `next/font/google`

Map the tokens into Tailwind v4 CSS variables in `src/app/globals.css`, build the nav as a React component that wraps the App Router layout, and use the existing shadcn primitives (Button, Dialog) where possible — only introduce new primitives when the design genuinely requires them.

## Fidelity

**High-fidelity.** Exact colors (oklch), typography, spacing, radii, and interaction details are finalized. Recreate pixel-perfectly. The only creative latitude: adapt the primitives to match shadcn-base-nova's class/prop conventions rather than copying the raw CSS class names in `primitives.css`.

---

## Recommended choice

The user picked **Spine** as the primary variant. Ship Spine. Keep the other two (Ticker, Dock) as internal reference only — don't implement them unless explicitly requested.

### Why Spine
- Works with the existing `max-w-5xl` content columns used on `/transactions` and `/budget` — doesn't fight the page-level padding already in place.
- Surfaces the three things the user asked to expose in nav chrome: **page links, current month, balance peek** — all at once, without a second row of chrome.
- The ledger-book metaphor reinforces the design-system narrative better than a generic top bar.

---

## Design tokens

All tokens are defined in `design/tokens.css`. Port them into `src/app/globals.css` under the existing `:root` + `.dark` blocks, replacing shadcn's default neutrals.

### Fonts
- **Display**: `Newsreader` (Google) — serif, used for headings, brand mark, envelope category names, page titles. Add to `layout.tsx` via `next/font/google`.
- **UI**: `Geist` (already loaded) — sans, everywhere else.
- **Mono**: `Geist Mono` (already loaded) — money, timestamps, labels, uppercase chrome.

```tsx
// layout.tsx addition
import { Newsreader } from "next/font/google";
const newsreader = Newsreader({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
});
```

### Color palette (oklch)

All accents share chroma `0.09` by design — no single accent shouts louder than another.

**Paper (warm neutrals, bg)**
| Token | Light | Dark |
|---|---|---|
| `--paper-0` (card highlight) | `oklch(0.995 0.004 85)` | `oklch(0.20 0.012 60)` |
| `--paper-1` (canvas / bg) | `oklch(0.985 0.008 85)` | `oklch(0.165 0.010 60)` |
| `--paper-2` (inset / muted) | `oklch(0.965 0.010 85)` | `oklch(0.14 0.010 60)` |
| `--paper-3` | `oklch(0.935 0.012 85)` | `oklch(0.265 0.012 60)` |
| `--paper-4` | `oklch(0.895 0.014 85)` | `oklch(0.32 0.012 60)` |

**Ink (warm neutrals, fg)**
| Token | Light | Dark |
|---|---|---|
| `--ink-1` (primary text) | `oklch(0.22 0.015 60)` | `oklch(0.95 0.010 85)` |
| `--ink-2` (muted) | `oklch(0.42 0.012 60)` | `oklch(0.78 0.012 85)` |
| `--ink-3` (subtle / placeholder) | `oklch(0.58 0.010 60)` | `oklch(0.60 0.012 85)` |
| `--ink-4` (disabled) | `oklch(0.72 0.008 60)` | `oklch(0.42 0.012 85)` |

**Accents**
| Token | Light | Dark | Role |
|---|---|---|---|
| `--accent-terracotta` | `oklch(0.62 0.09 45)` | `oklch(0.72 0.11 45)` | Primary action, brand italic word |
| `--accent-ledger` | `oklch(0.55 0.09 155)` | `oklch(0.74 0.12 155)` | Positive money, success |
| `--accent-redbrown` | `oklch(0.52 0.09 25)` | `oklch(0.70 0.12 25)` | Negative money (totals), destructive |
| `--accent-amber` | `oklch(0.72 0.09 75)` | `oklch(0.82 0.12 75)` | Backlog, warning |
| `--accent-indigo` | `oklch(0.50 0.09 270)` | `oklch(0.72 0.12 270)` | Info, transfer-paired |

**Rules (hand-ruled divider lines)**
- `--rule-faint`: ink-1 @ 8% alpha
- `--rule-regular`: ink-1 @ 14% (default border)
- `--rule-strong`: ink-1 @ 22%

### Type scale
| Size | px | Role |
|---|---|---|
| `--text-xs` | 11 | Labels, caps, mono chrome |
| `--text-sm` | 13 | Secondary UI, row subtitles |
| `--text-base` | 15 | Body |
| `--text-md` | 17 | Envelope category name, card heading |
| `--text-lg` | 20 | Sub-headings |
| `--text-xl` | 24 | Section H2 |
| `--text-2xl` | 32 | Display H2 |
| `--text-3xl` | 44 | Page title hero |

### Spacing
`4, 8, 12, 16, 20, 28, 40, 56` px — comfortable (iOS-ish). Avoid the shadcn default 24/48/64 cadence.

### Radii (soft, never pill for containers)
- `--radius-xs`: 4px
- `--radius-sm`: 6px (inputs)
- `--radius-md`: 10px (buttons, envelopes)
- `--radius-lg`: 14px (big cards)
- `--radius-xl`: 20px (dialogs)

Use `999px` only for chips, switches, and the mini-toggle pill.

### Shadows (whisper only)
- `--shadow-hair`: 1px hair line at 6% alpha (for kbd-style lifts)
- `--shadow-soft`: 1px blur + 1px border — default raised surface
- `--shadow-lift`: 6px/24px lift — for floating elements (tweaks panel, dock peek)

Never use blur radii >24px. The aesthetic depends on rules and borders doing the heavy lifting, not shadows.

### Paper grain (texture)
A three-layer radial-gradient dot pattern at ~2.5% alpha, sized 7/11/13 px. Apply via `.paper-grain` class on `<body>`. It's subtle — if you can see the dots clearly you've made it too strong. See `design/tokens.css` for the exact recipe.

### Money display conventions
- **Positive amounts**: no sign, `--money-pos` (ledger green) when in totals/summaries. In transaction rows leave neutral.
- **Negative amounts**: wrap in `($1,204.50)` parentheses — banking convention. Color `--money-neg` (red-brown) in totals and overspend labels; leave neutral in individual transaction rows (most spending is expected).
- **Zero**: `$0.00` in `--money-zero` (ink-3), never red.
- **Decimal/symbol de-emphasis** (tight tables only): `<span class="subtle">$</span>42<span class="subtle">.07</span>`.
- Use `font-variant-numeric: tabular-nums` everywhere money appears. Already present globally in the prototype.
- The existing `src/lib/money.ts` `formatCents` function already emits parens for negatives — keep using it.

---

## Components

`primitives.css` contains the raw implementations. Recreate these as React components under `src/components/ui/` or `src/components/ledger/` following shadcn conventions (`cva`, `cn`, Base UI primitives where applicable).

### Button
Variants: `default` (neutral), `primary` (terracotta), `outline`, `ghost`. Sizes: `sm` (28px), `default` (34px), `lg` (42px). Radius `md`. `:active` presses down 1px — keep this.

### Chip
Pill (border-radius 999px), 22px tall. Variants: neutral, `chip-amber` (backlog), `chip-ledger` (transfer-paired). Has an optional `.chip-dot` 6px left indicator.

### Input / Select
36px tall, `--radius-sm`, `var(--border)` ring. Focus ring = 3px `--ring` (terracotta @ 55%). Labels are mono caps, 11px, 0.02em tracking.

### Envelope card (signature component)
The product's hero component. See `.envelope` in `primitives.css`.
- 1px border, `--radius-md`, 16/18/14 padding.
- A `::before` pseudo-element fakes a folded-flap corner on the top-right — keep this, it's the analog detail that sells the metaphor.
- Contents: category name (`var(--font-display)`, 17px) + percent (mono muted) + 6px progress bar + amounts row (mono, spent emphasized).
- Progress fill states: default (ledger-green), `.over` (redbrown), `.warn` (amber).

### Transaction row table
Standard table. Uppercase mono headers (11px, 0.04em tracking), faint bottom rule between rows, strong rule under header. Hover highlights entire row with `--bg-inset`. Amount column is `.num` (right-aligned mono).

### Backlog banner
The existing `BacklogBanner.tsx` in the repo uses amber. Keep its structure but swap the Tailwind `amber-*` classes for the new `--accent-amber` tokens.

### States
Four specimens in Section 06 of `Design System.html`:
- Empty (muted, `∅` mark)
- Loading (spinning `◐`)
- Error (redbrown-tinted surface, `!` mark)
- Success (ledger-tinted surface, `✓` mark)

All use the same card shell; only the accent is swapped.

---

## Navigation — the Spine (recommended)

See `Nav Prototype.html` — the default variant. Also see the `.spine*` rules in the file's `<style>` block.

### Structure

```
<aside class="spine">
  [brand]   "my money manager"  +  owner tag "jason · local"
  [month]   ‹ April '26 ›        (current period, clickable)
  [tabs]    Dashboard
            Budget          (active)
            Transactions
            Categorize  [12]   ← amber count chip
            Subscriptions
            Goals
            Import             (slight gap above, separated)
  [peek]    Balances
            Checking  $3,482.19
            Savings   $8,210.04
            ────────
            total     $11,692.23  (ledger-green)
</aside>
```

### Layout specifics
- Fixed-position left rail. **240px wide.** Main content offsets with `padding-left: 290px` (240 rail + 50 gutter).
- Background is a subtle horizontal gradient: 10% terracotta tint at the far left fading to `--paper-1` at the right edge, so the rail reads as a colored book-edge.
- A dashed vertical line at `left: 18px` mimics stitched binding — `repeating-linear-gradient` of 6px dashes, ink-1 @ 25%.
- The active tab physically sticks **8px to the right**, with its right border "erased" so it joins the content surface:
  - `transform: translateX(8px)` on `.spine-tab.active`
  - `::after` pseudo-element at `right: -1px, width: 2px, background: var(--bg-raised)` to cover the seam
- Month picker, balance peek, and each tab all have `border-radius: var(--radius-md) 0 0 var(--radius-md)` (left-only radii) and `border-right: none` to feel like paper sticking out.
- Tab count chips: neutral for normal tabs, amber (`--accent-amber` mix) for the Categorize backlog tab.

### Pages to wire (href targets in the existing app)
| Label | Route | Notes |
|---|---|---|
| Dashboard | `/` → not yet built | Currently redirects to `/import`; build a real dashboard later (Weekend 3 per PLAN.md) |
| Budget | `/budget` | Exists |
| Transactions | `/transactions` | Exists |
| Categorize | `/categorize` | Exists. Badge count = live backlog from `loadMonthView` |
| Subscriptions | `/subscriptions` | Future (Weekend 4) — show as disabled or "Coming soon" tooltip |
| Goals | `/goals` | Future (Weekend 5) — show as disabled |
| Import | `/import` | Exists |

For the three existing routes, use `next/link` + `usePathname()` to set the active state.

### Balance peek data
Query the existing accounts + transactions tables to compute current balance per account using the rule from `CLAUDE.md`:
> Balance = `starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)`

This is a client-uncachable server query — render the `<Spine />` from a Server Component that wraps `{children}` in `src/app/layout.tsx` (or a sub-layout above the page tree).

### Interactions
- **Hover** on a tab: color lifts from `--ink-2` to `--ink-1`, background gets 50% of raised, `translateX(2px)`.
- **Active** tab: `translateX(8px)`, raised background, terracotta icon.
- **Month picker** `‹ ›`: navigates to `/budget/[year]/[month]`. Spine month reflects the currently viewed month when the user is on `/budget/...`, otherwise shows the real current month.
- **Keyboard**: not required for Spine, but the prototype reserves `1 2 3 d` for variant/theme switching — drop those in production.

### Responsive
Below 820px the rail stacks above the content (static position, full width, bottom border). Keep this breakpoint.

---

## Dark mode

Parallel design, not an afterthought. Deep warm-ink paper with slightly-boosted accent chroma (0.11–0.12 vs 0.09). All tokens have dark counterparts in `tokens.css`. Use the shadcn pattern: `.dark` class on `<html>`, toggled via a persistent user preference. The prototype stores it in `localStorage` under `ledger-theme`.

---

## Implementation plan (suggested order)

1. **Port tokens** into `src/app/globals.css` — replace the current shadcn neutrals under `:root` and `.dark`. Keep the Tailwind v4 `@theme inline` block; update its `--color-*` references to point at the new variables.
2. **Add Newsreader** to `layout.tsx` and expose its variable as `--font-display`.
3. **Update `src/components/ui/button.tsx`** variants to use the new primary (terracotta) and outlines, and the new radius scale.
4. **Build `src/components/ledger/envelope-card.tsx`** per spec. Replace the inline envelope rendering in `/budget/[year]/[month]`.
5. **Build `src/components/ledger/spine.tsx`** — Server Component that loads account balances + backlog count, renders the rail. Mount in `src/app/layout.tsx` as a sibling of `{children}`, adjust `<body>` layout to flex-row.
6. **Update pages** to remove their now-redundant chrome — the "← Budget" and "Bulk categorize →" inline links in `/transactions/page.tsx` are superseded by the Spine; delete them.
7. **Re-skin `BacklogBanner.tsx`** to use `--accent-amber` tokens instead of literal Tailwind amber classes.
8. **Dark mode toggle** — small pill in the Spine footer or header; persist to localStorage, default to `prefers-color-scheme`.

## Files

- `Design System.html` — canonical token + primitive reference. Every number in the README above has a visual twin here.
- `Nav Prototype.html` — all three nav variants + full Budget-page content underneath. Press **1/2/3** to flip between Spine, Ticker, Dock. **d** to toggle dark. A floating Tweaks panel exposes all toggles.
- `design/tokens.css` — copy these variables into `src/app/globals.css`.
- `design/primitives.css` — copy these component patterns into corresponding React components.

## Assets

No image assets. All iconography is text glyphs (`◇ ▣ ≡ ! ↻ ★ ↥ ‹ ›`) or pure CSS. If you want to replace them with a proper icon set later, pick something matched to the analog aesthetic — Phosphor's `regular` or `duotone` weights are a good fit. Avoid Lucide's default geometric set; too corporate for this brand.

## Open questions for later

- **Dashboard** (`/`) — currently redirects to `/import`. Once real, it's the primary "Home" tab target; design needs a separate pass.
- **Month switcher** behavior on non-Budget pages — does Transactions respect the spine's month, or keep its own? Prototype assumes Budget-only for now.
- **Subscriptions / Goals** tabs — disabled until those pages exist. Confirm copy for the tooltip ("Coming Weekend 4/5").
