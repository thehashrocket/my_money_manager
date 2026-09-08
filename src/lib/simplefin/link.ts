import { and, eq, inArray, isNull, ne } from "drizzle-orm";
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
   * Set on a link CHANGE when either of two independent things is true. They
   * are joined into one string; a relink can raise both at once.
   *
   * (a) This account holds rows no id-based pass can ever match — keyed on
   *     `simplefin_source_account_id IS NULL`, deliberately NOT on
   *     `external_id IS NULL`. That is a strict superset covering two
   *     populations: LEGACY orphans (both columns NULL, stripped by a relink
   *     from before the provenance column existed) and rows that still CARRY
   *     an external_id but got no tag, which migration 0020 leaves behind for
   *     a sync row whose account was unlinked when it ran, since its backfill
   *     is `WHERE external_id IS NOT NULL`. Both are equally unmatchable, so
   *     keying on the column that decides matchability is what keeps the
   *     second population from being invisible here.
   *
   *     Re-pointing a link no longer creates the first population. The
   *     clearing that did — and the double-count it caused, because it erased
   *     the only record of which feed a row came from — is gone; provenance is
   *     recorded at write time and survives any number of relinks. Nothing can
   *     repair these automatically: the feed they came from is unknowable
   *     after the fact, which is the whole reason the column exists.
   *
   * (b) The feed being claimed already has rows filed under a DIFFERENT local
   *     account. Sync will correctly refuse to re-import them (that is the
   *     de-dup working), but they stay where they are, so this account's
   *     balance ends up short by the whole overlap. That under-count is the
   *     accepted cost of recording provenance instead of moving rows, and the
   *     relink is the one moment a person can act on it.
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
    const warnings: string[] = [];

    if (linkChanged) {
      // Every sync row that NO id-based pass can ever match, which is exactly
      // "provenance is NULL" — not "external_id is NULL".
      //
      // Those are two different sets and the difference is reachable. A legacy
      // orphan (stripped by a pre-fix relink) has both columns NULL, so it is
      // still caught. But migration 0020 backfills only `WHERE external_id IS
      // NOT NULL`, so a sync row whose account was unlinked when 0020 ran keeps
      // its external_id and gets NULL provenance — same total exposure, and an
      // `isNull(externalId)` query is structurally blind to it. Keying on the
      // column that actually decides matchability makes this a strict superset
      // and removes the blind spot; a row WITH a tag is excluded by
      // construction, so nothing false is added.
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
            isNull(schema.transactions.simplefinSourceAccountId),
          ),
        )
        .all();

      if (atRisk.length > 0) {
        // Still deliberately NOT "future syncs will dedup these automatically".
        // Rows written from here on carry their feed, so sync recognizes them
        // wherever they live — but these rows carry no provenance tag, so no
        // id-based pass can ever match them. (Some also lack an external_id;
        // that is incidental. The missing TAG is what makes them unmatchable,
        // which is why the query keys on it.)
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
        warnings.push(
          `${n} transaction${n === 1 ? "" : "s"} on this account ${n === 1 ? "was" : "were"} imported without the de-dup tag sync matches on. If a different account links this same feed later, its sync will NOT recognize ${n === 1 ? "it" : "them"} as ${n === 1 ? "a duplicate" : "duplicates"} and will import ${n === 1 ? "it" : "them"} again — reconcile or delete ${n === 1 ? "it" : "them"} here. Relinking no longer creates this.`,
        );
      }

      // The other side of the same coin, and the one the provenance fix
      // CREATED. Scoping the id pass by feed means a feed's rows are recognized
      // wherever they live — so an account claiming a feed whose rows sit on a
      // DIFFERENT local account imports none of them and reports "up to date".
      // No duplicate, which is the bug we set out to fix; but the rows stay on
      // the old account, so this account's balance is short by the whole
      // overlap and rule 1's drift check will report phantom missing rows
      // against it.
      //
      // That is the accepted cost of recording provenance instead of moving
      // rows (option (c) over (b) — see TODOS.md). Accepted is not the same as
      // silent, and this is the one moment a person can act on it, so it says
      // so here rather than surfacing later as an unexplained balance gap.
      if (simplefinAccountId) {
        const heldElsewhere = tx
          .select({ accountId: schema.transactions.accountId })
          .from(schema.transactions)
          .where(
            and(
              eq(
                schema.transactions.simplefinSourceAccountId,
                simplefinAccountId,
              ),
              ne(schema.transactions.accountId, localAccountId),
            ),
          )
          .all();

        if (heldElsewhere.length > 0) {
          const n = heldElsewhere.length;
          const otherIds = [...new Set(heldElsewhere.map((r) => r.accountId))];
          const others = tx
            .select({ name: schema.accounts.name })
            .from(schema.accounts)
            .where(inArray(schema.accounts.id, otherIds))
            .all()
            .map((a) => a.name);

          warnings.push(
            `${n} transaction${n === 1 ? "" : "s"} from this feed ${n === 1 ? "is" : "are"} already filed under ${others.join(", ")}. Syncing here will NOT re-import ${n === 1 ? "it" : "them"} — that is the de-dup working — but ${n === 1 ? "it stays" : "they stay"} on the other account, so this account's balance will be short by that amount until you move or re-enter ${n === 1 ? "it" : "them"}.`,
          );
        }
      }
    }

    tx.update(schema.accounts)
      .set({ simplefinAccountId, updatedAt: new Date() })
      .where(eq(schema.accounts.id, localAccountId))
      .run();

    return { warning: warnings.length > 0 ? warnings.join(" ") : null };
  });
}
