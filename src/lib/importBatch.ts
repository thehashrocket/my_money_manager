import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";
import { parseStarOneCsv, type ParsedRow, type ParseError } from "./parseCsv";
import { normalizeMerchant, extractCardLastFour } from "./normalize";
import { computeImportRowHash } from "./hash";
import { contentSignature } from "./contentSignature";
import { buildRuleMatcher } from "./rules";
import {
  deriveStartingBalance,
  STARTING_BALANCE_DERIVATION_MESSAGES,
} from "./accounts/deriveStartingBalance";
import {
  isStartingBalanceCentsInBounds,
  startingBalanceDateSchema,
} from "./import/accountAnchorFields";
import { formatCents } from "./money";
import { todayIso } from "./now";
import { findTransferPairs, type PairCandidate } from "./transferPair";
import { createSnapshot, pruneSnapshots, type SnapshotResult } from "./snapshot";
import { dbPath, snapshotDir } from "./paths";

type Db = typeof defaultDb;

/**
 * Why a row is already in the ledger.
 *
 * - `hash` — the same file (or one with identical row offsets) was imported
 *   before. `import_row_hash` matched exactly.
 * - `content` — the same transaction is already here, but arrived under a
 *   different `import_row_hash`: a wider Star One re-export shifted its row
 *   index, or it came in from a SimpleFIN sync (which derives its hash from the
 *   feed's id and never from a row index at all).
 */
export type DuplicateReason = "hash" | "content";

export type ImportPreviewRow = {
  rowIndex: number;
  date: string;
  amountCents: number;
  rawDescription: "WITHDRAWAL" | "DEPOSIT";
  rawMemo: string;
  normalizedMerchant: string;
  cardLastFour: string | null;
  bankTransactionNumber: string;
  importRowHash: string;
  /**
   * Star One's running balance after this row. Null or 0 on pending rows, null
   * on any posted row whose Balance cell does not parse.
   */
  balanceCents: number | null;
  isPending: boolean;
  duplicate: boolean;
  duplicateReason: DuplicateReason | null;
  /**
   * Set when this row is a content match against an EXISTING PENDING row and
   * this incoming row is posted (`!isPending`) — the pending row's real-world
   * counterpart finally arriving. `commitImport` updates that row's id in
   * place (is_pending, balance_cents, bank_transaction_number,
   * import_row_hash) instead of just dropping this row as a duplicate.
   * Without this, a row CSV-imported while pending permanently freezes: the
   * content pass would otherwise drop its posted re-export forever, leaving
   * it stuck on Star One's `6098` placeholder — un-pairable by the transfer
   * matcher and invisible to subscription detection.
   */
  updateExistingRowId: number | null;
};

export type ImportPreview = {
  accountId: number;
  filename: string;
  totals: {
    parsedRows: number;
    newRows: number;
    duplicates: number;
    errors: number;
    pendingRows: number;
  };
  rows: ImportPreviewRow[];
  errors: ParseError[];
};

export function transformRow(
  parsed: ParsedRow,
): Omit<ImportPreviewRow, "duplicate" | "duplicateReason" | "updateExistingRowId"> {
  const normalizedMerchant = normalizeMerchant(parsed.rawMemo);
  const cardLastFour = extractCardLastFour(parsed.rawMemo);
  const importRowHash = computeImportRowHash({
    date: parsed.date,
    amountCents: parsed.amountCents,
    rawDescription: parsed.rawDescription,
    rawMemo: parsed.rawMemo,
    rowIndex: parsed.rowIndex,
  });
  return {
    rowIndex: parsed.rowIndex,
    date: parsed.date,
    amountCents: parsed.amountCents,
    rawDescription: parsed.rawDescription,
    rawMemo: parsed.rawMemo,
    normalizedMerchant,
    cardLastFour,
    bankTransactionNumber: parsed.bankTransactionNumber,
    importRowHash,
    balanceCents: parsed.balanceCents,
    isPending: parsed.isPending,
  };
}

