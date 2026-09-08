import { z } from "zod";
import { AmountParseError, parseAmountToCents } from "@/lib/money";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH } from "./limits";

/**
 * `/transactions`' URL contract, extracted out of `page.tsx` (D11).
 *
 * It lived as two module-private consts inside the page component's file,
 * which made both halves of the carry-forward guarantee untestable: a key
 * must be *serialized* by `filterValuesToSearchParams` AND *accepted* by this
 * schema, and only the first half was reachable from a test. The silent
 * page-2 filter drop this app has now shipped twice (`pageSize`,
 * `includeTransfers`) is exactly a break in that pair, so D5's round-trip
 * test needs to reach in here.
 *
 * `vitest.config.mts` is `environment: "node"`, so this file must stay free
 * of React/Next imports.
 */

/**
 * Re-exported so this module stays the single import site for the URL contract,
 * while the numbers themselves live in a zod-free module the client bundle can
 * reach without dragging the schema in — see `./limits`.
 */
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH };

const amountSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return undefined;
    try {
      return Math.abs(parseAmountToCents(raw));
    } catch (err) {
      if (err instanceof AmountParseError) {
        ctx.addIssue({ code: "custom", message: "invalid amount" });
        return z.NEVER;
      }
      throw err;
    }
  });

export const searchParamsSchema = z.object({
  categoryId: z
    .union([
      z.literal("none"),
      z.coerce.number().int().positive(),
    ])
    .optional(),
  accountId: z.coerce.number().int().positive().optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  amountMin: amountSchema,
  amountMax: amountSchema,
  pending: z.enum(["posted", "pending", "all"]).optional(),
  // Only ever emitted as the literal "true" by filterValuesToSearchParams;
  // `.strict()` below means anything else 404s rather than being ignored.
  includeTransfers: z.literal("true").optional().transform((v) => v === "true"),
  search: z
    .string()
    .max(MAX_SEARCH_LENGTH)
    .optional()
    .transform((v) => {
      const trimmed = v?.trim();
      return trimmed ? trimmed : undefined;
    }),
  /**
   * Exact `normalized_merchant` key (D2) — the `/categorize` drilldown's
   * filter. Deliberately unbounded (D12): the column is unbounded `text`, the
   * value reaches SQL through a parameterized `eq()`, and an oversized URL is
   * already refused at the HTTP layer. A length cap here would invent a 404
   * for a link the app itself emits (longest real key today: 69 chars).
   *
   * NOT trimmed the way `search` is — this is compared byte-for-byte against
   * a stored key, and a key is allowed to carry whatever the normalizer
   * produced. `""` never reaches this schema — `flatten` below DROPS the key
   * rather than passing it on as `undefined`, which is a different fact and a
   * load-bearing one (see its docstring).
   */
  merchant: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
}).strict();


export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * The filter bar is a plain GET form (D4) — every field name is present on
 * every submit, so an untouched input arrives as `key=""` rather than the
 * key being absent. Blank means "no filter" everywhere in this schema, so
 * `""` is normalized to `undefined` here rather than let a coerced field
 * (`z.coerce.number()`, `z.iso.date()`) reject it as invalid input.
 *
 * A blank key is DROPPED, not carried through as `undefined`. `.strict()`
 * raises `unrecognized_keys` on a key it does not know even when that key's
 * value is `undefined`, so retaining it meant one empty foreign param —
 * `?merchant=AMAZON&ref=`, as a mail client, a link shortener or a browser
 * extension will happily produce — hard-404'd a request in which every real
 * filter had parsed fine. Dropping it here keeps `.strict()` aimed at what it
 * is for: a param carrying a real value that this page does not understand.
 */
export function flatten(raw: RawSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value === "" || value === undefined) continue;
    out[k] = value;
  }
  return out;
}

/**
 * The `pending` filter's URL spelling → `loadTransactions`' `is_pending`
 * predicate. `undefined` means "don't filter on it at all", which is what
 * both `"all"` and an absent param mean.
 *
 * Lives here rather than inline in `page.tsx` because it is the last piece of
 * the URL contract that was still stranded in the component file (D11): a
 * three-way mapping written as a nested ternary, where inverting the two
 * branches shows pending rows under "Posted only" — a wrong result, on a
 * filter, with no test able to reach it.
 */
export function resolveIsPending(
  pending: "posted" | "pending" | "all" | undefined,
): boolean | undefined {
  switch (pending) {
    case "posted":
      return false;
    case "pending":
      return true;
    default:
      return undefined;
  }
}
