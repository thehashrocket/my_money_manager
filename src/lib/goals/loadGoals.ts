import { and, eq, isNull, sql } from "drizzle-orm";
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
  /**
   * `categories.target_cents`. NULL means "no target recorded", which is NOT
   * the same fact as `0` — the same distinction `FundRow.targetCents` draws,
   * and for the same reason: rendering "no target" as `$0.00` claims the fund
   * is already complete.
   *
   * This was `number` with a `?? 0` at the mapping site until v0.23.0, when
   * `/budget`'s FUNDS band gained "+ Add a line". `createCategory` does not
   * write `target_cents`, so a fund born there has NULL — previously
   * unreachable, because `createGoalAction` is `.positive()`. The two
   * surfaces then disagreed about one column, and this one was the wrong
   * half: `/budget` rendered an em dash while `/goals` rendered `$0.00`.
   */
  targetCents: number | null;
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
  /** Sum of `targetCents` over funds that HAVE one. A NULL target contributes
   *  nothing rather than a phantom `0` (see `GoalRow.targetCents`). */
  totalTargetCents: number;
  /**
   * `totalContributedCents` summed over the SAME funds `totalTargetCents`
   * covers — the numerator of the headline ratio.
   *
   * It exists because the two halves used to be drawn from different sets:
   * the page summed contributions across every fund while the denominator
   * summed targets, so one untargeted fund made the ratio compare quantities
   * about different things. A ratio whose halves disagree about their
   * denominator's membership is the "plausible but wrong" shape rule 1 is
   * organised against, and it is invisible — both numbers look fine alone.
   */
  totalTargetedContributedCents: number;
  /** Funds with no target recorded. The page names them rather than letting
   *  them silently drop out of the ratio above. */
  untargetedGoalCount: number;
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
    //
    // Archived funds are excluded outright rather than marked, because every
    // affordance this page offers an archived fund is a dead end: D3=C gave
    // each card a "Fund this month →" link into `#funds-band`, but
    // `notHiddenByArchive` (loadMonthView) drops an archived fund from any
    // month where it has neither a nonzero allocation nor spend, so the
    // destination row is usually absent — and if it was the only fund, the
    // whole band is gone, since `<MonthEditor>` gates the section on
    // `fundRows.length > 0`. Even when the row does render, `upsertAllocation`
    // throws `CategoryArchivedError` on commit. Three ways to land nowhere.
    // `/budget/categories` remains the one surface that lists and unarchives
    // it, which is rule 8's stated contract.
    .where(and(eq(schema.categories.kind, "fund"), isNull(schema.categories.archivedAt)))
    .groupBy(schema.categories.id)
    .orderBy(schema.categories.name)
    .all();

  if (goalCategories.length === 0) {
    return {
      goals: [],
      totalProgressCents: 0,
      totalTargetCents: 0,
      totalTargetedContributedCents: 0,
      untargetedGoalCount: 0,
    };
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
    const target = g.targetCents;
    const contributed = g.totalContributed;
    const withdrawn = withdrawalMap.get(g.id) ?? 0;
    const progress = contributed - withdrawn;
    // `null` and `0` both yield 0 here, but for different reasons — no target
    // to measure against, versus a target of nothing. Neither divides.
    const pct =
      target !== null && target > 0
        ? Math.min(100, Math.max(0, (progress / target) * 100))
        : 0;
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
  const targeted = goals.filter((g) => g.targetCents !== null);
  const totalTargetCents = targeted.reduce((s, g) => s + (g.targetCents ?? 0), 0);
  const totalTargetedContributedCents = targeted.reduce(
    (s, g) => s + g.totalContributedCents,
    0,
  );

  return {
    goals,
    totalProgressCents,
    totalTargetCents,
    totalTargetedContributedCents,
    untargetedGoalCount: goals.length - targeted.length,
  };
}
