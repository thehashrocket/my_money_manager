import path from "node:path";
import { and, eq, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import {
  createSnapshot,
  pruneSnapshots,
  type SnapshotResult,
} from "../snapshot";
import { readAccessUrl } from "./accessUrl";
import { fetchAccounts } from "./client";
import { contentSignature, mapTransaction, type MappedRow } from "./mapTransaction";
import { matchTransfers, type AmbiguousBucket } from "./matchTransfers";
import { parseAmountToCents } from "./parseAmount";
import type { SimpleFinAccount } from "./types";

type Db = typeof defaultDb;

const DB_PATH = path.join(process.cwd(), "data", "money.db");

/**
 * SimpleFIN hard-caps the window at 90 days. That cap is corroborated directly by
 * the feed, which returns the error string "Requested date range exceeds limit of
 * 90 days and was capped." when you ask for more.
 *
 * 45 is OUR conservative choice, not a documented provider limit — halving the
 * cap leaves headroom if the provider tightens it, and nothing here depends on
 * the exact number. Do not restate it elsewhere as a quoted SimpleFIN rule.
 *
 * This only bounds a FIRST sync — steady state asks for about a week. Anything
 * older than the window has to come from a CSV import; the feed cannot reach it.
 */
const MAX_LOOKBACK_DAYS = 45;
/** Re-ask for a few days already seen, so rows that post late are not missed. */
const OVERLAP_DAYS = 7;
const DAY_SECONDS = 86_400;
/** Pulling up to 45 days of rows is slower than a balance check, but bounded. */
const SYNC_TIMEOUT_MS = 60_000;

/**
 * What is known about an account before the ledger is re-read.
 *
 * Split from AccountSyncSummary because the balance figures cannot be computed
 * until after the write. Previously both lived on one type and the balance
 * fields were seeded with `computedBalanceCents: 0` and patched in place, which
 * made an un-finalised summary indistinguishable from a correctly-computed zero
 * balance — and left any account finaliseBalances skipped silently rendering a
 * fabricated 0 in the UI.
 */
export type AccountSyncCounts = {
  accountId: number;
  name: string;
  insertedCount: number;
  /** Already had this exact SimpleFIN id — a re-sync of the same rows. */
  duplicateByExternalId: number;
  /** Already had this row from a CSV import, matched on content. */
  duplicateByContent: number;
  /**
   * Pending rows the feed returned and sync refused to write. Should always be
   * 0 — see the skip in the row loop for why writing them would double-count.
   */
  skippedPending: number;
  reportedBalanceCents: number | null;
  availableBalanceCents: number | null;
  balanceDate: string | null;
};

export type AccountSyncSummary = AccountSyncCounts & {
  computedBalanceCents: number;
  /**
   * computed − reported. Non-zero means the ledger has drifted from the bank.
   * NULL means only one thing now: the bank reported no balance.
   */
  driftCents: number | null;
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
  /** Carries a bank transaction number, so the CSV ±1 matcher already saw it. */
  adjudicatedByTxnNumber: boolean;
};

function isoDaysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * DAY_SECONDS * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Starts a week before the OLDEST of the per-account newest rows — not the
 * newest overall. Taking the oldest means an account that has lagged behind
 * still gets its gap re-fetched rather than being skipped past. The overlap
 * covers rows that post a few days late.
 *
 * The alternative, re-fetching the full 45-day window every time, is avoided for
 * bandwidth rather than for correctness: re-sent rows all carry an external_id
 * and would be caught by the cheap `seenExternalIds` set, never by content
 * dedup, which only ever applies to CSV rows.
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
  const counts: AccountSyncCounts[] = [];

  for (const account of linked) {
    const remote = byExternalId.get(account.simplefinAccountId!);
    if (!remote) {
      warnings.push(
        `SimpleFIN returned nothing for "${account.name}" — the connection may need re-authorising.`,
      );
    }

    // Deliberately NOT bounded by date. The partial unique index on
    // (account_id, external_id) is not bounded either, so any window here that
    // is narrower than the set of rows the feed can return leaves a gap where a
    // row escapes the in-memory check and hits the constraint instead — which
    // aborts the whole batch with a raw SqliteError. A feed row's date comes
    // from `posted`, but postedToIsoDate falls back to `transacted_at`, so a
    // derived date can legitimately precede startIso. Matching the index
    // exactly is cheap: external_id is indexed and NULL for every CSV row.
    const seenExternalIds = new Set(
      db
        .select({ externalId: schema.transactions.externalId })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.accountId, account.id),
            isNotNull(schema.transactions.externalId),
          ),
        )
        .all()
        .map((r) => r.externalId)
        .filter((v): v is string => !!v),
    );

    // Content dedup only has to cover what the feed can actually send, which the
    // 45-day cap bounds — so this uses the lookback floor rather than startIso.
    // Bounding it at startIso let a feed row dated before the window content-match
    // nothing and insert a duplicate of an older CSV row.
    const contentFloorIso = isoDaysAgo(MAX_LOOKBACK_DAYS, now);
    const existingByContent = db
      .select({
        date: schema.transactions.date,
        amountCents: schema.transactions.amountCents,
        rawMemo: schema.transactions.rawMemo,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, account.id),
          // Rows with an external_id came from a sync and are caught above; only
          // CSV rows can collide by content.
          isNull(schema.transactions.externalId),
          gte(schema.transactions.date, contentFloorIso),
        ),
      )
      .all();

    // A repeated signature is a real repeat (two identical coffees), so this
    // counts rather than sets.
    const contentBudget = new Map<string, number>();
    for (const r of existingByContent) {
      const sig = contentSignature(r);
      contentBudget.set(sig, (contentBudget.get(sig) ?? 0) + 1);
    }

    let duplicateByExternalId = 0;
    let duplicateByContent = 0;
    let skippedPending = 0;
    const toInsert: MappedRow[] = [];

    for (const txn of remote?.transactions ?? []) {
      const row = mapTransaction(txn);

      // Enforce the invariant the design already depends on rather than
      // assuming it. Sync never asks for pending rows, and Star One returns
      // none today — but that is an observation about one institution at one
      // time, not a guarantee. If one ever arrives, writing it is the worst
      // outcome available: dedup keys on external_id, SimpleFIN may change that
      // id when the row posts, and there is no update path — so the pre-auth
      // amount would be frozen forever AND the posted row inserted alongside it.
      // Skipping costs nothing: the row simply arrives on the next sync once it
      // has posted, which is exactly the behaviour we want.
      if (row.isPending) {
        skippedPending++;
        continue;
      }

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

    if (skippedPending > 0) {
      warnings.push(
        `Skipped ${skippedPending} pending transaction${
          skippedPending === 1 ? "" : "s"
        } on "${account.name}" — they will import once the bank posts them.`,
      );
    }

    staged.push({ account, rows: toInsert });

    const reported = remote?.balance ? parseAmountToCents(remote.balance) : null;
    const available = remote?.["available-balance"]
      ? parseAmountToCents(remote["available-balance"]!)
      : null;
    counts.push({
      accountId: account.id,
      name: account.name,
      insertedCount: toInsert.length,
      duplicateByExternalId,
      duplicateByContent,
      skippedPending,
      reportedBalanceCents: reported,
      availableBalanceCents: available,
      balanceDate: remote?.["balance-date"]
        ? new Date(remote["balance-date"]! * 1000).toISOString()
        : null,
    });
  }

  const totalToInsert = staged.reduce((n, s) => n + s.rows.length, 0);

  if (totalToInsert === 0) {
    const finalised = finaliseBalances(counts, db);
    warnings.push(...missingAccountWarnings(finalised.missingAccounts));
    return { status: "up-to-date", accounts: finalised.summaries, warnings };
  }

  // ---- write ----
  const snapshot = createSnapshot(DB_PATH);
  let snapshotWarning: string | null = null;
  if (!snapshot.consistent) {
    snapshotWarning = `The pre-sync snapshot fell back to a plain file copy${
      snapshot.degradedReason ? ` (${snapshot.degradedReason})` : ""
    } — it may be missing the most recent writes. Undo for this batch still works.`;
    warnings.push(snapshotWarning);
  }

  const batchId = db.transaction((tx) => {
    const [batch] = tx
      .insert(schema.importBatches)
      .values({
        source: "simplefin",
        filename: `simplefin ${now.toISOString().slice(0, 16).replace("T", " ")}Z`,
        snapshotPath: snapshot.snapshotPath,
        snapshotWarning,
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
            // Always false: pending rows are skipped above, so anything that
            // reaches here has posted.
            isPending: false,
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

  // Prune only now that the write has committed, so a failed sync never evicts
  // an older snapshot to make room for a useless one.
  const pruned = pruneSnapshots(path.dirname(DB_PATH));
  if (pruned.failedPaths.length > 0) {
    warnings.push(
      `Could not delete ${pruned.failedPaths.length} old snapshot${
        pruned.failedPaths.length === 1 ? "" : "s"
      } — check the data/ directory's permissions.`,
    );
  }

  const { pairsLinked, ambiguous } = linkTransfersByBucket(startIso, db, batchId);
  const finalised = finaliseBalances(counts, db);
  warnings.push(...missingAccountWarnings(finalised.missingAccounts));

  return {
    status: "synced",
    batchId,
    insertedCount: totalToInsert,
    pairsLinked,
    ambiguous,
    snapshot,
    accounts: finalised.summaries,
    warnings,
  };
}

function missingAccountWarnings(names: string[]): string[] {
  return names.map(
    (n) =>
      `"${n}" disappeared from the ledger while the sync was running, so its balance could not be checked.`,
  );
}

/**
 * Re-reads the ledger and returns finalised summaries. Returns rather than
 * mutating, so it is impossible to hand a caller a summary whose balance was
 * never computed.
 *
 * Balance is `starting_balance_cents + SUM(amount_cents WHERE date >
 * starting_balance_date)` per CLAUDE.md rule 1 — strictly greater than, so a row
 * dated exactly on the starting balance date is already counted in it.
 */
function finaliseBalances(
  counts: AccountSyncCounts[],
  db: Db,
): { summaries: AccountSyncSummary[]; missingAccounts: string[] } {
  const summaries: AccountSyncSummary[] = [];
  const missingAccounts: string[] = [];

  for (const c of counts) {
    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, c.accountId))
      .get();

    if (!account) {
      // Was silently skipped before, leaving a fabricated 0 balance on display.
      missingAccounts.push(c.name);
      continue;
    }

    const row = db
      .select({
        delta: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, c.accountId),
          sql`${schema.transactions.date} > ${account.startingBalanceDate}`,
        ),
      )
      .get();

    const computedBalanceCents = account.startingBalanceCents + (row?.delta ?? 0);
    summaries.push({
      ...c,
      computedBalanceCents,
      driftCents:
        c.reportedBalanceCents === null
          ? null
          : computedBalanceCents - c.reportedBalanceCents,
    });
  }

  return { summaries, missingAccounts };
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
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all()
    .map((r) => ({
      ...r,
      adjudicatedByTxnNumber: r.bankTransactionNumber !== null,
    }));

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
 * Clears BOTH sides of a transfer pair.
 *
 * Every other writer of `transfer_pair_id` only ever assigns a partner. Without
 * this there is no path in the app that sets it back to NULL, so a wrong link —
 * whether auto-linked by the counting argument or picked by hand in the review
 * UI — could only be undone by restoring a snapshot or undoing the whole batch,
 * and the latter only works until the next sync becomes the newest batch. Since
 * a paired row is excluded from every spending surface (budget, trends, goals,
 * categorize, subscriptions), a wrong link silently removes real money from the
 * budget with no way back.
 *
 * Both legs are cleared in one transaction: leaving one side pointing at a row
 * that no longer points back is exactly the dangling state that
 * `linkTransferPairManually` refuses to create.
 */
export function unlinkTransferPair(id: number, db: Db = defaultDb): void {
  const row = db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id))
    .get();

  if (!row) throw new Error(`No such transaction: ${id}`);
  // Idempotent: a double-submit or a stale tab should be a no-op, not an error.
  if (row.transferPairId === null) return;

  const partnerId = row.transferPairId;
  db.transaction((tx) => {
    tx.update(schema.transactions)
      .set({ transferPairId: null })
      .where(inArray(schema.transactions.id, [id, partnerId]))
      .run();
  });
}

