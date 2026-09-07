/**
 * Merchant normalization — turns a raw bank memo into the grouping key stored on
 * `transactions.normalized_merchant`.
 *
 * ORDER IS LOAD-BEARING at the phase boundaries 1-before-2 and 3-before-4, and
 * WITHIN a phase too — treat every ordering here as load-bearing unless a test
 * says otherwise. An earlier version of this header claimed intra-phase steps
 * were "measured reorderable without changing any key"; that is false, and it
 * was an invitation to make a silent key-moving edit. Phase 3's phone rule has
 * to run before TRAILING_STATE, because it matches the trailing state code as
 * part of its own pattern and cannot fire once the state has been stripped.
 * Swapping just those two statements fails seven tests — `GOOGLE *Google One
 * 855-836-3987 CA` settles as `GOOGLE ONE 855-836-3987` — and the fixed-point
 * loop does not rescue it, since `\s+\d{3,}$` will not strip `-5040`.
 *
 * Why that matters more here than in most files: a moved key is silent. Rule 10
 * in CLAUDE.md has the full account — stored keys belong to the generation of
 * the normalizer that wrote them, so any change here needs
 * `pnpm db:backfill-merchants` to land with it.
 *
 *   PHASE 1  card + prefixes    Card #: (trailing, despite the phase name),
 *                               then the POS/ATM/SBI leading prefixes
 *   PHASE 2  reference tokens   timestamp, MEMO: tail, processor domain, the * split
 *   PHASE 3  trailing noise     Ref#, phone, ACH date code, #store, state code
 *   PHASE 4  location + tail    residual domain, city, store number, .COM, punctuation
 *
 * Why phase 2 sits in the middle rather than first:
 *
 *   - It must run AFTER phase 1. `POS 0220 1937 794511 SQ *TAPPED APPLE LL Salida CA`
 *     splits on the star into pre=`POS 0220 1937 794511 SQ`, which is not a known
 *     processor, so the brand-first branch would keep the POS prefix as the merchant.
 *   - It must run BEFORE phase 3. The star split decides which side of the `*` the
 *     merchant is on; phase 3's trailing rules then clean whichever side survived.
 *
 * Why phase 4 is last: the city strip looks for a trailing city, and the city is only
 * exposed once phase 3 has removed the trailing two-letter state code. Running it
 * earlier matches almost nothing, because the string still ends in ` CA`.
 */

/**
 * Payment processors that put THEIR name before the `*` and the real merchant after
 * it. This set is the single thing deciding which side of the star the merchant is
 * on, so adding a processor is a one-line change.
 *
 * Getting this wrong is silent and expensive in one direction only: a processor
 * MISSING from this set collapses every merchant behind it into one bucket named
 * after the processor. `TST` alone covers 31 rows across many unrelated restaurants,
 * so `normalize.test.ts` asserts explicitly that `TST*` never yields `TST`.
 */
export const PROCESSOR_PREFIXES = new Set([
  "TST", // Toast
  "SQ", // Square
  "DD", // DoorDash
  "EB", // Eventbrite
  "FD", // FreedomPay
  "FSP", // FreedomPay / SpotOn family
  "WL", // WorldLine
  "SPO", // SpotOn
  "PP", // PayPal
  "PAYPAL",
  "PY", // PayPal (short form)
  "IC", // Instacart
  "GOOGLE", // Google, for its own products (Google One, YouTube Premium)
]);

/**
 * Trailing words that qualify a brand rather than identify it. Only stripped on the
 * brand-first side of a `*` split, where the pre-star text is known to be the
 * merchant: `AMAZON MKTPL` -> `AMAZON`.
 *
 * Evidence-only, and deliberately shorter than it looks like it should be. Unlike
 * PROCESSOR_PREFIXES, whose risk is asymmetric in the safe direction, an extra
 * entry here is DESTRUCTIVE: it silently eats a trailing word off a real merchant
 * name. Measured over 1540 live memos, exactly two candidates ever appear before a
 * star -- MKTPL (57 rows) and PRIME (8). PRIME is excluded on purpose: it names a
 * distinct billed product, so stripping it folds Amazon Prime into the general
 * AMAZON bucket and strands the seeded `contains 'AMAZON PRIME'` rule. Add an entry
 * only with rows to justify it.
 */
export const BRAND_QUALIFIER_WORDS = ["MKTPL"];

const BRAND_QUALIFIERS = new RegExp(
  `\\s+(${BRAND_QUALIFIER_WORDS.join("|")})$`,
  "i",
);

/**
 * Processor/brand domains that appear as a suffix and carry no grouping information.
 * Applied twice — once in phase 2 and again in phase 4 — because the domain is often
 * shielded by a trailing state code (`SQ *BLOCK 21 WINERY gosq.com CA`) that only
 * phase 3 removes.
 */
export const PROCESSOR_DOMAIN_PATTERNS = [
  "AMZN\\.COM\\/BILL",
  "AMZN\\.COM\\/?",
  "G\\.CO\\/HELPPAY#?",
  "GOSQ\\.COM",
  "DOORDASH\\.COM",
  "TOASTTAB\\.COM",
  "SQUAREUP\\.COM",
  "UBER\\.COM",
];

