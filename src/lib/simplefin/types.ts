import { z } from "zod";

/**
 * Shape of the SimpleFIN `/accounts` response as Star One CU actually returns
 * it via MX — verified against a live 90-day pull on 2026-09-02.
 *
 * NOTE: `payee`, `memo` and `mcc` are NOT in the published v1 spec but are
 * present on every row. `extra` is documented but absent on 100% of rows, so
 * nothing may depend on it. See .context/simplefin-sample.json.
 *
 * These are zod schemas rather than hand-written types because this is the only
 * untrusted input in the app: a third-party aggregator's JSON, reverse
 * engineered from one live pull, feeding straight into the money path. A bare
 * `as SimpleFinResponse` cast would let a shape change through as `undefined`
 * fields — and the downstream `?? []` fallbacks would then turn that into a
 * cheerful "Already up to date" while importing nothing.
 *
 * Every object is `loose` (unknown keys pass through untouched) so that MX
 * adding a field is never a hard sync failure.
 */
export const simpleFinTransactionSchema = z.looseObject({
  id: z.string().min(1),
  /** Unix seconds. Star One posts every row at exactly 12:00:00 UTC. */
  posted: z.number(),
  /** Signed decimal string: positive = deposit, negative = withdrawal. */
  amount: z.string(),
  description: z.string(),
  /** MX-cleaned merchant label ("Save Mart"). Display only — see mapTransaction. */
  payee: z.string().nullish(),
  memo: z.string().nullish(),
  transacted_at: z.number().nullish(),
  pending: z.boolean().nullish(),
  mcc: z.string().nullish(),
  extra: z.record(z.string(), z.unknown()).nullish(),
});

export const simpleFinAccountSchema = z.looseObject({
  org: z
    .looseObject({ name: z.string().nullish(), domain: z.string().nullish() })
    .nullish(),
  id: z.string().min(1),
  name: z.string(),
  currency: z.string().optional(),
  /** Decimal string. The institution's own figure, not one we computed. */
  balance: z.string(),
  "available-balance": z.string().nullish(),
  /** Unix seconds. */
  "balance-date": z.number().nullish(),
  transactions: z.array(simpleFinTransactionSchema).optional(),
});

export const simpleFinResponseSchema = z.looseObject({
  errors: z.array(z.string()).optional(),
  accounts: z.array(simpleFinAccountSchema).optional(),
});

export type SimpleFinTransaction = z.infer<typeof simpleFinTransactionSchema>;
export type SimpleFinAccount = z.infer<typeof simpleFinAccountSchema>;
export type SimpleFinResponse = z.infer<typeof simpleFinResponseSchema>;