export function buildPreview(
  opts: { accountId: number; filename: string; csvText: string },
  db: Db = defaultDb,
): ImportPreview {
  const { accountId, filename, csvText } = opts;
  const parsed = parseStarOneCsv(csvText);
  const transformed = parsed.rows.map(transformRow);

  const hashes = transformed.map((r) => r.importRowHash);
  const existing = hashes.length
    ? db
        .select({ hash: schema.transactions.importRowHash })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.accountId, accountId),
            inArray(schema.transactions.importRowHash, hashes),
          ),
        )
        .all()
    : [];
  const existingSet = new Set(existing.map((e) => e.hash));
  const hashDuplicate = transformed.map((r) => existingSet.has(r.importRowHash));

  // Second dedup pass, on content rather than hash. `import_row_hash` mixes in
  // the row's index within its source file (CLAUDE.md rule 3), and Star One
  // exports an arbitrary date range — so re-exporting a wider window puts every
  // already-imported row at a new offset and changes every hash. The pass above
  // then sees nothing and the whole overlap is inserted a second time, with the
  // preview reporting "0 duplicates". Same mechanism the sync path already uses
  // (`simplefin/sync.ts`), applied to the source it was never applied back to.
  //
  // Scoped to this account and to the date span the file actually covers, so a
  // narrow import does not pay for a full-table scan. No `external_id` filter,
  // unlike sync's version: a CSV re-export legitimately overlaps rows that
  // arrived from a sync, and those need catching too.
  //
  // Candidate LISTS rather than bare counts: a repeated signature is a real
  // repeat (two identical same-day coffees), so this is a multiset, not a set
  // — collapsing it would make the second coffee permanently unimportable.
  // Lists (not just counts) also let a posted incoming row find and update a
  // PENDING existing candidate specifically, rather than being indifferent to
  // which copy it "spends" — see the pending-row branch below.
  type ExistingCandidate = { id: number; isPending: boolean };
  const contentCandidates = new Map<string, ExistingCandidate[]>();
  if (transformed.length > 0) {
    let minDate = transformed[0].date;
    let maxDate = transformed[0].date;
    for (const r of transformed) {
      if (r.date < minDate) minDate = r.date;
      if (r.date > maxDate) maxDate = r.date;
    }

    const existingInRange = db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        amountCents: schema.transactions.amountCents,
        rawMemo: schema.transactions.rawMemo,
        isPending: schema.transactions.isPending,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, accountId),
          gte(schema.transactions.date, minDate),
          lte(schema.transactions.date, maxDate),
        ),
      )
      .all();

    for (const r of existingInRange) {
      const sig = contentSignature(r);
      const list = contentCandidates.get(sig) ?? [];
      list.push({ id: r.id, isPending: r.isPending });
      contentCandidates.set(sig, list);
    }

    // Rows already matched by hash claim their own existing row's candidate
    // before anything else is compared. Without this, an earlier unmatched row
    // in the file could spend the candidate belonging to a row that a later
    // hash match already accounts for, and a genuinely new transaction would
    // be dropped as a duplicate.
    transformed.forEach((r, i) => {
      if (!hashDuplicate[i]) return;
      const sig = contentSignature(r);
      contentCandidates.get(sig)?.pop();
    });
  }

  /**
   * Claim one existing candidate for `r`'s signature, preferring a PENDING
   * candidate when `r` itself is posted — that pairing is the pending row's
   * real-world counterpart arriving, not a coincidental repeat, so the caller
   * updates the existing row in place instead of just dropping this one.
   */
  function claimContentCandidate(r: {
    date: string;
    amountCents: number;
    rawMemo: string;
    isPending: boolean;
  }): ExistingCandidate | undefined {
    const sig = contentSignature(r);
    const list = contentCandidates.get(sig);
    if (!list || list.length === 0) return undefined;

    if (!r.isPending) {
      const pendingIndex = list.findIndex((c) => c.isPending);
      if (pendingIndex !== -1) {
        return list.splice(pendingIndex, 1)[0];
      }
    }
    return list.pop();
  }

  const rows: ImportPreviewRow[] = transformed.map((r, i) => {
    if (hashDuplicate[i]) {
      return { ...r, duplicate: true, duplicateReason: "hash" as const, updateExistingRowId: null };
    }
    const candidate = claimContentCandidate(r);
    if (candidate !== undefined) {
      // Only a genuinely pending existing row becomes an update target. An
      // already-posted candidate (a plain repeat — rule 3's "two identical
      // coffees") stays a pure duplicate: it must NOT have its
      // bank_transaction_number/import_row_hash overwritten by an unrelated
      // second row that merely shares its content signature.
      return {
        ...r,
        duplicate: true,
        duplicateReason: "content" as const,
        updateExistingRowId: candidate.isPending ? candidate.id : null,
      };
    }
    return { ...r, duplicate: false, duplicateReason: null, updateExistingRowId: null };
  });

  const duplicates = rows.filter((r) => r.duplicate).length;
  const pendingRows = rows.filter((r) => r.isPending).length;

  return {
    accountId,
    filename,
    rows,
    errors: parsed.errors,
    totals: {
      parsedRows: rows.length,
      newRows: rows.length - duplicates,
      duplicates,
      errors: parsed.errors.length,
      pendingRows,
    },
  };
}

