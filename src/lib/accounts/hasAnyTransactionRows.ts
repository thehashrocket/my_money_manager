import { eq, sql } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";

/**
 * Does this account own ANY transaction row at all?
 *
 * "Zero transaction rows" is load-bearing in three places — D7/D15's scope
 * rule for the feed balance pass, E1's sync partition, and
 * `resolveBalanceAction` — and it was never defined. There are two readings
 * and the cheap one is wrong (E16).
 *
 * The cheap reading reuses `loadAccountBalances`' existing aggregate, which
 * is already scanning `date > starting_balance_date`, so a COUNT there costs
 * nothing. But reconcile a card to today and every row it owns now sits
 * BEFORE the anchor — the anchor-filtered count reads zero, the account looks
 * eligible for a feed balance refresh, and D15's whole safety argument
 * collapses. That argument is "for an account with no rows at all the SUM is
 * zero regardless, so the instant-vs-close-of-day imprecision is
 * unobservable," and it only holds when there are genuinely no rows to drop.
 *
 * So: EXISTS, no anchor filter, one helper for all three call sites.
 *
 * Takes `AnyDb` so a caller inside a write transaction can pass its handle:
 * the feed balance pass re-checks this INSIDE its per-account transaction,
 * because a row imported during the fetch window makes the account ineligible
 * (D7/D15) and the pre-transaction answer could say otherwise.
 */
export function hasAnyTransactionRows(accountId: number, db: AnyDb = defaultDb): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(schema.transactions)
    .where(eq(schema.transactions.accountId, accountId))
    .limit(1)
    .get();
  return row !== undefined;
}
