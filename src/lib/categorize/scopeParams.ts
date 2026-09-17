import { z } from "zod";
import type { YearMonth } from "@/lib/budget/monthOfIso";

/**
 * `/categorize`'s only searchParams: an optional `(year, month)` scope,
 * `?year=2026&month=9` — see `loadMerchantGroups`' `scope` for what it does.
 *
 * Both present or both absent, same discipline as `bulkCategorizeInputSchema`'s
 * `scopeYear`/`scopeMonth`: a lone `year` or `month` is as meaningless as
 * neither, so it parses to "no scope" (all time) rather than a half-applied
 * filter.
 *
 * Unlike `/transactions`' `.strict()` schema (CLAUDE.md rule 10 — a filter
 * key that isn't accepted there 404s the page), an unparseable or unknown
 * value here degrades to "all time" instead of a rejected request. This is
 * the page's first-ever query param: there is no second filter it could
 * silently drop alongside, and failing open reproduces the page's own
 * default (no params at all) exactly rather than a worse state.
 */
/**
 * The one definition of a valid scope year, shared with
 * `bulkCategorizeInputSchema` (the write-side twin of this read-side schema)
 * and `ScopeNav` (which must never generate a prev/next link this parser
 * would then reject and silently fall back to "all time" for — found by
 * Red Team review: an unbounded `nextMonthOf`/`previousMonth` nav arrow can
 * walk past either end, landing on a URL whose year fails this schema and
 * jumps the page to all-time data with no explanation connecting the two).
 */
export const SCOPE_YEAR_MIN = 2000;
export const SCOPE_YEAR_MAX = 2999;

const rawScopeSchema = z.object({
  year: z.coerce.number().int().min(SCOPE_YEAR_MIN).max(SCOPE_YEAR_MAX).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export function parseScopeParams(
  raw: Record<string, string | string[] | undefined>,
): YearMonth | undefined {
  const parsed = rawScopeSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { year, month } = parsed.data;
  if (year === undefined || month === undefined) return undefined;
  return { year, month };
}
