import type { ManualRefusalReason } from "@/lib/accounts/manualTransaction";

/**
 * The returned-state shapes for every `/accounts` server action (T28/E20).
 *
 * Deliberately NOT in `actions.ts`: a `"use server"` module may only export
 * async functions, so the `IDLE` sentinels below — plain objects, and real
 * runtime values rather than erased types — make that file fail to compile
 * with `A "use server" file can only export async functions, found object`.
 */
/**
 * `warning` rides on `ok`, never on `error`, and that placement is the point.
 *
 * It carries one fact and one only: the write LANDED but the page behind it
 * could not be refreshed. Modelling it as a third status, or as an `error`
 * with softer copy, would put a committed write back on the failure branch —
 * which is the defect `revalidateBalanceSurfaces` exists to prevent, since a
 * user who reads "failed" resubmits, and a second reconcile spends rule 9's
 * one prior-anchor slot on the value the "failed" attempt already wrote.
 */
export type AccountsActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; warning?: string }
  | { status: "error"; message: string; field?: "balance" | "date" };

export const IDLE: AccountsActionState = { status: "idle" };

/**
 * Carries `reason` so DS56's "Reconcile instead →" appears ONLY for D12's
 * before-anchor refusal — offering it after "enter an amount greater than
 * zero" would be noise.
 */
export type CardActivityState =
  | { status: "idle" }
  | { status: "ok"; message: string; warning?: string }
  | { status: "error"; message: string; reason?: ManualRefusalReason };

export const IDLE_ACTIVITY: CardActivityState = { status: "idle" };
