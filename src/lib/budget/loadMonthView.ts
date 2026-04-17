import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { computeMtdSpent, getEffectiveAllocation } from "@/lib/budget";

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

export type SectionGroup = {
  /** `null` for the synthetic "Ungrouped" section (leaves with `parent_id = NULL`). */
  parentId: number | null;
  parentName: string | null;
  categories: LeafRow[];
};

export type MonthViewSummary = {
  allocatedCents: number;
  effectiveCents: number;
  spentCents: number;
  remainingCents: number;
};

export type UncategorizedBacklog = {
  count: number;
  /** Signed sum of `amount_cents` (spend is negative; refunds positive). */
  totalCents: number;
};

export type MonthView = {
  year: number;
  month: number;
  sections: SectionGroup[];
  summary: MonthViewSummary;
  uncategorizedBacklog: UncategorizedBacklog;
};

/**
 * Assemble the read model for `/budget/[year]/[month]`.
 *
 * Structure:
 * - Leaves (no children categories point at them) show as rows. Parents are
 *   header-only — they never carry allocations or spend.
 * - Synthetic "Ungrouped" section renders at the top whenever any leaf has
 *   `parent_id = NULL` (per review decision 1 / T3A). Mixed orphan + parented
 *   state is valid; the single rendering rule covers zero-parent, all-parent,
 *   and mixed cases.
 * - Savings goals (`is_savings_goal = true`) are excluded — they live in the
 *   (future) /goals surface.
 *
 * All reads use `getEffectiveAllocation({ persist: false })` so this function
 * is safe to call from a Server Component render path: no writes during
 * prefetch, no double-fire hazard (review decision 7 / T2A).
 *
 * Sorting: within each section, leaves sort by `spentCents DESC, name ASC`
 * (Pass 7 — biggest drains first). Named parent sections sort by name ASC;
 * the "Ungrouped" synthetic section always comes first.
 */
export function loadMonthView(
  db: Db,
  year: number,
  month: number,
): MonthView {
  const categories = db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.isSavingsGoal, false))
    .all();

  const parentIds = new Set<number>();
  for (const c of categories) {
    if (c.parentId !== null) parentIds.add(c.parentId);
  }

  const leaves = categories.filter((c) => !parentIds.has(c.id));
  const parentNameById = new Map<number, string>();
  for (const c of categories) {
    if (parentIds.has(c.id)) parentNameById.set(c.id, c.name);
  }

  const pendingByCategory = loadPendingByCategory(db, year, month);

  const leafRows: LeafRow[] = leaves.map((leaf) => {
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
  });

  const sections = groupIntoSections(leafRows, parentNameById);
  const summary = summarize(leafRows);
  const uncategorizedBacklog = loadUncategorizedBacklog(db);

  return { year, month, sections, summary, uncategorizedBacklog };
}

function loadPendingByCategory(
  db: Db,
  year: number,
  month: number,
): Map<number, number> {
  const firstDay = monthBoundary(year, month);
  const firstDayNext = monthBoundary(...nextMonth(year, month));

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

function loadUncategorizedBacklog(db: Db): UncategorizedBacklog {
  const row = db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .get();
  return {
    count: row?.count ?? 0,
    totalCents: row?.total ?? 0,
  };
}

function groupIntoSections(
  leaves: LeafRow[],
  parentNameById: Map<number, string>,
): SectionGroup[] {
  const buckets = new Map<number | "ungrouped", LeafRow[]>();
  for (const leaf of leaves) {
    const key = leaf.parentId ?? "ungrouped";
    const list = buckets.get(key) ?? [];
    list.push(leaf);
    buckets.set(key, list);
  }

  const sortLeaves = (rows: LeafRow[]) =>
    [...rows].sort((a, b) => {
      if (b.spentCents !== a.spentCents) return b.spentCents - a.spentCents;
      return a.name.localeCompare(b.name);
    });

  const sections: SectionGroup[] = [];
  const ungrouped = buckets.get("ungrouped");
  if (ungrouped?.length) {
    sections.push({
      parentId: null,
      parentName: null,
      categories: sortLeaves(ungrouped),
    });
  }

  const namedParents = [...buckets.entries()]
    .filter(([k]) => k !== "ungrouped")
    .map(([k, rows]) => ({
      parentId: k as number,
      parentName: parentNameById.get(k as number) ?? "",
      categories: sortLeaves(rows),
    }))
    .sort((a, b) => a.parentName.localeCompare(b.parentName));

  sections.push(...namedParents);
  return sections;
}

function summarize(leaves: LeafRow[]): MonthViewSummary {
  let allocatedCents = 0;
  let effectiveCents = 0;
  let spentCents = 0;
  for (const leaf of leaves) {
    allocatedCents += leaf.allocation?.allocatedCents ?? 0;
    effectiveCents += leaf.allocation?.effectiveCents ?? 0;
    spentCents += leaf.spentCents;
  }
  return {
    allocatedCents,
    effectiveCents,
    spentCents,
    remainingCents: effectiveCents - spentCents,
  };
}

function nextMonth(year: number, month: number): [number, number] {
  if (month === 12) return [year + 1, 1];
  return [year, month + 1];
}

function monthBoundary(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}
