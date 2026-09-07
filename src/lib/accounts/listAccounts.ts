import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { isLongTermLiability } from "./isLongTermLiability";

type Db = typeof defaultDb;

export type AccountOption = {
  id: number;
  name: string;
};

/**
 * `{id, name}` list for a picker (the `/transactions` account filter).
 * Deliberately not `loadAccountBalances` — that function runs a per-account
 * balance aggregate query for the accounts page, which a filter dropdown has
 * no use for and shouldn't be coupled to. Mirrors `listLeafCategories`'s
 * shape, the same pattern already used for this page's category picker.
 *
 * E15 — this had no type filter, so migration 0018's enum widening changed
 * what it returns without anyone editing it. A credit card appearing here is
 * good and was unplanned: cards carry manually-entered charges, so filtering
 * `/transactions` by one is genuinely useful. A mortgage appearing here is a
 * permanently empty option — D3=A says it never gets a transaction row, and
 * that is now enforced on all three write paths (E1 sync, E6 CSV, E17
 * manual), so selecting it can only ever produce "no transactions found".
 * Filtering it out is not cosmetic: a filter that always returns nothing
 * teaches the user that the filter is broken.
 */
export function listAccounts(db: Db): AccountOption[] {
  const rows = db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      type: schema.accounts.type,
    })
    .from(schema.accounts)
    .all();

  return rows
    .filter((r) => !isLongTermLiability(r.type))
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Credit cards only, for DS52's "Mark as payment to →" row menu.
 *
 * Not `accountClass(type) === "liability"`: a mortgage is a valid liability
 * and an invalid payment target. `manualTransaction` rejects a loan at its
 * shared entry regardless (E17) — this is the half that never offers one, so
 * the refusal stays a guard rather than a thing users trip over.
 */
export function listCardAccounts(db: Db): AccountOption[] {
  return db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(eq(schema.accounts.type, "credit"))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
}
