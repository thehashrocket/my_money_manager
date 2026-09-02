/**
 * Shape of the SimpleFIN `/accounts` response as Star One CU actually returns
 * it via MX — verified against a live 90-day pull on 2026-09-02.
 *
 * NOTE: `payee`, `memo` and `mcc` are NOT in the published v1 spec but are
 * present on every row. `extra` is documented but absent on 100% of rows, so
 * nothing may depend on it. See .context/simplefin-sample.json.
 */
export type SimpleFinTransaction = {
  id: string;
  /** Unix seconds. Star One posts every row at exactly 12:00:00 UTC. */
  posted: number;
  /** Signed decimal string: positive = deposit, negative = withdrawal. */
  amount: string;
  description: string;
  /** MX-cleaned merchant label ("Save Mart"). Display only — see mapTransaction. */
  payee?: string | null;
  memo?: string | null;
  transacted_at?: number | null;
  pending?: boolean;
  mcc?: string | null;
  extra?: Record<string, unknown> | null;
};

export type SimpleFinAccount = {
  org?: { name?: string | null; domain?: string | null } | null;
  id: string;
  name: string;
  currency?: string;
  /** Decimal string. The institution's own figure, not one we computed. */
  balance: string;
  "available-balance"?: string | null;
  /** Unix seconds. */
  "balance-date"?: number | null;
  transactions?: SimpleFinTransaction[];
};

export type SimpleFinResponse = {
  errors?: string[];
  accounts?: SimpleFinAccount[];
};
