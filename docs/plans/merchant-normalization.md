# Merchant normalization — collapse reference tokens, timestamps, and truncation variants

**Status:** T1, T2 and T4 done 2026-09-07. T3, T5, T6 not started. Decisions
D2=A and D3=B taken 2026-09-07, then D1=D / D2=A / D3=A at ship time, which
pulled T4 forward and decoupled it from T3 (see "Why T4 shipped with T1+T2").
No schema change: the backfill is a script, not a migration, so `0019` is still
unused.
**Migration number:** `0019` (verified against `origin/main`, which tops out at
`0018_liability_accounts.sql`; worktree is level with origin, `0 0`).

## Why

`src/lib/normalize.ts` has twelve rules and **none of them touch a `*` reference
token**. It strips `POS`/`ATM`/`SBI` prefixes, `Ref#`, phone numbers, `#1234`, a
trailing six-digit run and a trailing two-letter state. That was the right rule set
for the Star One memo shapes it was written against; it is not the rule set the real
ledger needs.

Measured against the live ledger (Docker volume `my_money_manager_mm_data`,
2026-09-07, 1540 rows):

```
298 of 1540 rows (19%) carry a * reference token
131 of the 341 uncategorized singleton merchants are that shape
 54 groups /  66 rows carry an embedded date+time and can NEVER repeat
```

Every one of those is a merchant group of exactly one, which means two things at
once: `/categorize`'s bulk-by-merchant surface cannot batch them, and
`buildRuleMatcher` can never match a future row, because the reference token is
unique per purchase. A rule trained on `AMAZON MKTPL*5H7A39 AMZN.COM/BILL` is dead
on arrival. **This is why every Amazon transaction has to be categorized by hand,
forever.**

## The six classes

These are not one problem. Two of them point in opposite directions, which is the
whole reason this needs a plan rather than a regex.

```
 CLASS 1 — brand-first: the merchant is BEFORE the *          ~60 rows
   AMAZON MKTPL*5H7A39 AMZN.COM/BILL   43  ─┐
   AMAZON.COM*OE9Z329K AMZN.COM/BILL   10   ├─→ AMAZON
   AMAZON PRIME*RV8CL5 AMZN.COM/BILL    7  ─┘
   AUDIBLE*3I95N0A03 AMZN.COM/BILL      7   ──→ AUDIBLE
   SAFEWAY.COM*1652704                  4   ──→ SAFEWAY

 CLASS 2 — processor-first: the merchant is AFTER the *       ~68 rows   ⚠ THE TRAP
   TST* APPELLATION LO LODI            31 rows, MANY different restaurants (Toast)
   SQ *BLOCK 21 WINERY LODI            28 rows, MANY different merchants  (Square)
   DD *SMALLCAKESCUPCA DOORDASH.COM     3                                 (DoorDash)
   EB *80S HALLOWEEN P                  2                                 (Eventbrite)
   also: FD*, FSP*, WL*, SPO*
   ── A naive "take everything before the *" makes one bucket called TST
      holding 31 unrelated restaurants. Worse than the disease.

 CLASS 3 — trailing location noise
   TST* POUR PLAY SAN RAMON  ==  TST* POUR PLAY          one bar
   COSTCO WHSE MANTECA (52)  ==  COSTCO WHSE TRACY (1)   one merchant

 CLASS 4 — truncation variance                            ⚠ NO REGEX FIXES THIS
   SAVE MART MANTE MANTECA  8 ─┐
   SAVEMART MANTEC MANTECA  8  ├─→ SAVE MART      the SPACE moves
   SAVE MART RIPO RIPON     1 ─┘
   WAL-MART MANTECA         6 ─┐
   WM SUPERCENTER MANTECA   8  ├─→ WALMART        three names, one store
   WALMART.COM 8009256      3 ─┘
   ── This is the alias table's job (decision D3=B).

 CLASS 5 — embedded timestamp                              54 groups / 66 rows
   MOBILE 01/09/2026 12:43:41            ─┐
   MOBILE 02/12/2026 14:29:34 MEMO: ...   ├─→ MOBILE     54 groups collapse to 13,
   ONLINE 03/14/2026 21:23:00            ─┘               and to ~2 if the MEMO
                                                          tail is stripped too.
   ── Guaranteed-unique forever. Pure noise.

 CLASS 6 — processor domain suffix                          3 groups / 12 rows
   SQ *BLOCK 21 WINERY GOSQ.COM  ·  DD *... DOORDASH.COM
```

