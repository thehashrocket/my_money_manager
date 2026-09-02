import path from "node:path";
import { and, eq, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { createSnapshot, type SnapshotResult } from "../snapshot";
import { readAccessUrl } from "./accessUrl";
import { fetchAccounts } from "./client";
import { contentSignature, mapTransaction, type MappedRow } from "./mapTransaction";
import { matchTransfers, type AmbiguousBucket } from "./matchTransfers";
import { parseAmountToCents } from "./parseAmount";
import type { SimpleFinAccount } from "./types";

type Db = typeof defaultDb;

const DB_PATH = path.join(process.cwd(), "data", "money.db");

/**
 * SimpleFIN hard-caps the window at 90 days but warns that anything over 45 is
 * "outside the recommended range" and "may be capped" in future, so stay at 45.
 * This only bounds a FIRST sync — steady state asks for about a week. Anything
 * older than the window has to come from a CSV import; the feed cannot reach it.
 */
const MAX_LOOKBACK_DAYS = 45;
/** Re-ask for a few days already seen, so rows that post late are not missed. */
const OVERLAP_DAYS = 7;
const DAY_SECONDS = 86_400;
/** Pulling up to 45 days of rows is slower than a balance check, but bounded. */
const SYNC_TIMEOUT_MS = 60_000;

export type AccountSyncSummary = {
  accountId: number;
  name: string;
  insertedCount: number;
  /** Already had this exact SimpleFIN id — a re-sync of the same rows. */
  duplicateByExternalId: number;
  /** Already had this row from a CSV import, matched on content. */
  duplicateByContent: number;
  reportedBalanceCents: number | null;
  availableBalanceCents: number | null;
  computedBalanceCents: number;
  /** computed − reported. Non-zero means the ledger has drifted from the bank. */
  driftCents: number | null;
  balanceDate: string | null;
};

export type SyncOutcome =
  | { status: "no-linked-accounts" }
  | {
      status: "up-to-date";
      accounts: AccountSyncSummary[];
      warnings: string[];
    }
  | {
      status: "synced";
      batchId: number;
      insertedCount: number;
      pairsLinked: number;
      ambiguous: AmbiguousBucket<TransferRow>[];
      snapshot: SnapshotResult;
      accounts: AccountSyncSummary[];
      warnings: string[];
    };

type TransferRow = {
  id: number;
  accountId: number;
  date: string;
  amountCents: number;
  rawMemo: string;
};

function isoDaysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * DAY_SECONDS * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Start from just before the newest row we already hold, not from a fixed
 * window — re-fetching the whole lookback window on every sync would be
 * wasteful and would lean hard on content dedup. The overlap covers rows that
 * post a few days late.
 */
export function resolveStartDate(
  latestDates: (string | null)[],
  now: Date = new Date(),
): { startIso: string; startUnix: number } {
  const floorIso = isoDaysAgo(MAX_LOOKBACK_DAYS, now);
  const known = latestDates.filter((d): d is string => !!d);

  let startIso: string;
  if (known.length === 0 || known.length !== latestDates.length) {
    // A linked account with no history at all — take the whole window.
    startIso = floorIso;
  } else {
    const oldestLatest = known.sort()[0];
    const withOverlap = new Date(`${oldestLatest}T00:00:00Z`);
    withOverlap.setUTCDate(withOverlap.getUTCDate() - OVERLAP_DAYS);
    let candidate = withOverlap.toISOString().slice(0, 10);
    // A single future-dated row (a CSV typo, or a feed timestamp ahead of local
    // time) would otherwise push the window past today, so the feed returns
    // nothing and every later sync reports "up to date" while importing nothing.
    const todayIso = now.toISOString().slice(0, 10);
    if (candidate > todayIso) candidate = todayIso;
    startIso = candidate < floorIso ? floorIso : candidate;
  }

  return {
    startIso,
    startUnix: Math.floor(new Date(`${startIso}T00:00:00Z`).getTime() / 1000),
  };
}

/**
 * Fetch, dedup, insert, link transfers. Writes straight to the DB (no preview
 * step) but takes a pre-write snapshot first per CLAUDE.md rule 5, and every
 * batch is reversible via undoSync().
 *
 * Deliberately does NOT request `pending=1`: Star One exposes no pending rows
 * anyway, and pending rows mutate when they post, which this insert-or-skip
 * model has no update path for. Pending activity is still visible as the gap
 * between reported balance and available balance.
 */
export async function syncSimpleFin(
  opts: { now?: Date; signal?: AbortSignal } = {},
  db: Db = defaultDb,
): Promise<SyncOutcome> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  const linked = db
    .select()
    .from(schema.accounts)
    .where(isNotNull(schema.accounts.simplefinAccountId))
    .all();

  if (linked.length === 0) return { status: "no-linked-accounts" };

  const latestDates = linked.map((a) => {
    const row = db
      .select({ max: sql<string | null>`MAX(${schema.transactions.date})` })
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, a.id))
      .get();
    return row?.max ?? null;
  });

  const { startIso, startUnix } = resolveStartDate(latestDates, now);

  const creds = readAccessUrl();
  const response = await fetchAccounts(creds, {
    startDate: startUnix,
    accountIds: linked.map((a) => a.simplefinAccountId!),
    // A user-supplied signal wins; otherwise fall back to a deadline so a
    // stalled bridge cannot hang the sync indefinitely.
    signal: opts.signal ?? AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });

  for (const err of response.errors ?? []) warnings.push(err);

  const byExternalId = new Map<string, SimpleFinAccount>();
  for (const a of response.accounts ?? []) byExternalId.set(a.id, a);

  // ---- dedup, per account ----
  type Staged = { account: (typeof linked)[number]; rows: MappedRow[] };
  const staged: Staged[] = [];
  const summaries: AccountSyncSummary[] = [];

  for (const account of linked) {
    const remote = byExternalId.get(account.simplefinAccountId!);
    if (!remote) {
      warnings.push(
        `SimpleFIN returned nothing for "${account.name}" — the connection may need re-authorising.`,
      );
    }

    const existing = db
      .select({
        externalId: schema.transactions.externalId,
        date: schema.transactions.date,
        amountCents: schema.transactions.amountCents,
        rawMemo: schema.transactions.rawMemo,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, account.id),
          gte(schema.transactions.date, startIso),
        ),
      )
      .all();

    const seenExternalIds = new Set(
      existing.map((r) => r.externalId).filter((v): v is string => !!v),
    );
    // Rows without an external_id came from CSV. They are the only ones that
    // can collide by content, and a repeated signature is a real repeat (two
    // identical coffees), so this counts rather than sets.
    const contentBudget = new Map<string, number>();
    for (const r of existing) {
      if (r.externalId) continue;
      const sig = contentSignature(r);
      contentBudget.set(sig, (contentBudget.get(sig) ?? 0) + 1);
    }

    let duplicateByExternalId = 0;
    let duplicateByContent = 0;
    const toInsert: MappedRow[] = [];

    for (const txn of remote?.transactions ?? []) {
      const row = mapTransaction(txn);
      if (seenExternalIds.has(row.externalId)) {
        duplicateByExternalId++;
        continue;
      }
      seenExternalIds.add(row.externalId);

      const sig = contentSignature(row);
      const budget = contentBudget.get(sig) ?? 0;
      if (budget > 0) {
        contentBudget.set(sig, budget - 1);
        duplicateByContent++;
        continue;
      }
      toInsert.push(row);
    }

    staged.push({ account, rows: toInsert });

    const reported = remote?.balance ? parseAmountToCents(remote.balance) : null;
    const available = remote?.["available-balance"]
      ? parseAmountToCents(remote["available-balance"]!)
      : null;
    summaries.push({
      accountId: account.id,
      name: account.name,
      insertedCount: toInsert.length,
      duplicateByExternalId,
      duplicateByContent,
      reportedBalanceCents: reported,
      availableBalanceCents: available,
      computedBalanceCents: 0, // filled in after the write
      driftCents: null,
      balanceDate: remote?.["balance-date"]
        ? new Date(remote["balance-date"]! * 1000).toISOString()
        : null,
    });
  }

  const totalToInsert = staged.reduce((n, s) => n + s.rows.length, 0);

  if (totalToInsert === 0) {
    finaliseBalances(summaries, db);
    return { status: "up-to-date", accounts: summaries, warnings };
  }

  // ---- write ----
  const snapshot = createSnapshot(DB_PATH);

  const batchId = db.transaction((tx) => {
    const [batch] = tx
      .insert(schema.importBatches)
      .values({
        source: "simplefin",
        filename: `simplefin ${now.toISOString().slice(0, 16).replace("T", " ")}Z`,
        snapshotPath: snapshot.snapshotPath,
        transactionCount: 0,
      })
      .returning({ id: schema.importBatches.id })
      .all();

    for (const { account, rows } of staged) {
      for (const row of rows) {
        tx.insert(schema.transactions)
          .values({
            accountId: account.id,
            date: row.date,
            rawDescription: row.rawDescription,
            rawMemo: row.rawMemo,
            normalizedMerchant: row.normalizedMerchant,
            payee: row.payee,
            amountCents: row.amountCents,
            bankTransactionNumber: null,
            cardLastFour: row.cardLastFour,
            importSource: "simplefin",
            importBatchId: batch.id,
            importRowHash: row.importRowHash,
            externalId: row.externalId,
            isPending: row.isPending,
          })
          .run();
      }
    }

    tx.update(schema.importBatches)
      .set({ transactionCount: totalToInsert })
      .where(eq(schema.importBatches.id, batch.id))
      .run();

    return batch.id;
  });

  const { pairsLinked, ambiguous } = linkTransfersByBucket(startIso, db, batchId);
  finaliseBalances(summaries, db);

  return {
    status: "synced",
    batchId,
    insertedCount: totalToInsert,
    pairsLinked,
    ambiguous,
    snapshot,
    accounts: summaries,
    warnings,
  };
}

