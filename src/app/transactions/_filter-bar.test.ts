import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  flatten,
  MAX_SEARCH_LENGTH,
  searchParamsSchema,
} from "@/lib/transactions/searchParams";
import {
  buildHref,
  CLEARED_FILTERS,
  filterValuesToSearchParams,
  hasNonMerchantFilters,
  merchantSearchRecoveryHref,
  VISIBLE_FIELDS,
  type TransactionsFilterValues,
} from "./_filter-bar";

const emptyValues: TransactionsFilterValues = CLEARED_FILTERS;

describe("filterValuesToSearchParams", () => {
  it("carries every active filter forward (Pagination round-trip)", () => {
    const values: TransactionsFilterValues = {
      search: "amazon",
      accountId: 3,
      categoryId: 7,
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
      amountMin: 500,
      amountMax: 10000,
      pending: "posted",
      includeTransfers: undefined,
      merchant: "AMAZON",
      pageSize: undefined,
    };
    const params = filterValuesToSearchParams(values);
    expect(params.get("search")).toBe("amazon");
    expect(params.get("accountId")).toBe("3");
    expect(params.get("categoryId")).toBe("7");
    expect(params.get("dateFrom")).toBe("2026-04-01");
    expect(params.get("dateTo")).toBe("2026-04-30");
    expect(params.get("amountMin")).toBe("5.00");
    expect(params.get("amountMax")).toBe("100.00");
    expect(params.get("pending")).toBe("posted");
    expect(params.get("merchant")).toBe("AMAZON");
  });

  it('omits pending when it is "all" (today\'s default)', () => {
    const params = filterValuesToSearchParams({ ...emptyValues, pending: "all" });
    expect(params.has("pending")).toBe(false);
  });

  it("produces no params when nothing is set", () => {
    expect(filterValuesToSearchParams(emptyValues).toString()).toBe("");
  });

  it("categoryId 'none' round-trips as the literal string", () => {
    const params = filterValuesToSearchParams({ ...emptyValues, categoryId: "none" });
    expect(params.get("categoryId")).toBe("none");
  });
});

