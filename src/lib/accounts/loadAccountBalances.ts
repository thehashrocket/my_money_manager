import { and, eq, gt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type AccountBalance = {
  id: number;
  name: string;
  type: "checking" | "savings";
  balanceCents: number;
  /** The anchor this balance was computed from. */
  startingBalanceDate: string;
  /**
   * Newest posted row counted into `balanceCents`, or the anchor date when no
   * row follows it. The newest date this balance has an opinion about — which
   * is what decides whether a bank figure is new enough to be compared against
   * it. See `src/lib/simplefin/balanceFreshness.ts`.
   */
  ledgerAsOfDate: string;
};

/**
 * Per-account current balance using the authoritative rule from CLAUDE.md:
 *   balance = starting_balance_cents + SUM(amount_cents WHERE date > starting_balance_date)
 *
 * Excludes pending rows: Star One's own running balance (the source of the
 * starting-balance anchor) doesn't reflect a pending row's amount until it
 * posts, and SimpleFIN's `balance` field this is compared against (the
 * account's card of last resort for drift detection, `/sync`) is
 * posted-only. A CSV-imported pending row that inflated this sum would make
 * every later `/sync` report a phantom "row missing or duplicated" drift.
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
        // Same aggregate scan as the SUM rather than a second query: MAX over
        // the identical filtered set is the newest row folded into this total.
        newestDate: sql<
          string | null
        >`MAX(${schema.transactions.date})`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, a.id),
          gt(schema.transactions.date, a.startingBalanceDate),
          eq(schema.transactions.isPending, false),
        ),
      )
      .get();

    return {
      id: a.id,
      name: a.name,
      type: a.type,
      balanceCents: a.startingBalanceCents + (row?.delta ?? 0),
      startingBalanceDate: a.startingBalanceDate,
      ledgerAsOfDate: row?.newestDate ?? a.startingBalanceDate,
    };
  });
}
