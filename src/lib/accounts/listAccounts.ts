import { db as defaultDb, schema } from "@/db";

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
 */
export function listAccounts(db: Db): AccountOption[] {
  const rows = db
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .all();

  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}