/**
 * One literal sample per pattern above, index-aligned. Exists so the test loop
 * is driven by the implementation instead of a hand-copied second list; a
 * pattern added without a sample fails a length assertion rather than shipping
 * untested.
 */
export const PROCESSOR_DOMAIN_SAMPLES = [
  "AMZN.COM/BILL",
  "AMZN.COM",
  "g.co/helppay#",
  "gosq.com",
  "doordash.com",
  "toasttab.com",
  "squareup.com",
  "uber.com",
];

const PROCESSOR_DOMAINS = new RegExp(
  `\\s*(${PROCESSOR_DOMAIN_PATTERNS.join("|")})\\s*$`,
  "i",
);

/**
 * Trailing location codes the bank appends. US states + DC, plus ON (Ontario, 8
 * rows). This is an ALLOWLIST rather than `[A-Z]{2}` on purpose, and it is the one
 * thing making the normalizer idempotent: `[A-Z]{2}` also matched a genuine
 * bank-truncated merchant suffix, so a second pass turned `TAPPED APPLE LL` into
 * `TAPPED APPLE` and `HOTEL SUTTER RE` into `HOTEL SUTTER` -- silently moving a key
 * out from under its rule during a backfill.
 *
 * Strictly narrower than the rule it replaces, so it can only preserve information,
 * never destroy more. Verified against all 1540 live memos: every trailing
 * two-letter token in the ledger is in this list, so no first-pass key moves.
 */
const STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY","ON",
];

const TRAILING_STATE = new RegExp(
  `^(.{3,}?)\\s+(?:${STATE_CODES.join("|")})\\s*$`,
  "i",
);

/** `MOBILE 01/09/2026 12:43:41` — unique per transaction, so it can never group. */
const EMBEDDED_TIMESTAMP = /\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s*/;

/** Free-text tail the bank appends to online/mobile transfers. */
const MEMO_TAIL = /\s+MEMO:.*$/i;

/**
 * Cities that appear as a trailing location on Star One memos, derived by frequency
 * from the live ledger rather than guessed. Longest-first so a multi-word city is
 * matched before any single-word city it contains.
 *
 * Deliberately NOT a general city list or a case heuristic. Star One writes the city
 * in Title Case only 46 times out of 525 memos that carry one, and when it does the
 * run mis-segments (`American Conservato San Francisco` -> `Conservato San Francisco`),
 * so case cannot be used to find the boundary. An explicit list is the only thing
 * that does not silently eat part of a merchant name.
 */
export const KNOWN_CITIES = [
  "SAN FRANCISCO",
  "WALNUT CREEK",
  "WALNUT GROVE",
  "SUTTER CREEK",
  "LITTLE ROCK",
  "BENTONVILLE",
  "SACRAMENTO",
  "ELK GROVE",
  "SAN RAMON",
  "SUNNYVALE",
  "CAMBRIDGE",
  "FAIRFIELD",
  "LIVERMORE",
  "STOCKTON",
  "DANVILLE",
  "NEW YORK",
  "ESCALON",
  "LATHROP",
  "MANTECA",
  "MODESTO",
  "OAKDALE",
  "TORONTO",
  "CONWAY",
  "DENVER",
  "FRESNO",
  "SALIDA",
  "TRACY",
  "RIPON",
  "LODI",
].sort((a, b) => b.length - a.length);

/**
 * Precomputed ` CITY` suffixes. The scan below runs once per imported row, so
 * building these per call re-materialized 29 short-lived strings per row.
 * Index-aligned with KNOWN_CITIES.
 */
const CITY_SUFFIXES = KNOWN_CITIES.map((city) => ` ${city}`);

/**
 * True when the whole string is nothing but a city name. Folds case itself
 * rather than relying on an earlier phase having uppercased the string.
 */
function isBareCity(s: string): boolean {
  return KNOWN_CITIES.includes(s.toUpperCase());
}

/**
 * Strip one trailing city, with both guards from the plan: never empty the string,
 * and never reduce it to a bare city name. Without these the ledger grows a merchant
 * group literally named `MANTECA`.
 */
function stripTrailingCity(s: string): string {
  for (let i = 0; i < CITY_SUFFIXES.length; i++) {
    if (!s.endsWith(CITY_SUFFIXES[i])) continue;
    const stripped = s.slice(0, -CITY_SUFFIXES[i].length).trim();
    if (stripped === "" || isBareCity(stripped)) return s;
    return stripped;
  }
  return s;
}

/**
 * Split on the first `*` and keep whichever side holds the merchant.
 * `PROCESSOR_PREFIXES` decides the direction; see the note on that set.
 */
