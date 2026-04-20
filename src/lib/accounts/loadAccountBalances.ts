import { and, eq, gt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type AccountBalance = {
  id: number;
  name: string;
  type: "checking" | "savings";
  balanceCents: number;
};

/**
 * Per-account current balance using the authoritative rule from CLAUDE.md:
 *   balance = starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)
 *
 * Includes transfer-paired rows on purpose — they still affect the account's
 * own running balance (transfers are money-neutral across accounts but not
 * within a single account).
 */
export function loadAccountBalances(db: Db = defaultDb): AccountBalance[] {
  const accounts = db.select().from(schema.accounts).all();

  return accounts.map((a) => {
    const row = db
      .select({
        delta: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, a.id),
          gt(schema.transactions.date, a.startingBalanceDate),
        ),
      )
      .get();

    return {
      id: a.id,
      name: a.name,
      type: a.type,
      balanceCents: a.startingBalanceCents + (row?.delta ?? 0),
    };
  });
}