## What this is NOT coupled to

Worth stating plainly, because it looks scarier than it is:

- **`import_row_hash` is `sha1(date | amount_cents | raw_description | raw_memo |
  row_index)`.** It does not include `normalized_merchant`.
- **`contentSignature` is `date|amount_cents|raw_memo`.** Also not.

So renormalizing **cannot touch dedup**. CLAUDE.md rules 3 and 4 are untouched by
this change.

**The couplings are `category_rules.match_value` AND
`subscription_dismissals.normalized_merchant`.** An earlier draft of this plan
said "the only coupling is `category_rules.match_value`", and scoped T4 from that
sentence. The dismissals table also stores a normalized merchant as a key, under
its own `subscription_dismissals_merchant_unique` index and with no foreign key to
`transactions`, so a stale value there is doubly bad: the subscription resurfaces
as active AND the orphaned dismissal is unreachable from the UI, because
`/subscriptions` only renders a dismissal that also appears in the detected set —
`restoreSubscriptionAction` can never be offered for it. The table is empty today,
which is exactly why the miss survived review. `scripts/backfill-merchants.src.mjs`
migrates both.

- **The 730 existing categorizations are safe.** `transactions.category_id` is a
  stored column, not derived from the merchant string. Renormalizing changes what
  future rows *match*, never what past rows *are*.
- **The column is fully recomputable.** `normalized_merchant` is derived from
  `raw_memo`, which is stored verbatim (rule 3 requires it). A bad normalizer is one
  re-backfill away from undone — which is what makes D2=A reversible.
- **The original is already preserved.** `raw_description` and `raw_memo` hold the
  exact bytes; `transactions.payee` already exists as a display-only field with the
  precedent *"categorization keys on `normalized_merchant`, never on `payee`."* No
  new column is needed to keep the original around.

## Data flow

```
  raw_memo (stored verbatim, never touched)
      │
      ▼
  normalizeMerchant(raw)                      ← src/lib/normalize.ts
      │   existing 12 rules  (POS/ATM/SBI, Ref#, phone, #123, state)
      │   NEW: class 5 timestamp strip
      │   NEW: class 6 processor-domain strip
      │   NEW: class 1/2 star split  ── PROCESSOR_PREFIXES decides direction
      │   NEW: class 3 trailing-city strip   (guarded: never empty, never city-only)
      │   NEW: class 4 alias lookup          ← merchant_aliases table
      ▼
  transactions.normalized_merchant
      │
      ├──→ buildRuleMatcher  ──→ category_rules.match_value (exact | contains)
      └──→ loadMerchantGroups ──→ /categorize bulk-by-merchant
```

Three write paths call it, all covered by the same change:

| Caller | Line |
|---|---|
| `src/lib/importBatch.ts` (CSV) | `:85` |
| `src/lib/simplefin/mapTransaction.ts` (sync) | `:66` |
| `src/lib/accounts/manualTransaction.ts` (manual) | `:277`, `:429` |

## Acceptance criterion

Simulated end to end against the live ledger. **These are the numbers the
implementation must reproduce**, not aspirations:

```
                        BEFORE      AFTER      Δ
  All 1540 rows
    merchant groups        516        355    -161
    singletons             354        221    -133

  The 580-row backlog
    merchant groups        385        260    -125
    singletons             341        209    -132

  Top groups after:  AMAZON 61 · COSTCO WHSE 53 · CHEAPER CIGARETTES 39
                     ONLINE 25 · WALMART 19 · SAVE MART 17 · MOBILE 15
                     → 229 of 580 rows reachable in seven bulk actions
```

## Tasks

