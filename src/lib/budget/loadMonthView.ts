import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { computeMtdReceived, computeMtdSpent, getEffectiveAllocation } from "@/lib/budget";
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
 * Structure (A1): top-level bands come from `kind` — INCOME, EXPENSES,
 * FUNDS. Groups within a band come from `parent_id`. An unparented category
 * renders directly under its band; there is no synthetic "Ungrouped" header.
 *
 * `Uncategorized` is excluded from `sections` and returned as its own field
 * (X5); DS26 makes it conditional (see `UncategorizedRow`'s docstring).
 *
 * All reads use `getEffectiveAllocation({ persist: false })` so this function
 * is safe to call from a Server Component render path: no writes during
 * prefetch, no double-fire hazard (review decision 7 / T2A).
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
  const expenseLeaves = categories.filter(
    (c) => c.kind === "expense" && !parentIds.has(c.id) && c.name !== "Uncategorized",
  );
  const incomeLeaves = categories.filter((c) => c.kind === "income" && !parentIds.has(c.id));
  const fundLeaves = categories.filter((c) => c.kind === "fund" && !parentIds.has(c.id));

  const pendingByCategory = loadPendingByCategory(db, year, month);

  const leafRows: LeafRow[] = expenseLeaves.map((leaf) =>
    buildLeafRow(db, leaf, year, month, pendingByCategory),
  );

  const incomeRows: IncomeLeafRow[] = incomeLeaves.map((leaf) => {
    const plannedCents = getEffectiveAllocation(db, leaf.id, year, month)?.allocatedCents ?? 0;
    const receivedCents = computeMtdReceived(db, leaf.id, year, month);
    return {
      categoryId: leaf.id,
      name: leaf.name,
      parentId: leaf.parentId,
      plannedCents,
      receivedCents,
      varianceCents: receivedCents - plannedCents,
    };
  });

  const fundRows: FundRow[] = fundLeaves
    .map((leaf) => ({
      categoryId: leaf.id,
      name: leaf.name,
      plannedCents: getEffectiveAllocation(db, leaf.id, year, month)?.allocatedCents ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const uncategorizedBacklog = loadUncategorizedBacklog(db, { year, month });
  let uncategorizedRow: UncategorizedRow | null = null;
  if (uncategorizedCategory) {
    const spentCents = computeMtdSpent(db, uncategorizedCategory.id, year, month);
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

function buildLeafRow(
  db: Db,
  leaf: typeof schema.categories.$inferSelect,
  year: number,
  month: number,
  pendingByCategory: Map<number, number>,
): LeafRow {
  const allocation = getEffectiveAllocation(db, leaf.id, year, month);
  const spentCents = computeMtdSpent(db, leaf.id, year, month);
  const pendingCents = pendingByCategory.get(leaf.id) ?? 0;
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
}

function loadPendingByCategory(
  db: Db,
  year: number,
  month: number,
): Map<number, number> {
  const firstDay = monthBoundary(year, month);
  const { year: nextYear, month: nextMonth } = nextMonthOf(year, month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);

  const rows = db
    .select({
      categoryId: schema.transactions.categoryId,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.isPending, true),
        isNull(schema.transactions.transferPairId),
        gte(schema.transactions.date, firstDay),
        sql`${schema.transactions.date} < ${firstDayNext}`,
      ),
    )
    .groupBy(schema.transactions.categoryId)
    .all();

  const map = new Map<number, number>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    map.set(row.categoryId, 0 - row.total);
  }
  return map;
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