export type CommitResult =
  | {
      status: "empty";
      duplicateCount: number;
      errorCount: number;
    }
  | {
      status: "committed";
      batchId: number;
      insertedCount: number;
      duplicateCount: number;
      errorCount: number;
      pairsLinked: number;
      snapshot: SnapshotResult;
      warnings: string[];
      /**
       * The starting-balance anchor this import wrote onto the account, or null
       * if it left the existing one alone. See `deriveStartingBalance`.
       */
      startingBalance: { date: string; startingBalanceCents: number } | null;
    };

export function commitImport(
  opts: { accountId: number; filename: string; csvText: string },
  db: Db = defaultDb,
): CommitResult {
  const preview = buildPreview(opts, db);
  const toInsert = preview.rows.filter((r) => !r.duplicate);
  const toUpdate = preview.rows.filter((r) => r.updateExistingRowId !== null);

  // A file can carry zero brand-new rows and still have real work to do — a
  // narrow re-export containing only rows that were pending and have since
  // posted. Bailing out here on `toInsert.length === 0` alone would silently
  // skip every pending → posted update this fix exists to make.
  if (toInsert.length === 0 && toUpdate.length === 0) {
    return {
      status: "empty",
      duplicateCount: preview.totals.duplicates,
      errorCount: preview.totals.errors,
    };
  }

  const snapshot = createSnapshot(dbPath(), snapshotDir());
  const warnings: string[] = [];
  if (!snapshot.consistent) {
    warnings.push(
      `The pre-import snapshot fell back to a plain file copy${
        snapshot.degradedReason ? ` (${snapshot.degradedReason})` : ""
      } — it may be missing the most recent writes, or fail to open at all if restored.`,
    );
  }

  const transactionResult = db.transaction((tx) => {
    // Trained rules are read once for the whole batch, not once per row: a
    // 4-month backfill is hundreds of rows inside a single write transaction.
    const matchRule = buildRuleMatcher(tx);

    // Computed BEFORE the batch insert (it depends only on `preview.rows`,
    // already built outside the transaction, and `tx`) so a declined-anchor
    // reason can be folded into the same `snapshotWarning` field the insert
    // below writes — not appended to `warnings` afterward, where nothing
    // ever persists it. That gap (warnings computed after the row the UI
    // actually reads was already written, with no follow-up update) is
    // exactly how the first version of this fix shipped a warning nobody
    // could ever see; caught by cross-model adversarial review, not by
    // any test, since every test asserted the in-memory `warnings` array
    // rather than the persisted column the success page renders.
    const anchorResult = anchorStartingBalance(opts.accountId, preview.rows, tx);
    if (anchorResult.status === "rejected") {
      warnings.push(anchorResult.reason);
    }

    const [batch] = tx
      .insert(schema.importBatches)
      .values({
        source: "csv",
        label: opts.filename,
        snapshotPath: snapshot.snapshotPath,
        snapshotWarning: warnings.length > 0 ? warnings.join(" ") : null,
        transactionCount: 0,
      })
      .returning({ id: schema.importBatches.id })
      .all();

    const insertedIds: number[] = [];
    for (const row of toInsert) {
      // Auto-categorize on the way in. Without this every import lands 100%
      // uncategorized no matter how many rules the user has trained, and the
      // backlog only ever grows — which is how 498 rows accumulated before
      // this was wired up. No match still means NULL, which is what the
      // dashboard backlog tile counts (CLAUDE.md rule 6).
      const match = matchRule(row.normalizedMerchant, row.amountCents);

      const [inserted] = tx
        .insert(schema.transactions)
        .values({
          accountId: opts.accountId,
          date: row.date,
          rawDescription: row.rawDescription,
          rawMemo: row.rawMemo,
          normalizedMerchant: row.normalizedMerchant,
          amountCents: row.amountCents,
          bankTransactionNumber: row.bankTransactionNumber || null,
          cardLastFour: row.cardLastFour,
          importSource: "csv",
          importBatchId: batch.id,
          importRowHash: row.importRowHash,
          balanceCents: row.balanceCents,
          isPending: row.isPending,
          categoryId: match?.categoryId ?? null,
        })
        .returning({ id: schema.transactions.id })
        .all();
      insertedIds.push(inserted.id);

      // Recorded so a too-broad rule's whole batch of auto-categorization can
      // be undone later (undoImportCategorization) — matching bulkCategorize's
      // existing undo pattern, which import-time categorization never had.
      if (match) {
        tx.insert(schema.importBatchCategorizations)
          .values({
            importBatchId: batch.id,
            transactionId: inserted.id,
            categoryId: match.categoryId,
            ruleId: match.ruleId,
          })
          .run();
      }
    }

    tx.update(schema.importBatches)
      .set({ transactionCount: toInsert.length })
      .where(eq(schema.importBatches.id, batch.id))
      .run();

    // The pending row's real-world counterpart finally posting. Updated in
    // place rather than inserted as a second row — the pending row keeps its
    // original batch attribution, id, and any category the user already gave
    // it; only the fields the posted version corrects are overwritten.
    for (const row of toUpdate) {
      tx.update(schema.transactions)
        .set({
          isPending: false,
          balanceCents: row.balanceCents,
          bankTransactionNumber: row.bankTransactionNumber || null,
          rawMemo: row.rawMemo,
          normalizedMerchant: row.normalizedMerchant,
          cardLastFour: row.cardLastFour,
          importRowHash: row.importRowHash,
        })
        .where(eq(schema.transactions.id, row.updateExistingRowId!))
        .run();
    }

    // Persisted onto the batch (not re-derived from the account's current
    // anchor on every page view) so a later import that moves the anchor again
    // can't make this batch's success page misattribute the newer value to
    // itself, and so the tile can be omitted outright when this batch didn't
    // move the anchor at all. `priorStartingBalance*` is the account's anchor
    // immediately before this move — the record that lets a bad automatic
    // move be corrected via `updateAccountAnchorAction` without guessing what
    // the old value was.
    if (anchorResult.status === "moved") {
      tx.update(schema.importBatches)
        .set({
          anchoredStartingBalanceCents: anchorResult.startingBalanceCents,
          anchoredStartingBalanceDate: anchorResult.date,
          priorStartingBalanceCents: anchorResult.priorStartingBalanceCents,
          priorStartingBalanceDate: anchorResult.priorStartingBalanceDate,
        })
        .where(eq(schema.importBatches.id, batch.id))
        .run();
    }

    return {
      batchId: batch.id,
      insertedIds,
      startingBalance:
        anchorResult.status === "moved"
          ? { date: anchorResult.date, startingBalanceCents: anchorResult.startingBalanceCents }
          : null,
    };
  });
  const { batchId, insertedIds, startingBalance } = transactionResult;

  // Prune only after the write has committed — pruning before it meant a failed
  // import had already evicted the oldest snapshot to make room for a useless
  // one. Failures to delete are ignored here rather than aborting an import that
  // has already succeeded.
  pruneSnapshots(snapshotDir());

  // Seeded from BOTH freshly-inserted rows and rows just updated from pending
  // to posted (`toUpdate`) — not from `batchId` alone. A `toUpdate` row keeps
  // its ORIGINAL batch's id (that's what lets the success page attribute it
  // to the import that first brought it in), so a re-export whose only new
  // information is a pending row posting would otherwise seed this pass with
  // nothing: a transfer that only became pairable once its pending leg posted
  // could stay permanently unpaired.
  const seedRowIds = [
    ...insertedIds,
    ...toUpdate.map((row) => row.updateExistingRowId!),
  ];
  const pairsLinked = linkTransferPairs(seedRowIds, db);

  // Persisted rather than left for the success page to recompute: a
  // `COUNT(*) WHERE import_batch_id = batchId` undercounts the moment a pair
  // links a `toUpdate` row, which keeps its ORIGINAL batch's id by design —
  // exactly the case this fix exists to handle. Written unconditionally
  // (even when 0) so a page reading `pairsLinkedCount` can tell "this batch
  // linked nothing" apart from "written before this column existed" (null).
  db.update(schema.importBatches)
    .set({ pairsLinkedCount: pairsLinked })
    .where(eq(schema.importBatches.id, batchId))
    .run();

  return {
    status: "committed",
    batchId,
    insertedCount: toInsert.length,
    duplicateCount: preview.totals.duplicates,
    errorCount: preview.totals.errors,
    pairsLinked,
    snapshot,
    warnings,
    startingBalance,
  };
}