- [x] **T1 (P1, human: ~3h / CC: ~25min)** — normalize — Add classes 5, 6, 1, 2 to `normalizeMerchant` ✅ DONE 2026-09-07
  - `PROCESSOR_PREFIXES` is an exported `Set` (TST, SQ, DD, EB, FD, FSP, WL, SPO, PP, PAYPAL, PY, IC),
    the single thing deciding which side of the `*` the merchant is on.
  - Order matters, and the shipped order is NOT the one this bullet originally gave.
    The new classes sit BETWEEN the existing leading-noise rules and the existing
    trailing-noise rules, in four phases:
      1 leading noise (Card #:, POS/ATM/SBI)  2 reference tokens (timestamp, MEMO:,
      domain, star split)  3 trailing noise (Ref#, phone, ACH, #store, state)
      4 location + tail (city, store number, residual domain, punctuation)
    Why: `POS 0220 1937 794511 SQ *TAPPED APPLE LL Salida CA` splits on the star into
    pre=`POS 0220 1937 794511 SQ`, which is not a known processor, so a star-split-first
    order takes the brand-first branch and keeps the POS prefix as the merchant.
    And the city strip can only see the city after the trailing state code is gone.
  - Files: `src/lib/normalize.ts`, `src/lib/normalize.test.ts`
  - Verify: `pnpm test` **and** `pnpm build` (vitest does not typecheck — see learning
    `mm-vitest-does-not-typecheck-run-build-before-committing-tests`)

- [x] **T2 (P1, human: ~1h / CC: ~10min)** — normalize — Class 3 city strip, with both guards ✅ DONE 2026-09-07
  - Strip a trailing known city, but **never** when it would leave the string empty or
    leave only the city. The simulation produced a group literally named `MANTECA` (6 rows)
    without this guard.
  - Files: `src/lib/normalize.ts`, `src/lib/normalize.test.ts`

- [ ] **T3 (P1, human: ~4h / CC: ~35min)** — schema — `merchant_aliases` table + migration `0019`
  - `(id, match_value TEXT NOT NULL UNIQUE, canonical TEXT NOT NULL, created_at, updated_at)`.
    Applied as the last step of `normalizeMerchant`, so an alias always wins.
  - Seed from the measured residue (~13 entries): SAVE MART ×4, WALMART ×3, AMAZON ×3,
    SAFEWAY, TARGET, BJ S RESTAURANTS.
  - Additive table, no rebuild — but the T4 backfill in the same migration touches
    `transactions`, so it still runs through `scripts/migrate.mjs` (rule 7), never `drizzle-kit migrate`.
  - Files: `src/db/schema.ts`, `drizzle/0019_*.sql`

- [x] **T4 (P1, human: ~1 day / CC: ~90min)** — script — Backfill `normalized_merchant`, rewrite the rules
  - **Done 2026-09-07, shipped with T1+T2** rather than after T3. Not a migration:
    the recomputation needs `normalizeMerchant`, which is TypeScript, so it cannot
    be expressed as drizzle SQL. It is a script following the `snapshot-cli.src.mjs`
    pattern — `scripts/backfill-merchants.src.mjs`, esbuild-bundled into the Docker
    image, invoked on the host by `pnpm db:backfill-merchants`.
  - Recomputes `normalized_merchant` for all 1540 rows **from `raw_memo`**, never
    from the existing key. That is what makes the rewrite exact rather than
    dependent on the normalizer being idempotent.
  - Rewrites `exact` rules by joining through the rows (old key -> that row's
    `raw_memo` -> new key), so a rule lands where its own transactions landed.
    Measured: all 68 resolve this way, 0 need a fallback, 0 are ambiguous.
  - **Collision dedup keeps the highest `priority`, then the most recently UPDATED
    rule** — matching `compareRules` in `src/lib/rules.ts`. An earlier draft said
    "highest priority, then lowest `id`", which is the inverse: lowest id is the
    OLDEST rule, and on this ledger 1 of the 3 collisions would have reverted the
    user's most recent training (`JACK IN THE BOX`: Dining, trained first, over
    Fast Food, trained after).
  - **A collision whose rules disagree about the category refuses to apply** without
    an explicit `--resolve-conflicts`. It is the only change here that moves money
    between envelopes.
  - Snapshot first (rule 5, `VACUUM INTO`, under `PRE_MIGRATE_PREFIX` so it is not
    evicted by the retention-of-10 pre-import pool), everything in one transaction,
    `integrity_check` + `foreign_key_check` after.
  - Files: `scripts/backfill-merchants.src.mjs`, `scripts/db-backfill-merchants.mjs`,
    `scripts/build-docker-artifacts.mjs`, `scripts/backfill-merchants.test.mjs`
  - Verified against a `VACUUM INTO` copy of the live ledger: 1010 rows rewritten,
    45 rules rewritten, 5 deleted (68 -> 63), `integrity_check: ok`, 0 FK violations,
    0 null keys, 730 categorized rows preserved exactly, 0 temp values left behind,
    and a second run is a clean no-op (0 changes).

