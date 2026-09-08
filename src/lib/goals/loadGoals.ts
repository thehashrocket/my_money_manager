import { eq, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type MonthlyContribution = {
  year: number;
  month: number;
  allocatedCents: number;
};

export type GoalRow = {
  categoryId: number;
  name: string;
  targetCents: number;
  carryoverPolicy: "none" | "rollover" | "reset";
  totalContributedCents: number;
  totalWithdrawnCents: number;
  /** `totalContributedCents - totalWithdrawnCents` — a sum of PLANNED
   * `budget_periods.allocated_cents` rows minus real withdrawal
   * transactions, never a bank balance or a transfer total (B2). An
   * allocation is an intention: the money may never have actually left the
   * source account into savings. DS11 keeps this field (PR3 fixes the
   * underlying math), but `/goals` no longer renders it as a progress bar
   * or a percent — see `DESIGN.md`'s `/goals` section for why. */
  progressCents: number;
  progressPct: number;
  monthlyBreakdown: MonthlyContribution[];
};

export type GoalsView = {
  goals: GoalRow[];
  totalProgressCents: number;
  totalTargetCents: number;
};

/**
 * B2/DS11: `progressCents`/`progressPct` are computed from PLANNED
 * `budget_periods` allocations, not confirmed transfers into savings — see
 * `GoalRow.progressCents`'s own docstring. This function's math is
 * unchanged by DS11; only `/goals`' rendering of it changed (the progress
 * bar and percent-complete UI are gone, per `DESIGN.md`).
 */
export function loadGoals(db: Db): GoalsView {
  const goalCategories = db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      targetCents: schema.categories.targetCents,
      carryoverPolicy: schema.categories.carryoverPolicy,
      totalContributed: sql<number>`COALESCE(SUM(${schema.budgetPeriods.allocatedCents}), 0)`,
    })
    .from(schema.categories)
    .leftJoin(
      schema.budgetPeriods,
      eq(schema.budgetPeriods.categoryId, schema.categories.id),
    )
    // A2: kind is authoritative, not is_savings_goal (T5).
    .where(eq(schema.categories.kind, "fund"))
    .groupBy(schema.categories.id)
    .orderBy(schema.categories.name)
    .all();

  if (goalCategories.length === 0) {
    return { goals: [], totalProgressCents: 0, totalTargetCents: 0 };
  }

  const goalIds = goalCategories.map((g) => g.id);

  // DELIBERATELY still `amount_cents < 0`, and NOT the signed sum the sign
  // convention (2026-09-08) gave `computeMtdSpent` and `loadMonthlyTrends`.
  // Converting this one was tried during that change and reverted, because it
  // is not the same kind of quantity and the conversion silently changes the
  // arithmetic above it:
  //
  //   progressCents = contributed − withdrawn
  //
  // `contributed` is PLANNED allocations (`budget_periods.allocated_cents`).
  // Make `withdrawn` a net figure and a deposit into a fund category turns it
  // negative, so the deposit is ADDED to progress — on top of the allocation
  // that already counted the same intention. A fund allocated $500 that then
  // receives the $500 would read ~$1,000 saved.
  //
  // Whether that is reachable depends on how money enters a fund, which is
  // itself the unresolved half of TODOS.md's PR3 item ("progress is money
  // planned, not money moved"). In today's model it arrives as a transfer, and
  // transfers are paired out by the `transfer_pair_id IS NULL` filter, so the
  // sum would be negatives-only anyway and the change would be a no-op — but
  // that is an assumption about a code path with ZERO live exercise (there are
  // no `kind='fund'` categories and no `target_cents` on the ledger), and a
  // dead path is the worst place to introduce arithmetic nobody can observe.
  //
  // Settle the meaning of progress first; the sign convention here follows
  // from that answer rather than the other way round.
  const withdrawalRows = db
    .select({
      categoryId: schema.transactions.categoryId,
      totalWithdrawnSigned: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      sql`${schema.transactions.categoryId} IN (${sql.join(goalIds.map((id) => sql`${id}`), sql`, `)})
        AND ${schema.transactions.amountCents} < 0
        AND ${schema.transactions.transferPairId} IS NULL`,
    )
    .groupBy(schema.transactions.categoryId)
    .all();

  const withdrawalMap = new Map<number, number>();
  for (const row of withdrawalRows) {
    if (row.categoryId !== null) {
      withdrawalMap.set(row.categoryId, 0 - row.totalWithdrawnSigned);
    }
  }

  const breakdownRows = db
    .select({
      categoryId: schema.budgetPeriods.categoryId,
      year: schema.budgetPeriods.year,
      month: schema.budgetPeriods.month,
      allocatedCents: schema.budgetPeriods.allocatedCents,
    })
    .from(schema.budgetPeriods)
    .where(
      sql`${schema.budgetPeriods.categoryId} IN (${sql.join(goalIds.map((id) => sql`${id}`), sql`, `)})`,
    )
    .orderBy(schema.budgetPeriods.categoryId, schema.budgetPeriods.year, schema.budgetPeriods.month)
    .all();

  const breakdownMap = new Map<number, MonthlyContribution[]>();
  for (const row of breakdownRows) {
    const list = breakdownMap.get(row.categoryId) ?? [];
    list.push({ year: row.year, month: row.month, allocatedCents: row.allocatedCents });
    breakdownMap.set(row.categoryId, list);
  }

  const goals: GoalRow[] = goalCategories.map((g) => {
    const target = g.targetCents ?? 0;
    const contributed = g.totalContributed;
    const withdrawn = withdrawalMap.get(g.id) ?? 0;
    const progress = contributed - withdrawn;
    const pct = target > 0 ? Math.min(100, Math.max(0, (progress / target) * 100)) : 0;
    return {
      categoryId: g.id,
      name: g.name,
      targetCents: target,
      carryoverPolicy: g.carryoverPolicy,
      totalContributedCents: contributed,
      totalWithdrawnCents: withdrawn,
      progressCents: progress,
      progressPct: pct,
      monthlyBreakdown: breakdownMap.get(g.id) ?? [],
    };
  });

  const totalProgressCents = goals.reduce((s, g) => s + g.progressCents, 0);
  const totalTargetCents = goals.reduce((s, g) => s + g.targetCents, 0);

  return { goals, totalProgressCents, totalTargetCents };
}