function finaliseBalances(summaries: AccountSyncSummary[], db: Db): void {
  for (const s of summaries) {
    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, s.accountId))
      .get();
    if (!account) continue;

    const row = db
      .select({
        delta: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, s.accountId),
          sql`${schema.transactions.date} > ${account.startingBalanceDate}`,
        ),
      )
      .get();

    s.computedBalanceCents = account.startingBalanceCents + (row?.delta ?? 0);
    s.driftCents =
      s.reportedBalanceCents === null
        ? null
        : s.computedBalanceCents - s.reportedBalanceCents;
  }
}

/**
 * Links unpaired rows on or after `sinceIso` across ALL accounts — not just the
 * rows this batch inserted — so a SimpleFIN row can still pair with a CSV row
 * imported earlier.
 */
export function linkTransfersByBucket(
  sinceIso: string,
  db: Db = defaultDb,
  batchId?: number,
): { pairsLinked: number; ambiguous: AmbiguousBucket<TransferRow>[] } {
  const unlinked: TransferRow[] = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all();

  const { pairs: allPairs, ambiguous } = matchTransfers(unlinked);

  // Only persist a pair that involves at least one row from THIS batch.
  // matchTransfers sees every unlinked row in the window, so it can legitimately
  // pair two rows that both predate this sync — but undoSyncBatch deletes only
  // this batch's rows and relies on ON DELETE SET NULL to unlink survivors, so
  // such a pair would outlive the undo with no way to clear it.
  const batchRowIds = batchId
    ? new Set(
        db
          .select({ id: schema.transactions.id })
          .from(schema.transactions)
          .where(eq(schema.transactions.importBatchId, batchId))
          .all()
          .map((r) => r.id),
      )
    : null;
  const pairs = batchRowIds
    ? allPairs.filter((p) => batchRowIds.has(p.a.id) || batchRowIds.has(p.b.id))
    : allPairs;

  // One transaction, not two auto-commits per pair. Both for atomicity (a
  // failure mid-loop must not leave half-linked rows) and because each bare
  // .run() is a separate WAL commit with its own fsync on a synchronous driver
  // that blocks the event loop.
  if (pairs.length > 0) {
    db.transaction((tx) => {
      for (const { a, b } of pairs) {
        tx.update(schema.transactions)
          .set({ transferPairId: b.id })
          .where(eq(schema.transactions.id, a.id))
          .run();
        tx.update(schema.transactions)
          .set({ transferPairId: a.id })
          .where(eq(schema.transactions.id, b.id))
          .run();
      }
    });
  }

  return { pairsLinked: pairs.length, ambiguous };
}