type AnchorResult =
  | {
      status: "moved";
      date: string;
      startingBalanceCents: number;
      priorStartingBalanceCents: number;
      priorStartingBalanceDate: string;
    }
  | { status: "unchanged" }
  | { status: "rejected"; reason: string };

/**
 * Move the account's starting-balance anchor onto a real bank balance read from
 * this file's running-balance column.
 *
 * Derived from every parsed row, not just the newly inserted ones: rows already
 * in the ledger are still links in the running-balance chain, and dropping them
 * would break it.
 *
 * The anchor only ever moves FORWARD in time. Any (date, true closing balance)
 * pair is a valid anchor, but a later one is strictly safer: the balance rule
 * sums every row after the anchor date, so the further back the anchor sits,
 * the more history has to be complete for the total to come out right. Moving
 * it backwards would trade a known-good anchor for one that depends on more
 * data being present.
 *
 * Runs inside the caller's write transaction and takes `tx`, never `defaultDb`
 * directly — this used to run after `commitImport`'s transaction committed,
 * so a crash between the two writes could leave the imported rows in place
 * with no matching anchor move and no record of what almost happened.
 *
 * Bounds-checked the same as a hand-typed anchor (`accountAnchorFields.ts`):
 * a single-row file trivially satisfies `isValidChain` (the loop over pairs
 * never executes), so one corrupted or hand-edited row would otherwise anchor
 * the account on whatever that row's Balance cell says, with no corroboration
 * at all.
 */
