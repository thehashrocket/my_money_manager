import { and, between, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { hasAnyTransactionRows } from "./hasAnyTransactionRows";
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
  // The sibling helper, not a second copy of its query — its own docstring
  // says "one helper for all three call sites", and this was the third.
  if (!hasAnyTransactionRows(accountId, db)) return null;

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
        //
        // Strictly redundant now: the EXISTS below cannot be satisfied when
        // `transfer_pair_id` is NULL, so deleting this line changes nothing and
        // fails no test. Kept as the readable statement of E13's rule — the
        // EXISTS reads as a clause about the PARTNER, and "must be paired at
        // all" is a separate fact that deserves to be visible next to it.
        isNotNull(schema.transactions.transferPairId),
        // ...and paired ACROSS accounts. "Paired" alone stopped being a proxy
        // for "payment" the moment same-account reversals became linkable: a
        // disputed charge and its provisional credit on one card now satisfy
        // `transfer_pair_id IS NOT NULL` on the positive leg, and counting that
        // reports money that never left checking as debt paid down. Measured
        // during /ship 2026-09-08: a $200 same-account reversal on a card took
        // this figure from $0.00 to $200.00 on /accounts and the dashboard.
        //
        // A real payment is cross-account by construction (the mirror row is
        // the withdrawal from checking), so this restores E13's actual intent
        // rather than narrowing it.
        sql`EXISTS (
          SELECT 1 FROM ${schema.transactions} AS partner
          WHERE partner.id = ${schema.transactions.transferPairId}
            AND partner.account_id <> ${schema.transactions.accountId}
        )`,
      ),
    )
    .get();

  return row?.total ?? 0;
}
