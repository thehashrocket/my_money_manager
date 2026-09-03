import { and, eq, isNotNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { readAccessUrl } from "./accessUrl";
import { fetchAccounts } from "./client";
import { parseAmountToCents } from "./parseAmount";

type Db = typeof defaultDb;

/** Listing accounts blocks a page render, so it gets a short leash. */
const LIST_ACCOUNTS_TIMEOUT_MS = 15_000;

export type RemoteAccount = {
  simplefinAccountId: string;
  name: string;
  orgName: string | null;
  balanceCents: number | null;
  availableBalanceCents: number | null;
  balanceDate: string | null;
  /** Local account this is wired to, if any. */
  linkedAccountId: number | null;
};

/**
 * Lists what the token can see, so accounts can be wired up by hand. Uses
 * balances-only: linking needs names and balances, not 90 days of history.
 *
 * The feed also returns accounts this app does not model — a mortgage, in Star
 * One's case. Linking is explicit precisely so those stay out.
 */
export async function listRemoteAccounts(
  db: Db = defaultDb,
): Promise<RemoteAccount[]> {
  const creds = readAccessUrl();
  const response = await fetchAccounts(creds, {
    startDate: Math.floor(Date.now() / 1000),
    balancesOnly: true,
    // undici defaults headersTimeout and bodyTimeout to 300s each — far too
    // long for something inside a page render. Without a shorter deadline a
    // stalled bridge hangs the page for five minutes instead of falling through
    // to the error banner.
    signal: AbortSignal.timeout(LIST_ACCOUNTS_TIMEOUT_MS),
  });

  const local = db.select().from(schema.accounts).all();
  const linkedBy = new Map(
    local
      .filter((a) => a.simplefinAccountId)
      .map((a) => [a.simplefinAccountId!, a.id]),
  );

  return (response.accounts ?? []).map((a) => ({
    simplefinAccountId: a.id,
    name: a.name,
    orgName: a.org?.name ?? null,
    balanceCents: a.balance ? parseAmountToCents(a.balance) : null,
    availableBalanceCents: a["available-balance"]
      ? parseAmountToCents(a["available-balance"]!)
      : null,
    balanceDate: a["balance-date"]
      ? new Date(a["balance-date"]! * 1000).toISOString()
      : null,
    linkedAccountId: linkedBy.get(a.id) ?? null,
  }));
}

export type SetAccountLinkResult = {
  /**
   * Set when re-pointing this account's feed link cleared external_id off
   * rows already imported under the old link. This fixes the SQL-level crash
   * (the partial unique index on (account_id, external_id) colliding on
   * resync) but NOT the double-count risk: sync's content-dedup fallback in
   * src/lib/simplefin/sync.ts is scoped to the account being synced, so it
   * cannot see these rows if a different account claims the feed next. The
   * user is expected to delete or reconcile them manually in that case.
   */
  warning: string | null;
};

export function setAccountLink(
  localAccountId: number,
  simplefinAccountId: string | null,
  db: Db = defaultDb,
): SetAccountLinkResult {
  const account = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, localAccountId))
    .get();
  if (!account) throw new Error(`No such account: ${localAccountId}`);

  if (simplefinAccountId) {
    const taken = db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.simplefinAccountId, simplefinAccountId))
      .get();
    if (taken && taken.id !== localAccountId) {
      throw new Error(
        "That SimpleFIN account is already linked to a different local account.",
      );
    }
  }

  // Re-pointing this account's link (unlinking, or linking to a different
  // feed account) orphans external_id on rows already imported under the old
  // link: the partial unique index is scoped to (account_id, external_id),
  // so a resync under whatever account claims the old feed id next would not
  // recognize those rows and would crash with a unique-constraint violation.
  // Clearing it here fixes THAT crash. It does NOT, by itself, prevent the
  // double-count if a different account later claims the feed — sync's
  // content-dedup fallback is scoped to the account being synced (see the
  // warning message below) and has no visibility into another account's
  // rows. Both writes happen in one transaction so a crash mid-way never
  // leaves the account still pointed at the old link while its rows have
  // already lost their external_id.
  const clearOrphaned = Boolean(
    account.simplefinAccountId &&
      account.simplefinAccountId !== simplefinAccountId,
  );

  return db.transaction((tx) => {
    let warning: string | null = null;

    if (clearOrphaned) {
      const { changes } = tx
        .update(schema.transactions)
        .set({ externalId: null })
        .where(
          and(
            eq(schema.transactions.accountId, localAccountId),
            isNotNull(schema.transactions.externalId),
          ),
        )
        .run();

      if (changes > 0) {
        // Deliberately NOT "future syncs will dedup these automatically": the
        // content-dedup fallback in src/lib/simplefin/sync.ts is scoped to
        // the account being synced (eq(transactions.accountId, account.id)),
        // by design — it exists to catch a row re-sent by the feed onto the
        // SAME account it was already imported into, not a row that moved to
        // a DIFFERENT local account. If some other account claims this feed
        // id next, its sync has no way to see these rows at all and will
        // insert them fresh, double-counting every amount. Clearing
        // external_id only fixes the SQL-level crash (the unique index
        // collision); it does not, by itself, prevent that double-count.
        warning = `Cleared the SimpleFIN link tag on ${changes} previously-imported transaction${changes === 1 ? "" : "s"} on this account. If a different account links this same feed later, its sync will NOT recognize these as duplicates — delete or reconcile them here first, or you'll double-count them.`;
      }
    }

    tx.update(schema.accounts)
      .set({ simplefinAccountId, updatedAt: new Date() })
      .where(eq(schema.accounts.id, localAccountId))
      .run();

    return { warning };
  });
}
