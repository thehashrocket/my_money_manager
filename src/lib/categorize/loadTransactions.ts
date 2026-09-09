import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

/** Everything that narrows the row set — the paging window is not part of it. */
export type FilterPredicateInput = {
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
  /**
   * D14=B — reveal transfer-paired rows. Defaults to false, which is the
   * historical (and correct-for-bank-transfers) behaviour.
   *
   * This exists because marking a checking debit as a card payment makes it a
   * transfer pair, and paired rows are unconditionally hidden here — so a
   * routine, deliberate action would make the row VANISH from the page you
   * use to manage transactions, with the only surface listing pairs being
   * /sync's review queue on a 240-day window. Hiding auto-detected bank
   * transfers is right; hiding something the user just did is not.
   */
  includeTransfers?: boolean;
  /** Matched against rawDescription/normalizedMerchant/payee — SQLite's default `LIKE` is case-insensitive for ASCII. */
  search?: string;
  /**
   * D2 — EXACT `normalized_merchant`, the `/categorize` drilldown's filter.
   *
   * Deliberately not `search`: that one is `LIKE %x%` across three columns,
   * and on 11 of 181 real merchant groups it returns a superset (`AMAZON`
   * 59 rows → 71, by also matching `AMAZON PRIME`). The 59 is what this exact
   * filter returns for the key — ALL of its rows, filed included, which is
   * what D3 opens; 53 is the group's uncategorized subset shown on
   * `/categorize`, and comparing the superset against that instead overstated
   * the gap. A drilldown that quietly
   * shows you more rows than the group you clicked is the silent-wrong-result
   * class this codebase's rules exist to prevent — so this is `eq()`, which
   * is also index-backed (`transactions_merchant_idx`).
   */
  merchant?: string;
};

export type TransactionFilter = FilterPredicateInput & {
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
  /**
   * Which write path produced this row. Carried because the `/transactions`
   * row menu offers "Remove this charge" for a HAND-ENTERED card row only —
   * `removeCardActivity` refuses a bank row, and a menu that offered the item
   * anyway would be a refusal the user can only discover by triggering it
   * (the rule 8 mistake `assignableKinds` exists to avoid repeating).
   */
  importSource: "csv" | "simplefin" | "manual";
  /** Non-null only on a paired row, and only when `includeTransfers` is set. */
  transferPairId: number | null;
  /** The other leg's account name — what makes a revealed row legible. */
  transferPartnerAccountName: string | null;
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
 * The WHERE clause, built once and shared by every read that has to agree
 * with the visible list: the page's rows, its `totalCount`, and T9's
 * per-category breakdown in the header. Three call sites re-deriving these
 * predicates by hand is how a header ends up describing a different row set
 * than the one under it.
 *
 * Date window: `dateFrom`/`dateTo` are independent, inclusive bounds — either,
 * both, or neither may be set. Replaces the old `year`+`month` window (whole
 * months are now expressed as `dateFrom=monthBoundary(...)`,
 * `dateTo=lastDayOfMonth(...)` by the caller).
 *
 * Amount window is magnitude-based (`ABS(amount_cents)`), not signed — see
 * `TransactionFilter.amountMinCents`. `ABS()` on the column means the
 * predicate can't use an index, same as `searchPredicate`'s `LIKE` above;
 * both are negligible at this app's realistic row counts (single household,
 * low thousands of rows even after years).
 */
function buildPredicates(filter: FilterPredicateInput): SQL[] {
  const predicates: SQL[] = [];
  if (!filter.includeTransfers) {
    predicates.push(isNull(schema.transactions.transferPairId));
  }

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

  if (filter.merchant !== undefined && filter.merchant !== "") {
    predicates.push(eq(schema.transactions.normalizedMerchant, filter.merchant));
  }

  return predicates;
}

/**
 * Paginated read for `/transactions`. Transfer-paired rows are excluded by
 * default so categorize actions never touch rows owned by the pair machinery
 * (matches `/budget` MTD semantics); `includeTransfers` reveals them.
 *
 * The WHERE clause itself is `buildPredicates` above — shared with
 * `summarizeByCategory`, which is the only reason the header and the list
 * under it cannot disagree about which rows match. (Which rows, not which
 * instant — see that function's docstring.)
 *
 * Sort: `date DESC, id DESC` — newest first, stable tiebreaker.
 */
export function loadTransactions(
  db: Db,
  filter: TransactionFilter,
): LoadTransactionsResult {
  const where = and(...buildPredicates(filter));
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
        importSource: schema.transactions.importSource,
        transferPairId: schema.transactions.transferPairId,
        // T26 needs to name the other side ("paired with Visa"), or a
        // revealed row is just a transaction that mysteriously does not count.
        transferPartnerAccountName: sql<string | null>`(
          SELECT partner_account.name
          FROM ${schema.transactions} AS partner
          JOIN ${schema.accounts} AS partner_account
            ON partner_account.id = partner.account_id
          WHERE partner.id = ${schema.transactions.transferPairId}
        )`,
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

export type CategoryBreakdownRow = {
  /** `null` = the uncategorized backlog inside this filter's row set. */
  categoryId: number | null;
  categoryName: string | null;
  count: number;
};

/**
 * T9/D18 — how the rows matching `filter` are already filed, biggest group
 * first.
 *
 * This is what makes the merchant header answer the question the user came
 * with. D3 chose to show ALL of a merchant's rows, not just its uncategorized
 * ones, precisely because the prior filing history IS the decision support
 * ("49 of these are already filed as Gas"). Without this aggregate the header
 * can only report a total, which is the number the user could already see.
 *
 * Shares `buildPredicates` with the list itself, so the two can never disagree
 * about WHICH ROWS MATCH — the failure this was extracted to make impossible
 * was a header describing one filter set while the list applied another.
 *
 * It is not a snapshot guarantee, and the difference is worth being precise
 * about: `loadTransactions` wraps its count and its rows in one
 * `db.transaction`, while this is a separate call from the page. A categorize
 * action committing between the two (a second tab, an in-flight Undo) can
 * still leave the header a beat behind the list. The predicates cannot
 * diverge; the read instants can.
 *
 * Ignores paging on purpose — it summarises the whole filtered set, not page 1.
 */
export function summarizeByCategory(
  db: Db,
  filter: FilterPredicateInput,
): CategoryBreakdownRow[] {
  return db
    .select({
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.categories.id, schema.transactions.categoryId),
    )
    .where(and(...buildPredicates(filter)))
    .groupBy(schema.transactions.categoryId)
    .all()
    .map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      count: Number(r.count),
    }))
    // Ties need a deterministic order or the header's "top two filed
    // categories" would depend on SQLite's grouping order. Uncategorized
    // sorts last among equals: the header states it separately, and a
    // *filed* category is the evidence the reader came for.
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.categoryName === null) return 1;
      if (b.categoryName === null) return -1;
      return a.categoryName.localeCompare(b.categoryName);
    });
}
