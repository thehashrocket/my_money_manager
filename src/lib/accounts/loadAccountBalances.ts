import { cache } from "react";
import { and, eq, gt, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { accountClass, type AccountClass } from "./accountClass";
import type { BalanceSource } from "./resolveBalanceAction";

type Db = typeof defaultDb;

/** Widened by migration 0018 to include `credit` and `loan`. */
export type AccountType = typeof schema.accounts.$inferSelect["type"];

export type AccountBalance = {
  id: number;
  name: string;
  type: AccountType;
  /**
   * `accountClass(type)`, carried on the row so callers don't each re-derive
   * it. Still derived, never stored — see accountClass.ts.
   */
  class: AccountClass;
  /**
   * Negative for a liability: owing $2,000 is -200000. Every consumer already
   * handled a negative balance (an overdrawn checking account), so nothing
   * downstream needed a new branch — that is the whole argument for the sign
   * convention.
   */
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
  /** Liability display fields. All NULL on an asset, and unread there. */
  simplefinAccountId: string | null;
  creditLimitCents: number | null;
  minimumPaymentCents: number | null;
  balanceAsOf: Date | null;
  balanceSource: BalanceSource | null;
  /**
   * The anchor immediately before the current one, or NULL when this account's
   * balance has never been moved. Every writer of `starting_balance_*` records
   * it, which is what makes a reconcile one click to reverse — the guarantee
   * `/accounts/error.tsx` states in prose.
   */
  priorStartingBalanceCents: number | null;
  priorStartingBalanceDate: string | null;
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
      class: accountClass(a.type),
      balanceCents: a.startingBalanceCents + (row?.delta ?? 0),
      startingBalanceDate: a.startingBalanceDate,
      ledgerAsOfDate: row?.newestDate ?? a.startingBalanceDate,
      simplefinAccountId: a.simplefinAccountId,
      creditLimitCents: a.creditLimitCents,
      minimumPaymentCents: a.minimumPaymentCents,
      balanceAsOf: a.balanceAsOf,
      balanceSource: a.balanceSource,
      priorStartingBalanceCents: a.priorStartingBalanceCents,
      priorStartingBalanceDate: a.priorStartingBalanceDate,
    };
  });
}

/**
 * The render-path entry point: the same query set, memoized for one request.
 *
 * `Spine` is mounted in the root layout, so it runs on EVERY route, and the
 * pages that show balances (`/`, `/accounts`, `/budget/[y]/[m]`, `/sync`) each
 * ran the whole thing again in their own body — two full passes over the
 * transactions table per render, on a synchronous better-sqlite3 driver that
 * blocks the event loop while it works. This is the one cost here that grows
 * linearly with transaction count.
 *
 * `cache()` is request-scoped, not a cross-request cache: a server action that
 * writes and then revalidates starts a new request, so a mutation is never
 * served a stale figure.
 *
 * Deliberately takes NO db argument. `cache` keys on arguments, so `f()` and
 * `f(defaultDb)` would be two entries and neither would hit — and the callers
 * that must NOT be memoized are exactly the ones passing an explicit handle:
 * `manualTransaction.ts` reads the balance back inside its own write
 * transaction, where a memo from earlier in the request would be wrong.
 * Those keep calling `loadAccountBalances` directly.
 */
export const loadAccountBalancesForRequest = cache((): AccountBalance[] =>
  loadAccountBalances(defaultDb),
);