- [ ] **T5 (P2, human: ~3h / CC: ~30min)** — categorize — Alias CRUD on `/budget/categories` or `/categorize`
  - Decision D3=B is "curated, not inferred" — so the table needs a surface. Minimum:
    list, add, delete. Adding an alias re-runs the backfill for affected rows only.
  - Files: `src/lib/categorize/`, `src/app/categorize/`

- [ ] **T6 (P2, human: ~1h / CC: ~10min)** — categorize — Re-run auto-categorization over the backlog
  - After T4, ~125 previously-unmatchable groups can now hit a trained rule. Offer a
    one-shot "apply rules to uncategorized rows" action reusing `buildRuleMatcher`, with
    the existing `import_batch_categorizations` undo path.
  - Files: `src/lib/rules.ts`, `src/lib/categorize/`

## Measured result — T1 + T2, no schema change (2026-09-07)

Read-only dry run against the live ledger (Docker volume, `readonly: true`, nothing
written). **T1+T2 alone land within a few groups of the full six-class target that
assumed the alias table.**

```
                       BEFORE   T1+T2    PLAN TARGET (incl. aliases)
  All 1540 rows
    groups                516     361    355
    singletons            354     222    221

  The 580-row backlog
    groups                385     265    260
    singletons            341     211    209

  top after:  AMAZON 60 · COSTCO WHSE 53 · CHEAPER CIGARETTES 39 · ONLINE 25
              MOBILE 15 · WM SUPERCENTER 9 · SAVE MART MANTE 8
              -> 209 backlog rows reachable in the top 7 bulk actions
  guards:     0 bare-processor groups · 0 bare-city groups · 0 empty groups
  largest merges: 67 old keys -> AMAZON (76 rows) · 33 -> ONLINE · 21 -> MOBILE
```

**Two corrections this run forces on T3/T4:**

1. **The alias table is worth ~5 groups, not the ~13 entries' worth the plan
   implies.** The deterministic pass does nearly all the work. T3/T4 should be
   re-justified on that basis — the remaining truncation residue is visible above as
   `WM SUPERCENTER 9` / `WAL-MART 7` / `SAVE MART MANTE 8` / `SAVEMART MANTEC 8`,
   roughly 32 rows across 4 groups, plus `AMAZON MKTPLACE PMT` (3 rows, no star so
   no rule reaches it).
2. **`category_rules` holds 91 rows, but only 68 are `exact`.** The other 23 are
   `contains`, whose `match_value` is a substring and NOT a normalized key, so the
   rewrite pass neither can nor should touch them. T4's original "rewrite the 68
   exact rules" was right; the 91 figure conflates the total with the exact subset.
   A `contains` rule is the more dangerous shape precisely because a backfill cannot
   repair it — if the token stops appearing in any key, the rule is dead permanently.
   Two were headed that way (`AMAZON PRIME` 8 rows -> 0, `GOOGLE ONE` 9 -> 0) and
   both were saved by the D2 table fix, not by the backfill. `normalize.test.ts`
   pins both tokens as reachable.

