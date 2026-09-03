import { and, eq, isNotNull, isNull } from "drizzle-orm";
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
   * Set whenever this account's feed link changes (unlink or re-point) and
   * this account currently holds simplefin-sourced rows with no external_id
   * — whether cleared just now or by an earlier relink. Clearing external_id
   * fixes the SQL-level crash (the partial unique index on
   * (account_id, external_id) colliding on resync) but NOT the double-count
   * risk: sync's content-dedup fallback in src/lib/simplefin/sync.ts is
   * scoped to the account being synced, so it cannot see these rows if a
   * different account claims the feed next. The user is expected to delete
   * or reconcile them manually in that case.
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
  const linkChanged = account.simplefinAccountId !== simplefinAccountId;

  return db.transaction((tx) => {
    if (clearOrphaned) {
      tx.update(schema.transactions)
        .set({ externalId: null })
        .where(
          and(
            eq(schema.transactions.accountId, localAccountId),
            isNotNull(schema.transactions.externalId),
          ),
        )
        .run();
    }

    let warning: string | null = null;

    if (linkChanged) {
      // Counting rows cleared by the UPDATE above (its `changes`) undercounts
      // — or misses the warning entirely: a row orphaned by an EARLIER relink
      // is exactly as exposed as one cleared just now, since neither carries
      // a tag a future sync can see, but `changes` is 0 for it whenever this
      // call had nothing new to clear (every row already cleared by a prior
      // relink, or this call is a fresh link with no clearing to do at all).
      // Querying the current at-risk set directly, instead of trusting the
      // UPDATE's own count, means the warning can't silently disappear just
      // because the clearing work happened to already be done.
      const atRisk = tx
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.accountId, localAccountId),
            eq(schema.transactions.importSource, "simplefin"),
            isNull(schema.transactions.externalId),
          ),
        )
        .all();

      if (atRisk.length > 0) {
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
        const n = atRisk.length;
        warning = `${n} previously-imported transaction${n === 1 ? "" : "s"} on this account ${n === 1 ? "carries" : "carry"} no SimpleFIN de-dup tag. If a different account links this same feed later, its sync will NOT recognize ${n === 1 ? "it" : "them"} as a duplicate — delete or reconcile ${n === 1 ? "it" : "them"} here first, or you'll double-count ${n === 1 ? "it" : "them"}.`;
      }
    }

    tx.update(schema.accounts)
      .set({ simplefinAccountId, updatedAt: new Date() })
      .where(eq(schema.accounts.id, localAccountId))
      .run();

    return { warning };
  });
}