describe("buildHref", () => {
  it("returns the bare path when no filters are set", () => {
    expect(buildHref(emptyValues)).toBe("/transactions");
  });

  it("overriding dateFrom/dateTo (the 'This month' link) keeps other active filters", () => {
    const href = buildHref({
      ...emptyValues,
      search: "amazon",
      accountId: 3,
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    const url = new URL(href, "http://localhost");
    expect(url.searchParams.get("search")).toBe("amazon");
    expect(url.searchParams.get("accountId")).toBe("3");
    expect(url.searchParams.get("dateFrom")).toBe("2026-04-01");
    expect(url.searchParams.get("dateTo")).toBe("2026-04-30");
  });

  it("the merchant chip's × drops only the merchant, keeping the date range (D18)", () => {
    const active = buildHref({
      ...emptyValues,
      merchant: "AMAZON",
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    expect(new URL(active, "http://localhost").searchParams.get("merchant")).toBe("AMAZON");

    const cleared = buildHref({
      ...emptyValues,
      merchant: undefined,
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    const url = new URL(cleared, "http://localhost");
    expect(url.searchParams.has("merchant")).toBe(false);
    expect(url.searchParams.get("dateFrom")).toBe("2026-04-01");
    expect(url.searchParams.get("dateTo")).toBe("2026-04-30");
  });
});

/**
 * D5 — the regression guard, driven by the KEYS of `TransactionsFilterValues`
 * rather than a hand-written list of them.
 *
 * A filter reaches the URL through two independent gates and has to clear
 * both: `filterValuesToSearchParams` must SERIALIZE it (or page 2 silently
 * drops it — the list reads as filtered while showing all 1,540 rows), and
 * `searchParamsSchema` must ACCEPT it (or the link 404s, since the schema is
 * `.strict()`). This app has now shipped the silent half twice, on `pageSize`
 * and on `includeTransfers`; the previous version of this test hand-enumerated
 * field names, so it could only ever catch the fields someone remembered.
 *
 * The exhaustiveness is a type check, not a convention: `ALL_FILTERS_ACTIVE`
 * is annotated `TransactionsFilterValues`, whose properties are all required,
 * so adding field #12 to that type fails `tsc` here until the fixture sets it
 * — and the loops below then cover it automatically. The `undefined` assertion
 * closes the other half of that door: satisfying the compiler with
 * `newField: undefined` would otherwise pass a test that exercised nothing.
 */
const ALL_FILTERS_ACTIVE: TransactionsFilterValues = {
  search: "amazon",
  accountId: 3,
  categoryId: 7,
  dateFrom: "2026-04-01",
  dateTo: "2026-04-30",
  amountMin: 500,
  amountMax: 10000,
  // "all" is deliberately omitted by the serializer as the default, so the
  // fixture has to use a value that is actually carried.
  pending: "posted",
  includeTransfers: true,
  merchant: "GASCO#00000ANYTWN",
  // Likewise: the default is omitted, so the fixture needs a non-default.
  pageSize: 200,
};

/**
 * The THIRD edge of the carry-forward contract, and the one that was open.
 *
 * The loops below walk the keys of `TransactionsFilterValues`, which covers
 * "every filter field is serialized" and "every filter field is accepted".
 * Neither says anything about a key that exists in the SCHEMA but was never
 * added to the type — and that is precisely how `pageSize` came to be dropped
 * by six `buildHref` call sites while the guard written to catch this bug
 * reported green. A keys-of-the-type check is structurally blind to a key the
 * type does not have.
 *
 * So: assert the schema has no key that is neither a filter field nor
 * deliberately exempt. `page` is the only exemption, and it is a real one —
 * every `buildHref` caller changes the result set, which has to reset to page
 * 1 rather than carry a page number into a list that may be shorter.
 *
 * This is a compile-time check; it fails `tsc` (which CI runs via
 * `pnpm build`), not the assertion below. The runtime `expect` exists so the
 * check is visible as a named test rather than a silent type annotation.
 */
type SchemaKey = keyof z.output<typeof searchParamsSchema>;
type UncarriedSchemaKey = Exclude<SchemaKey, keyof TransactionsFilterValues | "page">;
const NO_UNCARRIED_SCHEMA_KEYS: UncarriedSchemaKey extends never ? true : never = true;

/**
 * The same edge, closed harder — and in the other direction too.
 *
 * `NO_UNCARRIED_SCHEMA_KEYS` above is one-directional and keys-only. It
 * catches "a schema key that never became a filter field" (the `pageSize`
 * bug), but not either of these:
 *
 * - a FILTER field that is not a schema key — which serializes into a URL the
 *   `.strict()` schema then 404s, the `includeTransfers` failure shape;
 * - a VALUE drift — widening `pending` to a fourth literal in the schema while
 *   the filter type still knows three. Both keys sets still match; the two
 *   types no longer describe the same thing.
 *
 * Mutual assignability catches all three. `-?` plus `| undefined` reproduces
 * the deliberate "required, possibly-undefined" encoding of the hand-written
 * type — the property is required so `tsc` forces every construction site to
 * name it, and its value may still be `undefined` because an absent filter is
 * a real state.
 *
 * The type stays hand-written rather than being replaced by `Derived`: a
 * mapped type carries no per-property JSDoc, and the comments on `merchant`,
 * `pageSize` and `includeTransfers` above are the postmortems of the bugs
 * this contract exists to prevent. Deriving it would delete them from hover.
 * zod is imported here as a TYPE only, and this is a test file besides, so
 * neither costs the client bundle anything.
 */
type Derived = { [K in Exclude<SchemaKey, "page">]-?: z.output<typeof searchParamsSchema>[K] | undefined };
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const FILTER_TYPE_MATCHES_SCHEMA: MutuallyAssignable<TransactionsFilterValues, Derived> = true;

describe("buildHref refuses to emit a merchant filter it cannot honour", () => {
  /**
   * A bare `?merchant=` is worse than no link: `flatten()` DROPS a blank
   * key, so the destination has no merchant filter and shows every row —
   * from a control that promised to narrow to one merchant.
   * `merchantDrilldownHref` returns `null` for this; the per-row link on
   * `/transactions` builds its href through `buildHref` instead, so the guard
   * is made again in the serializer, because the two link builders share no
   * code — `merchantDrilldownHref` builds its own `URLSearchParams`.
   */
  it("skips an empty merchant key rather than emitting `?merchant=`", () => {
    const href = buildHref({ ...emptyValues, merchant: "" });
    expect(href).not.toContain("merchant");
  });

  it("still emits a non-empty key", () => {
    const href = buildHref({ ...emptyValues, merchant: "AMAZON" });
    expect(new URL(href, "http://x").searchParams.get("merchant")).toBe("AMAZON");
  });
});

/**
 * `pageSize` was the field this contract had already shipped broken once, and
 * it broke again the moment it stopped being a member of the filter type:
 * every `buildHref` caller reset it to the default, silently. These pin the
 * behaviour that fix restored.
 */
describe("buildHref carries a deliberate pageSize", () => {
  it("keeps a non-default pageSize when another filter changes", () => {
    const href = buildHref({ ...emptyValues, pageSize: 200, merchant: "AMAZON" });
    const url = new URL(href, "http://x");
    expect(url.searchParams.get("pageSize")).toBe("200");
    expect(url.searchParams.get("merchant")).toBe("AMAZON");
  });

  it("keeps it when the merchant chip's × removes the merchant filter", () => {
    // The regression in miniature: from `?merchant=AMAZON&pageSize=200`,
    // clicking × used to land on 50 rows/page with nothing saying so.
    const href = buildHref({ ...emptyValues, pageSize: 200, merchant: undefined });
    expect(new URL(href, "http://x").searchParams.get("pageSize")).toBe("200");
  });

  it("omits the default rather than spelling it out on every link", () => {
    const href = buildHref({ ...emptyValues, pageSize: DEFAULT_PAGE_SIZE });
    expect(href).toBe("/transactions");
  });

  it("omits it when unset", () => {
    expect(buildHref(emptyValues)).toBe("/transactions");
  });
});

describe("hasNonMerchantFilters", () => {
  // The zero-result state uses this to decide whether it may blame the
  // merchant key. Getting it wrong means confidently misdiagnosing a stale
  // link, and pointing the user at a recovery that cannot work.
  it("is false when only the merchant filter is active", () => {
    expect(hasNonMerchantFilters({ ...emptyValues, merchant: "AMAZON" })).toBe(false);
  });

  it("is false when only a page size is set (a display preference, not a predicate)", () => {
    expect(
      hasNonMerchantFilters({ ...emptyValues, merchant: "AMAZON", pageSize: 200 }),
    ).toBe(false);
  });

  it("is true when a date range is also narrowing the list", () => {
    expect(
      hasNonMerchantFilters({ ...emptyValues, merchant: "AMAZON", dateFrom: "2026-04-01" }),
    ).toBe(true);
  });

  it("is false for pending: 'all', which filters nothing", () => {
    expect(hasNonMerchantFilters({ ...emptyValues, pending: "all" })).toBe(false);
  });

  it("is false for includeTransfers: false, which parses from an absent param", () => {
    // `includeTransfers` is `boolean`, never `undefined`, so a key-presence
    // walk over the filter type would have counted it as active on every
    // single request.
    expect(hasNonMerchantFilters({ ...emptyValues, includeTransfers: false })).toBe(false);
  });

  it("is false when transfers are deliberately shown — that widens, it cannot empty", () => {
    // The one caller asks "could something OTHER than the merchant key be why
    // this list is empty?", to decide whether to blame a stale key (rule 10's
    // recovery) or the rest of the filters. "Show transfers" only ever ADDS
    // rows, so answering true there suppressed the stale-key diagnosis on a
    // page that had just got emptier for no new reason.
    expect(hasNonMerchantFilters({ ...emptyValues, includeTransfers: true })).toBe(false);
  });

  it("still sees a real narrowing filter alongside a widened transfer view", () => {
    expect(
      hasNonMerchantFilters({ ...emptyValues, includeTransfers: true, dateFrom: "2026-04-01" }),
    ).toBe(true);
  });
});

describe("every TransactionsFilterValues key survives the URL round trip", () => {
  const keys = Object.keys(ALL_FILTERS_ACTIVE) as (keyof TransactionsFilterValues)[];

  it("no schema key is left outside the carry-forward contract", () => {
    // See NO_UNCARRIED_SCHEMA_KEYS above — the real enforcement is the type.
    expect(NO_UNCARRIED_SCHEMA_KEYS).toBe(true);
  });

  it("the filter type and the schema describe the same fields, both ways", () => {
    // FILTER_TYPE_MATCHES_SCHEMA — again, the enforcement is `tsc`; this makes
    // it a visible named test rather than a silent annotation.
    expect(FILTER_TYPE_MATCHES_SCHEMA).toBe(true);
  });

  it("the fixture actually populates every field (guards the guard)", () => {
    const unset = keys.filter((k) => ALL_FILTERS_ACTIVE[k] === undefined);
    expect(unset).toEqual([]);
  });

  // Computed per call, not once at describe-collection time: a throw out
  // here surfaces as a vitest collection error naming the whole file rather
  // than as a named failing test.
  const roundTrip = () => {
    const params = filterValuesToSearchParams(ALL_FILTERS_ACTIVE);
    return {
      params,
      parsed: searchParamsSchema.safeParse(flatten(Object.fromEntries(params.entries()))),
    };
  };

  it("the serialized query string is accepted by the page's strict schema", () => {
    expect(roundTrip().parsed.success).toBe(true);
  });

  for (const key of keys) {
    it(`${key} is serialized into the query string`, () => {
      expect(roundTrip().params.has(key)).toBe(true);
    });

    /**
     * Value equality, not mere presence. `includeTransfers` parses to `false`
     * when the key is absent entirely (`z.literal("true").optional().transform`),
     * so `.not.toBe(undefined)` passed for a field that was never serialized —
     * the exact silent-drop class this guard exists to catch, on the exact
     * field it has already shipped broken once.
     */
    it(`${key} survives the round trip with its value intact`, () => {
      const { parsed } = roundTrip();
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data[key]).toEqual(ALL_FILTERS_ACTIVE[key]);
    });

  }
});

/**
 * The FOURTH gate, which the loops above cannot see.
 *
 * "Apply filters" is a GET form, so a field reaches the next request through
 * a `name=`d control — a mechanism entirely separate from the serializer. A
 * field can be in the type, serialized, and accepted by the schema, and still
 * be dropped on submit because nobody wrote it an input. `FilterBar` now
 * derives its hidden inputs as "everything the serializer emits that is not
 * in `VISIBLE_FIELDS`", which makes a new field carried by default.
 *
 * That leaves one way to get it wrong, and it is silent: a name in
 * `VISIBLE_FIELDS` that no control actually uses (a typo, or a renamed field)
 * suppresses the hidden input for a field that has no visible control either
 * — dropping it. A name that IS visible but missing from the set is worse in
 * the other direction: the field gets a visible control AND a stale hidden
 * input, the form submits both, and `flatten` keeps the first — so the old
 * value silently wins over what the user just typed.
 */
describe("the form's visible/hidden field partition", () => {
  it("names only fields the serializer can actually emit", () => {
    const serializable = new Set(filterValuesToSearchParams(ALL_FILTERS_ACTIVE).keys());
    const unknown = [...VISIBLE_FIELDS].filter((name) => !serializable.has(name));
    expect(unknown).toEqual([]);
  });

  it("leaves exactly the three control-less fields to be carried as hidden inputs", () => {
    // `pageSize` (URL-only), `includeTransfers` (its switch sits beside the
    // result summary) and `merchant` (its control is the header chip). If
    // this list changes, a field either gained a control or lost one.
    const hidden = [...filterValuesToSearchParams(ALL_FILTERS_ACTIVE).keys()].filter(
      (name) => !VISIBLE_FIELDS.has(name),
    );
    expect(hidden.sort()).toEqual(["includeTransfers", "merchant", "pageSize"]);
  });
});

/**
 * The zero-result state's `?search=` recovery, as a composition rather than as
 * two independent facts.
 *
 * CLAUDE.md rule 10 names this link as THE mitigation for the one-way
 * `?merchant=` coupling a `db:backfill-merchants` run creates: the exact key
 * stops matching, and `search` (`LIKE %x%`, case-insensitive) is what finds
 * the rows again. `searchParams.test.ts` already pins that a truncated key
 * PARSES. What nothing pinned is the shape `EmptyState` actually builds —
 * `{ ...CLEARED_FILTERS, pageSize, search }` — and that shape is where both
 * of this fix pass's bugs lived:
 *
 * - keeping the other filters meant the offered fix landed on a SECOND empty
 *   page whenever a date range was what emptied the first, and
 * - not truncating meant an over-long key 404'd the one escape hatch on
 *   offer, because `merchant` is deliberately unbounded (D12) while `search`
 *   is capped.
 *
 * Spelled against `CLEARED_FILTERS` rather than a literal so field #12 is
 * covered the day it is added: a new filter with a truthy default would
 * otherwise ride along on the recovery link silently.
 */
describe("the zero-result state's ?search= recovery link", () => {
  // `merchantSearchRecoveryHref` itself, not a local copy of the expression.
  // While `EmptyState` spelled this inline, these four tests asserted against
  // their own reimplementation of it — so both bugs the docstring above
  // describes could have been reintroduced in `_transactions-ui.tsx` with all
  // four still green.
  const recoveryHref = merchantSearchRecoveryHref;

  it("drops every other active filter, not just the merchant one", () => {
    const url = new URL(recoveryHref("AMAZON", undefined), "http://x");
    expect([...url.searchParams.keys()]).toEqual(["search"]);
    expect(url.searchParams.get("search")).toBe("AMAZON");
  });

  it("keeps a deliberate page size — a display preference, not a predicate", () => {
    const url = new URL(recoveryHref("AMAZON", 200), "http://x");
    expect([...url.searchParams.keys()].sort()).toEqual(["pageSize", "search"]);
    expect(url.searchParams.get("pageSize")).toBe("200");
  });

  it("truncates an over-long key to the cap, so the link cannot 404", () => {
    const overLong = "A".repeat(MAX_SEARCH_LENGTH * 2);
    const url = new URL(recoveryHref(overLong, undefined), "http://x");
    expect(url.searchParams.get("search")).toHaveLength(MAX_SEARCH_LENGTH);

    const parsed = searchParamsSchema.safeParse(
      flatten(Object.fromEntries(url.searchParams.entries())),
    );
    expect(parsed.success).toBe(true);
  });

  it("survives a URL-hostile key, which is what makes it worth building at all", () => {
    // 17 of 363 real keys carry `# * ? / ;`, and a bare `#` truncates a
    // hand-built query string rather than erroring.
    const key = "GASCO#00000ANYTWN";
    const url = new URL(recoveryHref(key, undefined), "http://x");
    expect(url.searchParams.get("search")).toBe(key);
  });
});
