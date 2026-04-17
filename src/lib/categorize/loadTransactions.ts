import { and, desc, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type TransactionFilter = {
  /** `number` = exact category, `"none"` = NULL-category backlog, `undefined` = any. */
  categoryId?: number | "none";
  /** Both must be provided together; caller validates at the Zod boundary. */
  year?: number;
  month?: number;
  /** 1-indexed page number. */
  page: number;
  /** Rows per page. Caller clamps to [1, 500]. */
  pageSize: number;
};

export type TransactionRow = {
  id: number;
  date: string;
  rawDescription: string;
  rawMemo: string;
  normalizedMerchant: string;
  amountCents: number;
  isPending: boolean;
  categoryId: number | null;
  categoryName: string | null;
  accountId: number;
  accountName: string;
};

export type LoadTransactionsResult = {
  rows: TransactionRow[];
  totalCount: number;
};

/**
 * Paginated read for `/transactions`. Transfer-paired rows are unconditionally
 * excluded so categorize actions never touch rows owned by the pair machinery
 * (matches `/budget` MTD semantics).
 *
 * Date window: when `year`+`month` are set, restricts to `[first_day, first_of_next_month)`.
 * No window → no date restriction (caller layer can choose a default like last 60 days).
 *
 * Sort: `date DESC, id DESC` — newest first, stable tiebreaker.
 */
export function loadTransactions(
  db: Db,
  filter: TransactionFilter,
): LoadTransactionsResult {
  const predicates: SQL[] = [isNull(schema.transactions.transferPairId)];

  if (filter.categoryId === "none") {
    predicates.push(isNull(schema.transactions.categoryId));
  } else if (typeof filter.categoryId === "number") {
    predicates.push(eq(schema.transactions.categoryId, filter.categoryId));
  }

  if (filter.year !== undefined && filter.month !== undefined) {
    const firstDay = monthBoundary(filter.year, filter.month);
    const [ny, nm] = nextMonth(filter.year, filter.month);
    const firstDayNext = monthBoundary(ny, nm);
    predicates.push(gte(schema.transactions.date, firstDay));
    predicates.push(lt(schema.transactions.date, firstDayNext));
  }

  const where = and(...predicates);

  const countRow = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.transactions)
    .where(where)
    .get();
  const totalCount = Number(countRow?.count ?? 0);

  const offset = (filter.page - 1) * filter.pageSize;

  const rows = db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      rawDescription: schema.transactions.rawDescription,
      rawMemo: schema.transactions.rawMemo,
      normalizedMerchant: schema.transactions.normalizedMerchant,
      amountCents: schema.transactions.amountCents,
      isPending: schema.transactions.isPending,
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      accountId: schema.transactions.accountId,
      accountName: schema.accounts.name,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.categories.id, schema.transactions.categoryId),
    )
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.transactions.accountId),
    )
    .where(where)
    .orderBy(desc(schema.transactions.date), desc(schema.transactions.id))
    .limit(filter.pageSize)
    .offset(offset)
    .all();

  return { rows, totalCount };
}

function nextMonth(year: number, month: number): [number, number] {
  if (month === 12) return [year + 1, 1];
  return [year, month + 1];
}

function monthBoundary(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}
