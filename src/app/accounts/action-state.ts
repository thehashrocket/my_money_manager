import type { ManualRefusalReason } from "@/lib/accounts/manualTransaction";

/**
 * The returned-state shapes for every `/accounts` server action (T28/E20).
 *
 * Deliberately NOT in `actions.ts`: a `"use server"` module may only export
 * async functions, so the `IDLE` sentinels below — plain objects, and real
 * runtime values rather than erased types — make that file fail to compile
 * with `A "use server" file can only export async functions, found object`.
 */
export type AccountsActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; field?: "balance" | "date" };

export const IDLE: AccountsActionState = { status: "idle" };

/**
 * Carries `reason` so DS56's "Reconcile instead →" appears ONLY for D12's
 * before-anchor refusal — offering it after "enter an amount greater than
 * zero" would be noise.
 */
export type CardActivityState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; reason?: ManualRefusalReason };

export const IDLE_ACTIVITY: CardActivityState = { status: "idle" };