Known cosmetic residue, left deliberately: `MANTECA MANTECA` (6 rows) is the T2 guard
working — those are ATM withdrawals whose merchant name genuinely is the city
(`ATM 0301 1818 421618 *MANTECA MANTECA CA`). Reducing it to a bare `MANTECA` would
create exactly the meaningless bucket the guard exists to prevent. Natural T3 alias
entry.

Verification archived in `.context/merchant-normalization-sim/` (gitignored): the four
original simulation scripts that produced the acceptance table, plus `dryrun.mjs`.

## Test plan

`normalize.test.ts` is a pure-function suite and every class gets cases:

| Class | Must assert |
|---|---|
| 1 brand-first | `AMAZON MKTPL*5H7A39 AMZN.COM/BILL` → `AMAZON`; `AUDIBLE*3I95N0A03 …` → `AUDIBLE` |
| 2 processor-first | `SQ *BLOCK 21 WINERY LODI` → `BLOCK 21 WINERY`; **and that `TST*` never yields `TST`** |
| 3 city strip | `TST* POUR PLAY SAN RAMON` == `TST* POUR PLAY`; guard: never returns `MANTECA` alone |
| 4 alias | `SAVEMART MANTEC MANTECA` and `SAVE MART MANTE MANTECA` both → `SAVE MART` |
| 5 timestamp | `MOBILE 01/09/2026 12:43:41` → `MOBILE`; memo tail stripped |
| 6 domain | `SQ *BLOCK 21 WINERY GOSQ.COM` → `BLOCK 21 WINERY` |
| edge | leading `*` (`*MANTECA`); empty result falls back to the original, never `""` |
| regression | all 12 existing rules still pass unchanged |

**Migration test (T4):** run `scripts/migrate.mjs` against a `VACUUM INTO` copy of the
live ledger and assert the acceptance table's numbers exactly, plus 1540 rows in / 1540
out and 730 categorizations preserved. This is the same dry-run discipline
`load-the-ledger.md` used, and it is the only way to find a rule collision before it
hits the real database.

## Failure modes

| Failure | Test | Error handling | Visible? |
|---|---|---|---|
| Processor prefix missing from the set → 31 restaurants merge into `TST` | T1 test asserts it | none needed — set is the guard | would be silent; the test is the control |
| Rule collision on backfill | `backfill-merchants.test.mjs` | dedup, keeping the rule `compareRules` would have picked | printed per collision; a CATEGORY conflict refuses to apply without `--resolve-conflicts` |
| A `contains` rule's token stops appearing in any key | `normalize.test.ts` pins the seeded tokens | none — unrepairable by backfill | **silent**, and permanent |
| Shipping the normalizer without the backfill | measured, not tested | none | **silent** — auto-categorization drops 672 -> 196 rows |
| A stale `subscription_dismissals` key | `backfill-merchants.test.mjs` | rewritten with the rows | **silent**, and the orphan is unreachable from the UI |
| City strip empties the string | T2 guard + test | fall back to original | silent without the guard |
| A new processor appears in a future feed | — | none | **silent** — new singletons reappear. Watch the singleton count. |

The last row is the one to keep an eye on: this fix is a snapshot of the merchant
shapes present on 2026-09-07. Re-measure the singleton count after a month.

## NOT in scope

- **Fuzzy / similarity matching.** Decision D3=B chose a curated alias table instead. A
  threshold that merges `SAVE MART MANTE`/`SAVEMART MANTEC` also merges
  `TARGET 00015 MANTECA` with `TARGET T-2347 LATHROP` — different stores, and a silent
  wrong merge moves money between envelopes with no error.
- **Per-store granularity.** `COSTCO WHSE MANTECA` and `COSTCO WHSE TRACY` both become
  `COSTCO WHSE`. If you ever want per-store reporting, `raw_memo` still has it.
- **Backfilling `transactions.payee` on CSV rows.** Display-only, unrelated.
- **The `/transactions` bulk-categorize action.** The original T5 from the eng review.
  Re-measure after this lands — 209 residual singletons may not justify it.
