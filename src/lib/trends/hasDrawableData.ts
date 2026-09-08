/**
 * "Is there anything to draw?" — the one definition, in a module with NO
 * dependencies.
 *
 * It belongs to `loadMonthlyTrends.ts` conceptually, and lived there first.
 * But `trend-chart.tsx` is `"use client"` (Recharts requires it) and needs
 * this at render time, and `loadMonthlyTrends.ts` imports `@/db` — so pulling
 * a single function out of it dragged `better-sqlite3` into the client graph
 * and broke `next build` outright with `Module not found: Can't resolve 'fs'`.
 * Same constraint and same remedy as `lib/transactions/limits.ts` and
 * `merchantLabel.ts`; see those for the measured version of this hazard.
 *
 * Takes a structural argument rather than importing `TrendData`, so this file
 * keeps zero imports of any kind — a `import type` would be erased, but the
 * next person to add a non-type one is who this comment is for.
 *
 * WHY IT EXISTS AT ALL: `TrendChart` used to decide emptiness itself, as
 * `months.every((m) => m.totalSpentCents === 0)`. Under the signed spend
 * convention that stopped being the same question — a month whose refunds
 * exactly cancel its spend totals zero and still draws two real bars, so the
 * old test rendered "import some transactions" over real activity.
 *
 * `categoryNames` is exactly the set of groups drawing a bar in at least one
 * month (filtered on `drawnGroups`, accumulated at the per-month zero-drop
 * site), so this is equivalent to `months.every((m) => !m.byCategory.length)`
 * by construction — the read model is what establishes that equivalence, which
 * is why the answer is not re-derived in the component.
 */
export function hasDrawableData(data: { categoryNames: string[] }): boolean {
  return data.categoryNames.length > 0;
}
