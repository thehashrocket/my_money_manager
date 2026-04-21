import { eq, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type CategorySpend = {
  name: string;
  spentCents: number;
};

export type MonthTrend = {
  year: number;
  month: number;
  label: string;
  totalSpentCents: number;
  byCategory: CategorySpend[];
};

export type TrendData = {
  months: MonthTrend[];
  categoryNames: string[];
};

function nMonthsBack(year: number, month: number, n: number): [number, number] {
  let y = year;
  let m = month - n;
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  return [y, m];
}

function monthBoundary(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function loadMonthlyTrends(db: Db, monthCount = 6): TrendData {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const [startYear, startMonth] = nMonthsBack(currentYear, currentMonth, monthCount - 1);
  const startDate = monthBoundary(startYear, startMonth);

  // Build leaf → parent name map (excluding savings goals)
  const allCategories = db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
    })
    .from(schema.categories)
    .where(eq(schema.categories.isSavingsGoal, false))
    .all();

  const categoryNameById = new Map<number, string>();
  const parentIdById = new Map<number, number | null>();
  for (const c of allCategories) {
    categoryNameById.set(c.id, c.name);
    parentIdById.set(c.id, c.parentId);
  }

  // Resolve leaf → root parent name ("Other" for ungrouped leaves)
  function resolveGroupName(categoryId: number): string {
    const parentId = parentIdById.get(categoryId);
    if (parentId == null) return categoryNameById.get(categoryId) ?? "Other";
    return categoryNameById.get(parentId) ?? "Other";
  }

  // Aggregate spend per leaf category per month
  const spendRows = db
    .select({
      yr: sql<string>`strftime('%Y', ${schema.transactions.date})`,
      mo: sql<string>`strftime('%m', ${schema.transactions.date})`,
      categoryId: schema.transactions.categoryId,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      sql`${schema.transactions.transferPairId} IS NULL
        AND ${schema.transactions.amountCents} < 0
        AND ${schema.transactions.categoryId} IS NOT NULL
        AND ${schema.transactions.date} >= ${startDate}`,
    )
    .groupBy(
      sql`strftime('%Y', ${schema.transactions.date})`,
      sql`strftime('%m', ${schema.transactions.date})`,
      schema.transactions.categoryId,
    )
    .all();

  // Build month frame oldest → newest
  const months: MonthTrend[] = [];
  const totalByGroup = new Map<string, number>();

  for (let i = 0; i < monthCount; i++) {
    const [y, m] = nMonthsBack(currentYear, currentMonth, monthCount - 1 - i);
    months.push({
      year: y,
      month: m,
      label: monthLabel(y, m),
      totalSpentCents: 0,
      byCategory: [],
    });
  }

  // Bucket rows into month frame
  const spendByMonthAndGroup = new Map<string, Map<string, number>>();
  for (const row of spendRows) {
    if (row.categoryId === null) continue;
    const groupName = resolveGroupName(row.categoryId);
    const key = `${row.yr}-${row.mo}`;
    const bucket = spendByMonthAndGroup.get(key) ?? new Map<string, number>();
    const prev = bucket.get(groupName) ?? 0;
    const spend = 0 - row.total; // flip to positive
    bucket.set(groupName, prev + spend);
    spendByMonthAndGroup.set(key, bucket);

    totalByGroup.set(groupName, (totalByGroup.get(groupName) ?? 0) + spend);
  }

  for (const month of months) {
    const key = `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`;
    const bucket = spendByMonthAndGroup.get(key);
    if (bucket) {
      let total = 0;
      const byCategory: CategorySpend[] = [];
      for (const [name, spentCents] of bucket.entries()) {
        byCategory.push({ name, spentCents });
        total += spentCents;
      }
      month.totalSpentCents = total;
      month.byCategory = byCategory.sort((a, b) => b.spentCents - a.spentCents);
    }
  }

  // Stable category name list: sorted by total spend descending
  const categoryNames = [...totalByGroup.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  return { months, categoryNames };
}
