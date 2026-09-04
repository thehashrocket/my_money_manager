import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { computeEffectiveAllocationsForRollover, periodKey, type RolloverPeriod } from "@/lib/budget";
import { monthBoundary, nextMonthOf } from "@/lib/budget/monthOfIso";
import { loadUncategorizedBacklog, type UncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";

// Re-exported so existing importers (app/page.tsx, BacklogBanner, the
// categorize/transactions client islands) don't need touching just because
// this type's home moved (E5) — they still import it from here.
export type { UncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";

type Db = typeof defaultDb;

export type LeafAllocation = {
  allocatedCents: number;
  rolloverCents: number;
  effectiveCents: number;
};

export type LeafRow = {
  categoryId: number;
  name: string;
  parentId: number | null;
  carryoverPolicy: "none" | "rollover" | "reset";
  /** `null` when no `budget_periods` row exists for this leaf + month. */
  allocation: LeafAllocation | null;
  /** MTD spent in positive cents (includes pending, excludes transfer pairs). */
  spentCents: number;
  /** Subset of `spentCents` that comes from pending transactions. */
  pendingCents: number;
  /** `effectiveCents - spentCents`, or `-spentCents` when no allocation. */
  remainingCents: number;
  isOverspent: boolean;
};

/** A `kind='income'` leaf's row on the INCOME band (A1). */
export type IncomeLeafRow = {
  categoryId: number;
  name: string;
  parentId: number | null;
  /** `budget_periods.allocated_cents`, 0 when no row for this month. */
  plannedCents: number;
  /** `computeMtdReceived` — pending EXCLUDED (TS2). */
  receivedCents: number;
  /** `received - planned`; negative means short. */
  varianceCents: number;
  /** Pending-only subset of this month's rows (DS33's `+p` badge / coverage check). */
  pendingCents: number;
  /** Whether a `budget_periods` row exists for this leaf this month (DS14). */
  hasAllocation: boolean;
};

/** A `kind='fund'` category's row on the FUNDS band (A6), read-only. */
export type FundRow = {
  categoryId: number;
  name: string;
  /** `budget_periods.allocated_cents`, never `effective_allocation_cents` (D3A). */
  plannedCents: number;
};

/**
 * The `Uncategorized` category's own row (X5). Not a leaf in `sections` — the
 * renderer never has to special-case a row out of a list it is mapping over.
 * `null` when DS26's condition to show it doesn't hold: no month spend and no
 * month-scoped backlog to explain.
 */
export type UncategorizedRow = {
  categoryId: number;
  name: string;
  spentCents: number;
};

/**
 * D6A: bucketing (parent grouping, unparented rows first, named parents by
 * the parent's `sort_order` then name) is identical for expense and income
 * rows and gets one implementation via this generic. Within-bucket sorting
 * is NOT identical — expense rows by `sort_order` (DS29), income rows by
 * planned amount DESC — so it stays a parameter (`compare`) rather than a
 * `kind` flag hidden inside the function.
 */
export type SectionGroup<T = LeafRow> = {
  /** `null` for the unparented bucket. A1: this never renders an "Ungrouped" header. */
  parentId: number | null;
  parentName: string | null;
  categories: T[];
};

export type MonthViewSummary = {
  /** Expense-kind only, excludes `Uncategorized` (X5). */
  allocatedCents: number;
  effectiveCents: number;
  spentCents: number;
  remainingCents: number;
  plannedIncomeCents: number;
  receivedIncomeCents: number;
  plannedFundCents: number;
  /** `plannedIncome - allocated - plannedFund` (D3A). Uses `allocated_cents`,
   * never `effective_allocation_cents` — rollover money was already budgeted
   * in a prior month, counting it again would manufacture capacity. */
  leftToBudgetCents: number;
  /** A6: the FUNDS band renders only when this is > 0. */
  fundCount: number;
};

export type MonthView = {
  year: number;
  month: number;
  sections: SectionGroup<LeafRow>[];
  incomeSections: SectionGroup<IncomeLeafRow>[];
  fundRows: FundRow[];
  uncategorizedRow: UncategorizedRow | null;
  summary: MonthViewSummary;
  uncategorizedBacklog: UncategorizedBacklog;
};

/**
 * Assemble the read model for `/budget/[year]/[month]`.
 *
 * Structure (A1, E9): two independent axes, easy to conflate because both
 * ultimately come from the same `categories` table.
 *
 *   BAND       ← categories.kind ('income' | 'expense' | 'fund')
 *     │          Decides which top-level field a category's row lands on:
 *     │          incomeSections | sections | fundRows. Never rendered as
 *     │          a group header — it is the SHAPE of MonthView itself.
 *     │
 *     └── GROUP ← categories.parent_id, WITHIN one band only
 *           │      A `SectionGroup.parentName`. Two categories in
 *           │      different bands are never compared for grouping even
 *           │      if one happens to reference the other's id (doesn't
 *           │      happen today, but nothing stops it schema-wise).
 *           │
 *           └── LEAF ← any category that is not itself a parent_id target
 *                        The row a user actually allocates against
 *                        (LeafRow | IncomeLeafRow | FundRow). A GROUP
 *                        never carries an allocation.
 *
 * `Uncategorized` fits neither GROUP nor LEAF cleanly — it is `kind`
 * `'expense'` but excluded from `sections` and returned as its own field
 * instead (X5); DS26 makes it conditional (see `UncategorizedRow`'s
 * docstring). An unparented category within a band renders directly under
 * that band; there is no synthetic "Ungrouped" GROUP header.
 *
 * Every read here is read-only (TS1 deleted `getEffectiveAllocation`'s
 * `persist` option), so this function is safe to call from a Server
 * Component render path: no writes during prefetch, no double-fire hazard
 * (review decision 7 / T2A).
 *
 * Sorting: within an expense section, leaves sort by `sort_order ASC, name
 * ASC` (DS29 — replaces B4's `spentCents DESC`, which reshuffled rows as you
 * spend). Expense sections themselves sort by the parent's `sort_order ASC,
 * name ASC` (DS12/DS29). Income rows sort by planned amount DESC. The
 * unparented bucket, if non-empty, always renders first within its band.
 */
export function loadMonthView(db: Db, year: number, month: number): MonthView {
  const categories = db.select().from(schema.categories).all();

  const parentIds = new Set<number>();
  for (const c of categories) {
    if (c.parentId !== null) parentIds.add(c.parentId);
  }

  const parentInfoById = new Map<number, { name: string; sortOrder: number }>();
  const sortOrderByCategoryId = new Map<number, number>();
  for (const c of categories) {
    sortOrderByCategoryId.set(c.id, c.sortOrder);
    if (parentIds.has(c.id)) {
      parentInfoById.set(c.id, { name: c.name, sortOrder: c.sortOrder });
    }
  }

  const uncategorizedCategory = categories.find((c) => c.name === "Uncategorized");
  const uncategorizedId = uncategorizedCategory?.id;
  const expenseLeavesAll = categories.filter(
    (c) => c.kind === "expense" && !parentIds.has(c.id) && c.id !== uncategorizedId,
  );
  const incomeLeavesAll = categories.filter(
    (c) => c.kind === "income" && !parentIds.has(c.id) && c.id !== uncategorizedId,
  );
  const fundLeavesAll = categories.filter(
    (c) => c.kind === "fund" && !parentIds.has(c.id) && c.id !== uncategorizedId,
  );

  // T8/T11: bounded set of queries for the whole month, not 2 per leaf plus
  // unbounded backward recursion. #1 categories (above), #2 this month's
  // budget_periods (all kinds — expense/income/fund/Uncategorized all read
  // allocated_cents from the same rows), #3 this month's transaction sums
  // (E13: total + pending in one pass), #4/#5 the rollover range — only
  // when a rollover expense category exists.
  const { allocatedByCategoryId, hasPeriodRow } = loadAllocationsForMonth(db, year, month);
  const { totalByCategoryId, pendingTotalByCategoryId } = loadSpendForMonth(db, year, month);

  // X3/§7.2: an archived category is hidden from a month where it has
  // neither an allocation nor any spend — but stays visible in a historical
  // month that has one or the other, so archiving never erases a past
  // month's numbers. `allocatedByCategoryId`/`totalByCategoryId` are this
  // exact month's activity, already computed above for every category
  // regardless of archive status, so this is a filter over existing maps,
  // not a new query.
  //
  // "Has an allocation" means NONZERO here — the same bar `archiveCategory`
  // (F4) uses to decide whether archiving is even allowed. A `budget_periods`
  // row can exist with `allocated_cents = 0` (an explicit "$0 planned," not
  // "nothing planned" — DS14's placeholder-vs-zero distinction), and that is
  // routinely how a category BECOMES archivable in the first place (F4 says
  // "zero out that allocation first"). Using `hasPeriodRow` (any row, even a
  // $0 one) here would mean the row you just zeroed out specifically so you
  // could archive it stays visible anyway, immediately after archiving —
  // contradicting "archived categories are hidden."
  const hadActivityThisMonth = (categoryId: number) =>
    (allocatedByCategoryId.get(categoryId) ?? 0) !== 0 || totalByCategoryId.has(categoryId);
  const notHiddenByArchive = <T extends { id: number; archivedAt: Date | null }>(c: T) =>
    c.archivedAt === null || hadActivityThisMonth(c.id);
  const expenseLeaves = expenseLeavesAll.filter(notHiddenByArchive);
  const incomeLeaves = incomeLeavesAll.filter(notHiddenByArchive);
  const fundLeaves = fundLeavesAll.filter(notHiddenByArchive);

  const rolloverCategoryIds = expenseLeaves
    .filter((c) => c.carryoverPolicy === "rollover")
    .map((c) => c.id);
  const effectiveByCategoryId =
    rolloverCategoryIds.length > 0
      ? loadRolloverEffectiveByCategory(db, rolloverCategoryIds, year, month)
      : new Map<number, Map<string, number>>();

  const targetKey = periodKey(year, month);

  const leafRows: LeafRow[] = expenseLeaves.map((leaf) => {
    const allocatedCents = allocatedByCategoryId.get(leaf.id) ?? 0;
    let allocation: LeafAllocation | null = null;
    if (hasPeriodRow.has(leaf.id)) {
      const effectiveCents =
        leaf.carryoverPolicy === "rollover"
          ? (effectiveByCategoryId.get(leaf.id)?.get(targetKey) ?? allocatedCents)
          : allocatedCents;
      allocation = { allocatedCents, rolloverCents: effectiveCents - allocatedCents, effectiveCents };
    }

    const spentCents = 0 - (totalByCategoryId.get(leaf.id) ?? 0);
    const pendingCents = 0 - (pendingTotalByCategoryId.get(leaf.id) ?? 0);
    const effective = allocation?.effectiveCents ?? 0;
    const remainingCents = effective - spentCents;
    return {
      categoryId: leaf.id,
      name: leaf.name,
      parentId: leaf.parentId,
      carryoverPolicy: leaf.carryoverPolicy,
      allocation,
      spentCents,
      pendingCents,
      remainingCents,
      isOverspent: remainingCents < 0,
    };
  });

  const incomeRows: IncomeLeafRow[] = incomeLeaves.map((leaf) => {
    const plannedCents = allocatedByCategoryId.get(leaf.id) ?? 0;
    const pendingCents = pendingTotalByCategoryId.get(leaf.id) ?? 0;
    // TS2: pending EXCLUDED, sum NOT negated (computeMtdReceived's convention).
    const receivedCents = (totalByCategoryId.get(leaf.id) ?? 0) - pendingCents;
    return {
      categoryId: leaf.id,
      name: leaf.name,
      parentId: leaf.parentId,
      plannedCents,
      receivedCents,
      varianceCents: receivedCents - plannedCents,
      pendingCents,
      hasAllocation: hasPeriodRow.has(leaf.id),
    };
  });

  const fundRows: FundRow[] = fundLeaves
    .map((leaf) => ({
      categoryId: leaf.id,
      name: leaf.name,
      plannedCents: allocatedByCategoryId.get(leaf.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const uncategorizedBacklog = loadUncategorizedBacklog(db, { year, month });
  let uncategorizedRow: UncategorizedRow | null = null;
  if (uncategorizedCategory) {
    const spentCents = 0 - (totalByCategoryId.get(uncategorizedCategory.id) ?? 0);
    if (spentCents !== 0 || uncategorizedBacklog.count > 0) {
      uncategorizedRow = {
        categoryId: uncategorizedCategory.id,
        name: uncategorizedCategory.name,
        spentCents,
      };
    }
  }

  const expenseCompare = (a: LeafRow, b: LeafRow) => {
    const diff =
      (sortOrderByCategoryId.get(a.categoryId) ?? 0) - (sortOrderByCategoryId.get(b.categoryId) ?? 0);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  };
  const incomeCompare = (a: IncomeLeafRow, b: IncomeLeafRow) => {
    const diff = b.plannedCents - a.plannedCents;
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  };

  const sections = groupIntoSections(leafRows, parentInfoById, expenseCompare);
  const incomeSections = groupIntoSections(incomeRows, parentInfoById, incomeCompare);
  const summary = summarize(leafRows, incomeRows, fundRows);

  return {
    year,
    month,
    sections,
    incomeSections,
    fundRows,
    uncategorizedRow,
    summary,
    uncategorizedBacklog,
  };
}

/** Query #2: every category's `budget_periods` row for exactly this month. */
function loadAllocationsForMonth(
  db: Db,
  year: number,
  month: number,
): { allocatedByCategoryId: Map<number, number>; hasPeriodRow: Set<number> } {
  const rows = db
    .select({
      categoryId: schema.budgetPeriods.categoryId,
      allocatedCents: schema.budgetPeriods.allocatedCents,
    })
    .from(schema.budgetPeriods)
    .where(and(eq(schema.budgetPeriods.year, year), eq(schema.budgetPeriods.month, month)))
    .all();

  const allocatedByCategoryId = new Map<number, number>();
  const hasPeriodRow = new Set<number>();
  for (const row of rows) {
    allocatedByCategoryId.set(row.categoryId, row.allocatedCents);
    hasPeriodRow.add(row.categoryId);
  }
  return { allocatedByCategoryId, hasPeriodRow };
}

/**
 * Query #3 (E13): every category's transaction sum for exactly this month,
 * in one pass — `total` (pending included, the spend/received convention)
 * and `pendingTotal` (the subset from pending rows). Folds in what used to
 * be a separate `loadPendingByCategory` query: `received` (TS2) is then
 * `total - pendingTotal` over the SAME snapshot, not a second read.
 */
function loadSpendForMonth(
  db: Db,
  year: number,
  month: number,
): { totalByCategoryId: Map<number, number>; pendingTotalByCategoryId: Map<number, number> } {
  const firstDay = monthBoundary(year, month);
  const { year: nextYear, month: nextMonth } = nextMonthOf(year, month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);

  const rows = db
    .select({
      categoryId: schema.transactions.categoryId,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
      pendingTotal: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.isPending} THEN ${schema.transactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.transferPairId),
        gte(schema.transactions.date, firstDay),
        sql`${schema.transactions.date} < ${firstDayNext}`,
      ),
    )
    .groupBy(schema.transactions.categoryId)
    .all();

  const totalByCategoryId = new Map<number, number>();
  const pendingTotalByCategoryId = new Map<number, number>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    totalByCategoryId.set(row.categoryId, row.total);
    pendingTotalByCategoryId.set(row.categoryId, row.pendingTotal);
  }
  return { totalByCategoryId, pendingTotalByCategoryId };
}

/**
 * Queries #4 + #5 (P1 + E4): the clamped prefix scan, set-based across every
 * rollover expense category at once instead of one backward recursion per
 * leaf. #4 is each category's ENTIRE `budget_periods` history through this
 * month (sparse — only months with a real row); #5 is their spend, GROUP BY
 * (category, year, month) via `strftime`, over the same span. Both queries
 * run once regardless of how many rollover categories exist.
 */
function loadRolloverEffectiveByCategory(
  db: Db,
  categoryIds: number[],
  year: number,
  month: number,
): Map<number, Map<string, number>> {
  const { year: nextYear, month: nextMonth } = nextMonthOf(year, month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);

  const periodRows = db
    .select({
      categoryId: schema.budgetPeriods.categoryId,
      year: schema.budgetPeriods.year,
      month: schema.budgetPeriods.month,
      allocatedCents: schema.budgetPeriods.allocatedCents,
    })
    .from(schema.budgetPeriods)
    .where(
      and(
        inArray(schema.budgetPeriods.categoryId, categoryIds),
        sql`(${schema.budgetPeriods.year} < ${year} OR (${schema.budgetPeriods.year} = ${year} AND ${schema.budgetPeriods.month} <= ${month}))`,
      ),
    )
    .all();

  const spendRows = db
    .select({
      categoryId: schema.transactions.categoryId,
      yr: sql<string>`strftime('%Y', ${schema.transactions.date})`,
      mo: sql<string>`strftime('%m', ${schema.transactions.date})`,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.categoryId, categoryIds),
        isNull(schema.transactions.transferPairId),
        sql`${schema.transactions.date} < ${firstDayNext}`,
      ),
    )
    .groupBy(
      schema.transactions.categoryId,
      sql`strftime('%Y', ${schema.transactions.date})`,
      sql`strftime('%m', ${schema.transactions.date})`,
    )
    .all();

  const periodsByCategory = new Map<number, RolloverPeriod[]>();
  for (const row of periodRows) {
    const list = periodsByCategory.get(row.categoryId) ?? [];
    list.push({ year: row.year, month: row.month, allocatedCents: row.allocatedCents });
    periodsByCategory.set(row.categoryId, list);
  }

  const spentByCategory = new Map<number, Map<string, number>>();
  for (const row of spendRows) {
    if (row.categoryId === null) continue;
    const map = spentByCategory.get(row.categoryId) ?? new Map<string, number>();
    map.set(periodKey(Number(row.yr), Number(row.mo)), 0 - row.total);
    spentByCategory.set(row.categoryId, map);
  }

  const effectiveByCategoryId = new Map<number, Map<string, number>>();
  for (const categoryId of categoryIds) {
    const periods = periodsByCategory.get(categoryId) ?? [];
    const spent = spentByCategory.get(categoryId) ?? new Map<string, number>();
    effectiveByCategoryId.set(categoryId, computeEffectiveAllocationsForRollover(periods, spent));
  }
  return effectiveByCategoryId;
}

export function groupIntoSections<T extends { parentId: number | null; name: string }>(
  rows: T[],
  parentInfoById: Map<number, { name: string; sortOrder: number }>,
  compare: (a: T, b: T) => number,
): SectionGroup<T>[] {
  const buckets = new Map<number | "ungrouped", T[]>();
  for (const row of rows) {
    const key = row.parentId ?? "ungrouped";
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }

  const sections: SectionGroup<T>[] = [];
  const ungrouped = buckets.get("ungrouped");
  if (ungrouped?.length) {
    sections.push({
      parentId: null,
      parentName: null,
      categories: [...ungrouped].sort(compare),
    });
  }

  // DS29/DS12: groups order by the parent's sort_order ASC, name ASC — not
  // alphabetically by name alone.
  const namedParents = [...buckets.entries()]
    .filter((entry): entry is [number, T[]] => entry[0] !== "ungrouped")
    .map(([parentId, rowsForParent]) => {
      const info = parentInfoById.get(parentId);
      return {
        parentId,
        parentName: info?.name ?? "",
        sortOrder: info?.sortOrder ?? 0,
        categories: [...rowsForParent].sort(compare),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.parentName.localeCompare(b.parentName));

  for (const group of namedParents) {
    sections.push({
      parentId: group.parentId,
      parentName: group.parentName,
      categories: group.categories,
    });
  }

  return sections;
}

function summarize(
  leaves: LeafRow[],
  incomeRows: IncomeLeafRow[],
  fundRows: FundRow[],
): MonthViewSummary {
  let allocatedCents = 0;
  let effectiveCents = 0;
  let spentCents = 0;
  for (const leaf of leaves) {
    allocatedCents += leaf.allocation?.allocatedCents ?? 0;
    effectiveCents += leaf.allocation?.effectiveCents ?? 0;
    spentCents += leaf.spentCents;
  }

  let plannedIncomeCents = 0;
  let receivedIncomeCents = 0;
  for (const income of incomeRows) {
    plannedIncomeCents += income.plannedCents;
    receivedIncomeCents += income.receivedCents;
  }

  let plannedFundCents = 0;
  for (const fund of fundRows) {
    plannedFundCents += fund.plannedCents;
  }

  return {
    allocatedCents,
    effectiveCents,
    spentCents,
    remainingCents: effectiveCents - spentCents,
    plannedIncomeCents,
    receivedIncomeCents,
    plannedFundCents,
    leftToBudgetCents: plannedIncomeCents - allocatedCents - plannedFundCents,
    fundCount: fundRows.length,
  };
}
