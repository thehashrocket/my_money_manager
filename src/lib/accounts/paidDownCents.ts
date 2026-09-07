import { and, between, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { lastDayOfMonth, monthBoundary } from "@/lib/budget/monthOfIso";

type Db = typeof defaultDb;

/**
 * How much debt this account had paid off in (year, month), or `null` when
 * the figure is not computable for it.
 *
 * DS58 — D13=B is right that a card payment must be invisible to every spend
 * query (it is transfer-paired, so the existing `transfer_pair_id IS NULL`
 * filters exclude it with no new clauses). The cost of that correct decision
 * is that you pay $500 and the entire reward in the app is that a red number
 * is slightly less red. For a feature whose stated purpose is a debt-payoff
 * journey, that is a behavioural layer with nothing above or below it.
 *
 * E13 narrows the predicate from the original `SUM(amount_cents > 0)` to
 * "paired positives only", i.e. literally payments, which is what the figure
 * is named for. The original was correct only by accident — the payment
 * mirror was the sole positive row a card could own — and became wrong the
 * moment refunds became representable. A $200 Costco return is a positive,
 * unpaired row; counting it as debt paid down would overstate your progress
 * using money you never sent the lender.
 *
 * Returns `null`, not `0`, when the account owns no rows at all. The mortgage
 * has zero rows by D3=A, so the figure is genuinely uncomputable there and a
 * `$0.00` would be a false statement about a real account. Callers omit the
 * line entirely for `null` — and DS58 also omits it at `0`, since a `$0.00`
 * in a month you did not pay reads as a reproach.
 */
export function paidDownCents(
  accountId: number,
  year: number,
  month: number,
  db: Db = defaultDb,
): number | null {
  const owns = db
    .select({ one: sql<number>`1` })
    .from(schema.transactions)
    .where(eq(schema.transactions.accountId, accountId))
    .limit(1)
    .get();
  if (owns === undefined) return null;

  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)` })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, accountId),
        between(
          schema.transactions.date,
          monthBoundary(year, month),
          lastDayOfMonth(year, month),
        ),
        gt(schema.transactions.amountCents, 0),
        // E13: paired only. An unpaired positive on a card is a refund, not a
        // payment — the money came back from a merchant, not out of checking.
        isNotNull(schema.transactions.transferPairId),
      ),
    )
    .get();

  return row?.total ?? 0;
}