function anchorStartingBalance(
  accountId: number,
  rows: readonly ImportPreviewRow[],
  tx: AnyDb,
): AnchorResult {
  const derived = deriveStartingBalance(rows);
  if (!derived.ok) {
    // A switch (not an `||` chain over string constants) so a future new
    // reason value fails typechecking here instead of silently falling into
    // the wrong branch — see `StartingBalanceDerivationReason`'s doc comment.
    switch (derived.reason) {
      case "chain-broken":
      case "chain-ambiguous":
        // Only these two "we had running-balance data but it didn't resolve"
        // reasons are worth a warning — the far more common "no posted rows
        // carried a balance" case (an all-pending or Balance-less import)
        // isn't evidence of a problem, so it stays silent like it always has.
        return {
          status: "rejected",
          reason: `Declined to move the starting-balance anchor: ${STARTING_BALANCE_DERIVATION_MESSAGES[derived.reason]}.`,
        };
      case "no-balance-data":
        return { status: "unchanged" };
    }
  }

  if (!isStartingBalanceCentsInBounds(derived.startingBalanceCents)) {
    return {
      status: "rejected",
      reason: `Declined to move the starting-balance anchor: the derived balance (${formatCents(derived.startingBalanceCents)}) is outside the allowed range.`,
    };
  }
  if (!startingBalanceDateSchema.safeParse(derived.date).success) {
    return {
      status: "rejected",
      reason: `Declined to move the starting-balance anchor: the derived date "${derived.date}" is not a valid anchor date.`,
    };
  }
  // Mirrors `validateUpdateAnchorInput`'s future-date guard: `loadAccountBalances`
  // sums only rows dated strictly after the anchor, so a future anchor (a
  // corrupted or hand-edited Balance/date cell) would exclude every real
  // transaction and freeze the displayed balance, permanently silencing the
  // `/sync` drift check for this account too. A real bank CSV can't produce a
  // future transaction date, but nothing upstream of this guarantees that.
  if (derived.date > todayIso()) {
    return {
      status: "rejected",
      reason: `Declined to move the starting-balance anchor: the derived date "${derived.date}" is in the future.`,
    };
  }

  const account = tx
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) {
    // Unreachable in practice: `transactions.accountId` has a FK to
    // `accounts.id` (`PRAGMA foreign_keys = ON`), so a nonexistent accountId
    // would already have thrown on this same transaction's row inserts.
    // Thrown explicitly rather than folded into the "doesn't move forward"
    // branch below, so this function's own contract doesn't depend on a
    // downstream constraint to turn a silent no-op into a loud failure.
    throw new Error(`anchorStartingBalance: account ${accountId} does not exist`);
  }
  if (derived.date < account.startingBalanceDate) {
    return { status: "unchanged" };
  }

  tx.update(schema.accounts)
    .set({
      startingBalanceCents: derived.startingBalanceCents,
      startingBalanceDate: derived.date,
      updatedAt: new Date(),
    })
    .where(eq(schema.accounts.id, accountId))
    .run();

  return {
    status: "moved",
    date: derived.date,
    startingBalanceCents: derived.startingBalanceCents,
    priorStartingBalanceCents: account.startingBalanceCents,
    priorStartingBalanceDate: account.startingBalanceDate,
  };
}