/** Manually pair two rows the bucket matcher could not decide between. */
export function linkTransferPairManually(
  aId: number,
  bId: number,
  db: Db = defaultDb,
): void {
  const rows = db
    .select()
    .from(schema.transactions)
    .where(inArray(schema.transactions.id, [aId, bId]))
    .all();

  if (rows.length !== 2) throw new Error("Both transactions must exist.");
  const [a, b] = rows;
  if (a.accountId === b.accountId) {
    throw new Error("A transfer pair must span two different accounts.");
  }
  if (Math.sign(a.amountCents) === Math.sign(b.amountCents)) {
    throw new Error("A transfer pair must have opposite signs.");
  }
  if (Math.abs(a.amountCents) !== Math.abs(b.amountCents)) {
    throw new Error("A transfer pair must have equal absolute amounts.");
  }
  // Re-pairing a row that already has a partner would overwrite this side of
  // the link while the old partner keeps pointing back, leaving a dangling
  // one-way reference. Reachable from a stale /sync tab resolving a bucket that
  // another tab already resolved.
  if (a.transferPairId !== null || b.transferPairId !== null) {
    throw new Error(
      "One of these transactions is already paired — reload the page to see the current state.",
    );
  }

  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ transferPairId: b.id })
      .where(eq(schema.transactions.id, a.id))
      .run();
    tx.update(schema.transactions)
      .set({ transferPairId: a.id })
      .where(eq(schema.transactions.id, b.id))
      .run();
  });
}

/**
 * Re-derives the undecidable buckets from whatever is currently unpaired.
 * Deliberately stateless — there is no "needs review" flag to keep in sync with
 * reality, so resolving a pair anywhere simply makes it stop showing up here.
 */
export function findAmbiguousTransfers(
  sinceIso: string,
  db: Db = defaultDb,
): AmbiguousBucket<TransferRow>[] {
  const unlinked: TransferRow[] = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all();

  return matchTransfers(unlinked).ambiguous;
}

export type { TransferRow };
