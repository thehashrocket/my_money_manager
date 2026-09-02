import { eq } from "drizzle-orm";
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
    // undici imposes no request timeout, and this runs inside the /sync render.
    // Without a deadline a stalled bridge hangs the page instead of falling
    // through to the error banner.
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

export function setAccountLink(
  localAccountId: number,
  simplefinAccountId: string | null,
  db: Db = defaultDb,
): void {
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

  db.update(schema.accounts)
    .set({ simplefinAccountId, updatedAt: new Date() })
    .where(eq(schema.accounts.id, localAccountId))
    .run();
}