export type LinkedTransferPair = { a: TransferRow; b: TransferRow };

/**
 * Linked pairs on or after `sinceIso`, so the sync screen can show what was
 * auto-linked and offer to undo it. Emits each pair once (keyed on the lower
 * id) and skips half-links, which should not exist but must not crash the page
 * if they somehow do.
 */
export function findLinkedTransferPairs(
  sinceIso: string,
  db: Db = defaultDb,
): LinkedTransferPair[] {
  const rows = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
      transferPairId: schema.transactions.transferPairId,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNotNull(schema.transactions.transferPairId),
      ),
    )
    .all();

  const byId = new Map(
    rows.map((r) => [
      r.id,
      { ...r, adjudicatedByTxnNumber: r.bankTransactionNumber !== null },
    ]),
  );
  const pairs: LinkedTransferPair[] = [];
  // Iterate the mapped values, not the raw rows, so both legs carry
  // adjudicatedByTxnNumber.
  for (const row of byId.values()) {
    const partner = byId.get(row.transferPairId!);
    if (!partner || partner.transferPairId !== row.id) continue;
    if (row.id > partner.id) continue;
    const positive = row.amountCents >= 0 ? row : partner;
    const negative = row.amountCents >= 0 ? partner : row;
    pairs.push({ a: positive, b: negative });
  }
  return pairs.sort((x, y) => y.a.date.localeCompare(x.a.date));
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
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all()
    .map((r) => ({
      ...r,
      adjudicatedByTxnNumber: r.bankTransactionNumber !== null,
    }));

  return matchTransfers(unlinked).ambiguous;
}

export type { TransferRow };