function splitOnReferenceToken(s: string): string {
  const star = s.indexOf("*");
  if (star < 0) return s;

  // A leading `*` has no prefix to classify — drop the star and keep the rest.
  if (star === 0) return s.slice(1).trim() || s;

  const pre = s.slice(0, star).trim();
  const post = s.slice(star + 1).trim();

  // Phase 2 replaces an embedded timestamp with a space, so a memo whose FIRST
  // token was a timestamp reaches here with `star > 0` but an empty prefix. Treat
  // it as a leading star; otherwise the brand-first branch below returns the whole
  // string and emits a key that literally begins with `*`.
  if (pre === "") return post || s;

  if (PROCESSOR_PREFIXES.has(pre.toUpperCase())) {
    // Processor-first: the merchant is AFTER the star.
    return post || s;
  }
  // Brand-first: the merchant is BEFORE the star.
  return pre.replace(BRAND_QUALIFIERS, "").trim() || s;
}

export function normalizeMerchant(raw: string): string {
  // Every guard below falls back to this rather than to a degraded key.
  const cleaned = raw.trim().replace(/\s+/g, " ");
  const fallback = cleaned.toUpperCase();
  let s = cleaned;

  // ---- PHASE 1 — leading noise -------------------------------------------
  s = s.replace(/\s*Card #:\d+\s*$/i, "");

  s = s.replace(/^POS\s+\d{4}\s+\d{4}\s+\d+\s+/i, "");
  s = s.replace(/^ATM\s+\d{4}\s+\d{4}\s+\d+\s+/i, "");
  s = s.replace(/^SBI\s+\d{4}\s+\d{4}\s+\d+\s+/i, "");

  // ---- PHASE 2 — reference tokens ----------------------------------------
  s = s.replace(EMBEDDED_TIMESTAMP, " ");
  s = s.replace(MEMO_TAIL, "");
  s = s.replace(PROCESSOR_DOMAINS, "");
  s = splitOnReferenceToken(s);
  s = s.trim().replace(/\s+/g, " ");

  s = s.trim().replace(/\s+/g, " ").toUpperCase();

  // ---- PHASES 3 + 4 — trailing noise, then location and tail --------------
  //
  // Run to a FIXED POINT rather than once. Every rule below only ever shortens
  // the string, so convergence is guaranteed — but the cap is NOT merely
  // belt-and-braces, and an earlier comment here said it was. A string with
  // more trailing groups than there are passes exits mid-convergence and
  // returns a key that is not a fixed point: `FOO 111 222 333 444 555 666 777
  // 888 999` settles at `FOO 111`, and normalizing THAT yields `FOO`. Nine
  // trailing numeric groups is not real bank data, so the cap stays — but the
  // idempotence guarantee below holds up to it, not unconditionally.
  //
  // Why a loop: each rule fires at most once per sweep, and one rule's output
  // re-creates another's precondition. `SAVEMART #12 MA MANTECA` loses ` MANTECA`
  // to the city strip, which exposes the ` MA` that phase 3 had already run past;
  // `AUTOZONE 3335 147 MANTECA` sheds one trailing number and reveals the next.
  // A single sweep left 9 keys that changed again on a second call, so the
  // normalizer was not idempotent and `normalizeMerchant(existing_key)` could
  // silently move a key out from under its rule.
  //
  // The `*` split deliberately stays OUTSIDE this loop, in phase 2. It must run
  // exactly once: re-running it would split on the second star of a merchant that
  // legitimately contains one (`SQ *FOO*BAR` -> `FOO*BAR`, not `FOO`).
  for (let pass = 0; pass < 8; pass++) {
    const before = s;

    // ---- PHASE 3 — trailing noise ------------------------------------------
    s = s.replace(/\s+Ref#\s*\S+\s*$/i, "");

    s = s.replace(/\s+\d{3}[-.]?\d{3}[-.]?\d{4}\s+[A-Z]{2}\s*$/i, "");

    s = s.replace(/\s+\d{6}\s*$/, "");

    s = s.replace(/\s+#\d+\b/g, "");

    s = s.replace(TRAILING_STATE, "$1");

    s = s.trim().replace(/\s+/g, " ");

    // ---- PHASE 4 — location and tail ---------------------------------------
    s = s.replace(PROCESSOR_DOMAINS, "").trim();
    // The state code is gone by now, so the city is finally the last token.
    s = stripTrailingCity(s);
    s = s.replace(/\s+\d{3,}$/, "").trim();
    s = s.replace(/\.COM$/, "").trim();
    s = s.replace(/[\s.,\-*]+$/, "").trim();

    if (s === before) break;
  }

  // FINAL GUARD. An empty key, or one that is nothing but a processor name, would
  // collect unrelated rows under a meaningless label. Reachable from degenerate
  // input: `SQ *` splits to an empty merchant, falls back to `SQ *`, and the
  // punctuation trim above would otherwise yield a bare `SQ`.
  //
  // The bare-city case is deliberately NOT handled here — stripTrailingCity already
  // refuses to create one, and a merchant whose name genuinely is a city (the six
  // `*MANTECA` ATM rows) should keep it.
  // Folds case at the comparison rather than trusting phase 3's .toUpperCase()
  // to still be there — a reordering would otherwise turn this into a no-op.
  if (!s || PROCESSOR_PREFIXES.has(s.toUpperCase())) return fallback;

  return s;
}

export function extractCardLastFour(raw: string): string | null {
  const match = raw.match(/Card #:(\d+)/i);
  if (!match) return null;
  return match[1].slice(-4);
}
