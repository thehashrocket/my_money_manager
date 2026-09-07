import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { accountClass } from "@/lib/accounts/accountClass";

type Db = typeof defaultDb;

export type AssetAccountCheck =
  | { ok: true; name: string }
  | { ok: false; reason: string };

/**
 * Refuses an account id that isn't an asset.
 *
 * E6 — `/import`'s CSV target `<select>` and its anchor-repair form both read
 * `select().from(accounts)` with no type filter, so migration 0018's enum
 * widening silently made a credit card a valid CSV import destination. Two
 * things go wrong there and both are silent:
 *
 *   1. Rows land with checking sign conventions on an account whose signs
 *      mean the opposite thing.
 *   2. `deriveStartingBalance` reads the file's running Balance column and
 *      MOVES THE CARD'S ANCHOR onto another account's balance chain. That
 *      move is forward-only (CLAUDE.md rule 1), so it cannot be undone by
 *      re-importing — only by a manual reconcile, if you notice at all.
 *
 * E18 — the anchor-repair form on the same page is a raw signed twin of
 * `/accounts`' Reconcile: it would offer the Visa an unlabelled, un-negated
 * balance field forty lines below the create form T15 was raised to P1 to
 * fix. Liabilities get exactly one anchor surface, and it is `/accounts`.
 *
 * Filtering the two pickers is the visible half; this is the half that holds.
 * A stale tab rendered before the card existed still posts, and a Server
 * Action is a network-reachable endpoint regardless of what the UI offered.
 */
export function checkAssetAccount(accountId: number, db: Db = defaultDb): AssetAccountCheck {
  const account = db
    .select({ name: schema.accounts.name, type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!account) return { ok: false, reason: `Account ${accountId} not found` };
  if (accountClass(account.type) === "liability") {
    return {
      ok: false,
      // DS61 register: states the consequence and names the recovery, without
      // naming a schema concept.
      reason: `${account.name} is a credit card or loan. Import a CSV into a checking or savings account instead; update a card or loan balance from the Accounts page.`,
    };
  }
  return { ok: true, name: account.name };
}
