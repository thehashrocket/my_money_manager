import { formatMonthDay, toLocalIso, todayIso } from "@/lib/now";
import type { BalanceSource } from "./resolveBalanceAction";

export type StalenessDisplay = {
  /** The full label, per the DS61 copy deck. */
  label: string;
  /** True past this source's threshold — render amber. */
  isStale: boolean;
  /** The date the label is about, `YYYY-MM-DD`. */
  asOfIso: string;
  /** Whole days between `asOfIso` and today. Never negative. */
  ageDays: number;
};

/**
 * DS57 — two thresholds, chosen by which path last moved the balance.
 *
 *   feed    7 days  — a live feed that stopped moving is broken. CLAUDE.md
 *                     rule 1 documents the measured case: a frozen SimpleFIN
 *                     balance reading as +$893.84 of phantom drift.
 *   manual  35 days — a hand-reconciled card is expected to be monthly. 35
 *                     rather than 30 gives a normal cadence a week of slack,
 *                     so amber keeps meaning "attention needed" rather than
 *                     "time has passed".
 *
 * This is deliberately NOT `classifyBalanceFreshness`
 * (`src/lib/simplefin/balanceFreshness.ts`), despite the near-identical name
 * the plan originally gave it (E11). That function compares the bank's date
 * against the LEDGER's date to decide whether a difference is real drift or
 * just activity the feed hasn't reported. This one compares one date against
 * TODAY to decide whether to paint a label amber. Different inputs, different
 * question, no shared code — and two near-homonyms in one codebase is a
 * wrong-import that would typecheck.
 *
 * `balanceAsOf ?? startingBalanceDate` is the fallback that makes this work
 * for cards at all: D10 path 3 sets `balance_as_of = NULL` on every manual
 * reconcile, and cards are manual-only by D15, so a rule reading only
 * `balance_as_of` would be permanently blank on exactly the accounts it
 * exists for.
 */
export const FEED_STALE_AFTER_DAYS = 7;
export const MANUAL_STALE_AFTER_DAYS = 35;

/** Whole days from `iso` to `todayIso`, floored at zero. */
function daysBetween(iso: string, today: string): number {
  const [ay, am, ad] = iso.split("-").map(Number);
  const [by, bm, bd] = today.split("-").map(Number);
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function resolveStalenessDisplay(
  account: {
    balanceAsOf: Date | null;
    startingBalanceDate: string;
    balanceSource: BalanceSource | null;
  },
  now: Date = new Date(),
): StalenessDisplay {
  // toLocalIso, not .toISOString(): balance_as_of is a timestamp and every
  // date this app compares is a local YYYY-MM-DD (src/lib/now.ts). Reading it
  // back as UTC would slip a day for part of every evening west of Greenwich.
  const asOfIso = account.balanceAsOf
    ? toLocalIso(account.balanceAsOf)
    : account.startingBalanceDate;

  // A NULL balance_source is only reachable on a row written before migration
  // 0018 or by a direct SQL edit; treat it as manual, which is both the
  // forgiving threshold and what account creation now always sets (E4).
  const source: BalanceSource = account.balanceSource ?? "manual";
  const ageDays = daysBetween(asOfIso, todayIso(now));
  const threshold = source === "feed" ? FEED_STALE_AFTER_DAYS : MANUAL_STALE_AFTER_DAYS;
  const isStale = ageDays >= threshold;

  const verb = source === "feed" ? "as of" : "reconciled";
  const suffix = source === "feed" ? "days old" : "days ago";
  const label = isStale
    ? `${verb} ${formatMonthDay(asOfIso)} · ${ageDays} ${suffix}`
    : `${verb} ${formatMonthDay(asOfIso)}`;

  return { label, isStale, asOfIso, ageDays };
}
