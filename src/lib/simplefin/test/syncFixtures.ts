import type { TestDbHandle } from "@/lib/test/db";
import * as schema from "@/db/schema";
import type { SimpleFinAccount, SimpleFinTransaction } from "../types";
import type { syncSimpleFin } from "../sync";

/**
 * Shared fixtures for the `syncSimpleFin` suites.
 *
 * What is NOT here, and cannot be: the `vi.hoisted` mock trio and the three
 * `vi.mock` factories. `vi.mock` is hoisted to the top of the FILE that calls
 * it, so a shared module cannot register mocks on a caller's behalf — each
 * suite has to declare its own. That is a vitest constraint, not duplication
 * worth apologising for; `SNAPSHOT_STUB` below at least keeps the one piece of
 * that block with a shape (the `createSnapshot` return) in one place.
 *
 * Everything else moved: the date constants, the seed helpers and the feed
 * builders. `seedAccount` in particular was the 21st hand-copy of a helper
 * CLAUDE.md already tracks as duplicated across 13+ test files, and the two
 * sync suites had drifted apart on it within one branch — one grew liability
 * support and the other did not.
 */

/** Fixed clock. Every suite's `{ now: NOW }` and every feed timestamp derive from it. */
export const NOW = new Date("2026-09-02T17:00:00Z");
/** 2026-09-01T12:00:00Z — Star One's noon-UTC posting convention. */
export const SEP_1_NOON = 1788264000;

/** A real Star One memo, byte-identical in both sync suites. */
export const COFFEE_MEMO = "STARBUCKS STORE 1234 MANTECA CA";

/** The `createSnapshot` stub's return value, matching `SnapshotResult`. */
export const SNAPSHOT_STUB = {
  snapshotPath: "/tmp/money.db.pre-import-TEST",
  timestamp: "TEST",
  prunedPaths: [] as string[],
  consistent: true,
  degradedReason: null as string | null,
};

let seq = 0;
/** Reset between suites so account names stay stable per test file. */
export function resetFixtureSeq(): void {
  seq = 0;
}

export function seedAccount(
  handle: TestDbHandle,
  opts: {
    simplefinAccountId?: string | null;
    name?: string;
    type?: "checking" | "savings" | "credit" | "loan";
    startingBalanceCents?: number;
    startingBalanceDate?: string;
  } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: opts.name ?? `Checking-${seq}`,
      type: opts.type ?? "checking",
      startingBalanceCents: opts.startingBalanceCents ?? 0,
      startingBalanceDate: opts.startingBalanceDate ?? "2026-01-01",
      simplefinAccountId: opts.simplefinAccountId ?? null,
    })
    .returning()
    .all();
  return row;
}

export function feedTxn(id: string, amount: string, memo = COFFEE_MEMO): SimpleFinTransaction {
  return {
    id,
    posted: SEP_1_NOON,
    amount,
    description: memo,
    memo,
    payee: "Starbucks",
    transacted_at: SEP_1_NOON,
    mcc: null,
  };
}

/** One feed account, with the balance fields every response needs. */
export function feedAccount(opts: {
  id: string;
  transactions?: SimpleFinTransaction[];
  balance?: string;
  name?: string;
}): SimpleFinAccount {
  const balance = opts.balance ?? "0.00";
  return {
    id: opts.id,
    name: opts.name ?? "REGULAR SAVINGS",
    balance,
    "available-balance": balance,
    "balance-date": SEP_1_NOON,
    transactions: opts.transactions ?? [],
  } as SimpleFinAccount;
}

type Outcome = Awaited<ReturnType<typeof syncSimpleFin>>;

/** Narrows away `no-linked-accounts`, which carries no warnings field. */
export function warningsOf(outcome: Outcome): string[] {
  return outcome.status === "no-linked-accounts" ? [] : outcome.warnings;
}

export function syncedOrThrow(outcome: Outcome) {
  if (outcome.status !== "synced") throw new Error(`expected synced, got ${outcome.status}`);
  return outcome;
}

/**
 * The all-dropped shape: nothing survived the link re-check, so the write
 * transaction rolled back and no batch exists.
 */
export function droppedOrThrow(outcome: Outcome) {
  if (outcome.status !== "up-to-date") {
    throw new Error(`expected up-to-date (all dropped), got ${outcome.status}`);
  }
  return outcome;
}
