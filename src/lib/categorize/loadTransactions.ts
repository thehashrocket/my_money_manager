import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type TransactionFilter = {
  /** `number` = exact category, `"none"` = NULL-category backlog, `undefined` = any. */
  categoryId?: number | "none";
  accountId?: number;
  /** Inclusive on both ends. Either or both may be set independently. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Magnitude range in cents — matches `ABS(amount_cents)`, so a min/max of
   * 5000/10000 matches both a -$75 withdrawal and a +$75 deposit (D7:
   * "find transactions around $75" has no sign in a person's head).
   */
  amountMinCents?: number;
  amountMaxCents?: number;
  /** `undefined` = no filter (today's default: pending and posted both show). */
  isPending?: boolean;
  /** Matched against rawDescription/normalizedMerchant/payee — SQLite's default `LIKE` is case-insensitive for ASCII. */
  search?: string;
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

const LIKE_ESCAPE_CHAR = "\\";

/**
 * Escapes SQLite `LIKE` wildcards (`%`, `_`) and the escape character itself
 * so a literal search term (e.g. "50% off") matches literally instead of
 * being interpreted as a wildcard pattern.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE_CHAR}${ch}`);
}

function searchPredicate(term: string): SQL {
  const pattern = `%${escapeLikePattern(term)}%`;
  return sql`(${schema.transactions.rawDescription} LIKE ${pattern} ESCAPE ${LIKE_ESCAPE_CHAR}
    OR ${schema.transactions.normalizedMerchant} LIKE ${pattern} ESCAPE ${LIKE_ESCAPE_CHAR}
    OR ${schema.transactions.payee} LIKE ${pattern} ESCAPE ${LIKE_ESCAPE_CHAR})`;
}

/**
 * Paginated read for `/transactions`. Transfer-paired rows are unconditionally
 * excluded so categorize actions never touch rows owned by the pair machinery
 * (matches `/budget` MTD semantics).
 *
 * Date window: `dateFrom`/`dateTo` are independent, inclusive bounds — either,
 * both, or neither may be set. Replaces the old `year`+`month` window (whole
 * months are now expressed as `dateFrom=monthBoundary(...)`,
 * `dateTo=lastDayOfMonth(...)` by the caller).
 *
 * Amount window is magnitude-based (`ABS(amount_cents)`), not signed — see
 * `TransactionFilter.amountMinCents`. `ABS()` on the column means this
 * predicate can't use an index, same as the `LIKE` search below; both are
 * negligible at this app's realistic row counts (single household, low
 * thousands of rows even after years).
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

  if (filter.accountId !== undefined) {
    predicates.push(eq(schema.transactions.accountId, filter.accountId));
  }

  if (filter.dateFrom !== undefined) {
    predicates.push(gte(schema.transactions.date, filter.dateFrom));
  }
  if (filter.dateTo !== undefined) {
    predicates.push(lte(schema.transactions.date, filter.dateTo));
  }

  if (filter.amountMinCents !== undefined) {
    predicates.push(sql`ABS(${schema.transactions.amountCents}) >= ${filter.amountMinCents}`);
  }
  if (filter.amountMaxCents !== undefined) {
    predicates.push(sql`ABS(${schema.transactions.amountCents}) <= ${filter.amountMaxCents}`);
  }

  if (filter.isPending !== undefined) {
    predicates.push(eq(schema.transactions.isPending, filter.isPending));
  }

  if (filter.search !== undefined && filter.search.trim() !== "") {
    predicates.push(searchPredicate(filter.search.trim()));
  }

  const where = and(...predicates);
  const offset = (filter.page - 1) * filter.pageSize;

  return db.transaction((tx) => {
    const countRow = tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.transactions)
      .where(where)
      .get();
    const totalCount = Number(countRow?.count ?? 0);

    const rows = tx
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
  });
}