/**
 * Re-check a set of rows (and whatever shares their date) for transfer pairs.
 *
 * Takes explicit row ids to seed from, not a batch id: a `commitImport` batch
 * can bring a row into pairing contention two different ways — a brand-new
 * insert, or an existing PENDING row updated to posted in place (`toUpdate`
 * in `commitImport`) — and the second case keeps its ORIGINAL batch's id, so
 * a query scoped to `importBatchId = batchId` would never find it. The
 * caller passes both.
 */
export function linkTransferPairs(seedRowIds: number[], db: Db = defaultDb): number {
  if (seedRowIds.length === 0) return 0;

  const newRows = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
      rawMemo: schema.transactions.rawMemo,
    })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.id, seedRowIds),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all();

  if (newRows.length === 0) return 0;

  const dates = Array.from(new Set(newRows.map((r) => r.date)));

  // newRows deliberately does NOT filter isPending: a still-pending seed row
  // still contributes its date here, so its import can trigger a same-day
  // scan that opportunistically links two UNRELATED already-posted rows
  // sharing that date — the only mechanism that ever re-checks a date once
  // its own legs' original imports failed to pair them. Filtering isPending
  // on this query too was tried and reverted: it made a pending-only import
  // return 0 immediately, permanently losing that self-heal trigger for
  // dates with no other pending/posted activity ever again. Found by Codex
  // adversarial review during `/ship` 2026-09-04.
  //
  // is_pending = false, mirroring the balance-sum rule (CLAUDE.md rule 1): a
  // still-pending row can carry Star One's shared placeholder transaction
  // number (6098, reused across unrelated pending deposits), which is a
  // legitimate-looking ±1 match candidate for an unrelated real transaction
  // and would link a false pair with no signal it's lower-confidence. This
  // filter alone (without also filtering newRows above) is sufficient: a
  // pending seed can still trigger the scan, but can never itself become a
  // pair member.
  //
  const sameDayUnpaired = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
      rawMemo: schema.transactions.rawMemo,
      transferRejectedPartnerId: schema.transactions.transferRejectedPartnerId,
    })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.date, dates),
        isNull(schema.transactions.transferPairId),
        eq(schema.transactions.isPending, false),
      ),
    )
    .all();

  const candidates: (PairCandidate & { rowId: number; transferRejectedPartnerId: number | null })[] =
    sameDayUnpaired.map((r) => ({
      id: r.id,
      rowId: r.id,
      accountId: r.accountId,
      date: r.date,
      amountCents: r.amountCents,
      bankTransactionNumber: r.bankTransactionNumber ?? "",
      rawMemo: r.rawMemo,
      transferRejectedPartnerId: r.transferRejectedPartnerId,
    }));

  // A row manually unlinked via "Not a transfer" must never be silently
  // re-linked to the SAME partner it was rejected against — see
  // unlinkTransferPair's docstring. Passed into findTransferPairs itself
  // (not a post-filter over its result): a post-filter would still let the
  // matcher's greedy `used` tracking consume a row on the rejected match
  // before ever trying its real partner in the same bucket. Not select-time
  // candidacy either — the row itself stays eligible to match something
  // else, only this exact combination is blocked. A transaction-scoped
  // candidacy filter was tried first and reverted — see the schema comment
  // on `transferRejectedPartnerId`. Found by Red Team, then corrected per
  // Codex structured review, both during `/ship` 2026-09-04.
  const pairs = findTransferPairs(
    candidates,
    undefined,
    (a, b) => a.transferRejectedPartnerId === b.rowId || b.transferRejectedPartnerId === a.rowId,
  );

  // One transaction, not two auto-commits per pair: each bare .run() is a
  // separate WAL commit with its own fsync on a synchronous driver that blocks
  // the event loop. Mirrors linkTransfersByBucket in simplefin/sync.ts.
  if (pairs.length > 0) {
    db.transaction((tx) => {
      for (const { a, b } of pairs) {
        tx.update(schema.transactions)
          .set({ transferPairId: b.rowId })
          .where(eq(schema.transactions.id, a.rowId))
          .run();
        tx.update(schema.transactions)
          .set({ transferPairId: a.rowId })
          .where(eq(schema.transactions.id, b.rowId))
          .run();
      }
    });
  }

  return pairs.length;
}
