import { and, eq, isNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { readAccessUrl } from "./accessUrl";
import { fetchAccounts } from "./client";
import { parseAmountToCents } from "@/lib/money";

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
   * Set only when this account still holds LEGACY orphans: simplefin-sourced
   * rows with no external_id, left behind by a relink from before
   * `transactions.simplefin_source_account_id` existed.
   *
   * Re-pointing a link no longer creates these. The clearing that did — and
   * the double-count it caused, because it erased the only record of which
   * feed a row came from — is gone; provenance is recorded at write time and
   * survives any number of relinks. So this set can only ever SHRINK, and on
   * a ledger that never relinked before the fix it is empty forever.
   *
   * It is still worth reporting: those rows carry no tag any sync can match,
   * so they remain exposed to exactly the old double-count if another account
   * claims this feed. Nothing can repair them automatically — the feed they
   * came from is unknowable after the fact, which is the whole reason the
   * column exists.
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

  // Re-pointing a link USED TO clear external_id on this account's rows, to
  // dodge a collision on the old partial unique index over
  // (account_id, external_id). That index is now over
  // (simplefin_source_account_id, external_id) — scoped by FEED — so there is
  // no collision to dodge: a SimpleFIN id is unique within its own feed
  // account, which is precisely what the index asserts, and moving a local
  // account's link cannot change which feed a row already came from.
  //
  // Deleting the clearing is the fix, not a simplification of it. The clearing
  // erased the only record of a row's origin, which is what left sync unable to
  // tell one feed's rows from another's and made the cross-account double-count
  // unpreventable rather than merely undetected.
  const linkChanged = account.simplefinAccountId !== simplefinAccountId;

  return db.transaction((tx) => {
    let warning: string | null = null;

    if (linkChanged) {
      // Legacy orphans only — rows a PRE-FIX relink stripped. Nothing in this
      // function creates them any more, so this query can only return rows
      // that predate the provenance column, and the count can only fall.
      //
      // Queried directly rather than derived from any write this call made,
      // which is what keeps it honest now that there is no write to derive it
      // from: the exposure belongs to the rows, not to this particular relink.
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
        // Still deliberately NOT "future syncs will dedup these automatically".
        // Rows written from here on carry their feed, so sync recognizes them
        // wherever they live — but these rows carry neither an external_id nor
        // a provenance tag, so no id-based pass can ever match them.
        //
        // Content dedup is the only net they have, and it is narrower than it
        // looks in the case this warning is actually about: `existingByContent`
        // is scoped `eq(accountId, account.id)`, so it only helps when THIS
        // account resyncs. A DIFFERENT account claiming this feed cannot see
        // these rows at all — not bounded by the 45-day window, invisible. Even
        // for a same-account resync the window applies, and older than that they
        // are on their own. Reconciling or deleting them is the only complete
        // answer, which is why the warning says so.
        const n = atRisk.length;
        warning = `${n} transaction${n === 1 ? "" : "s"} on this account ${n === 1 ? "was" : "were"} imported before de-dup tags were recorded, by an earlier relink. If a different account links this same feed later, its sync will NOT recognize ${n === 1 ? "it" : "them"} as ${n === 1 ? "a duplicate" : "duplicates"} and will import ${n === 1 ? "it" : "them"} again — reconcile or delete ${n === 1 ? "it" : "them"} here. Relinking no longer creates this.`;
      }
    }

    tx.update(schema.accounts)
      .set({ simplefinAccountId, updatedAt: new Date() })
      .where(eq(schema.accounts.id, localAccountId))
      .run();

    return { warning };
  });
}
