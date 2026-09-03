import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { parseStarOneCsv, type ParsedRow, type ParseError } from "./parseCsv";
import { normalizeMerchant, extractCardLastFour } from "./normalize";
import { computeImportRowHash } from "./hash";
import { contentSignature } from "./contentSignature";
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
  isPending: boolean;
  duplicate: boolean;
  duplicateReason: DuplicateReason | null;
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
): Omit<ImportPreviewRow, "duplicate" | "duplicateReason"> {
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
  const contentBudget = new Map<string, number>();
  if (transformed.length > 0) {
    let minDate = transformed[0].date;
    let maxDate = transformed[0].date;
    for (const r of transformed) {
      if (r.date < minDate) minDate = r.date;
      if (r.date > maxDate) maxDate = r.date;
    }

    const existingInRange = db
      .select({
        date: schema.transactions.date,
        amountCents: schema.transactions.amountCents,
        rawMemo: schema.transactions.rawMemo,
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

    // A repeated signature is a real repeat (two identical same-day coffees), so
    // this counts rather than sets — collapsing it would make the second coffee
    // permanently unimportable.
    for (const r of existingInRange) {
      const sig = contentSignature(r);
      contentBudget.set(sig, (contentBudget.get(sig) ?? 0) + 1);
    }

    // Rows already matched by hash claim their own existing row's budget before
    // anything else is compared. Without this, an earlier unmatched row in the
    // file could spend the budget belonging to a row that a later hash match
    // already accounts for, and a genuinely new transaction would be dropped as
    // a duplicate.
    transformed.forEach((r, i) => {
      if (!hashDuplicate[i]) return;
      const sig = contentSignature(r);
      const budget = contentBudget.get(sig) ?? 0;
      if (budget > 0) contentBudget.set(sig, budget - 1);
    });
  }

  const rows: ImportPreviewRow[] = transformed.map((r, i) => {
    if (hashDuplicate[i]) {
      return { ...r, duplicate: true, duplicateReason: "hash" as const };
    }
    const sig = contentSignature(r);
    const budget = contentBudget.get(sig) ?? 0;
    if (budget > 0) {
      contentBudget.set(sig, budget - 1);
      return { ...r, duplicate: true, duplicateReason: "content" as const };
    }
    return { ...r, duplicate: false, duplicateReason: null };
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
    };

export function commitImport(
  opts: { accountId: number; filename: string; csvText: string },
  db: Db = defaultDb,
): CommitResult {
  const preview = buildPreview(opts, db);
  const toInsert = preview.rows.filter((r) => !r.duplicate);

  if (toInsert.length === 0) {
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

  const batchId = db.transaction((tx) => {
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

    for (const row of toInsert) {
      tx.insert(schema.transactions)
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
          isPending: row.isPending,
        })
        .run();
    }

    tx.update(schema.importBatches)
      .set({ transactionCount: toInsert.length })
      .where(eq(schema.importBatches.id, batch.id))
      .run();

    return batch.id;
  });

  // Prune only after the write has committed — pruning before it meant a failed
  // import had already evicted the oldest snapshot to make room for a useless
  // one. Failures to delete are ignored here rather than aborting an import that
  // has already succeeded.
  pruneSnapshots(snapshotDir());

  const pairsLinked = linkTransferPairs(batchId, db);

  return {
    status: "committed",
    batchId,
    insertedCount: toInsert.length,
    duplicateCount: preview.totals.duplicates,
    errorCount: preview.totals.errors,
    pairsLinked,
    snapshot,
    warnings,
  };
}

export function linkTransferPairs(batchId: number, db: Db = defaultDb): number {
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
        eq(schema.transactions.importBatchId, batchId),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all();

  if (newRows.length === 0) return 0;

  const dates = Array.from(new Set(newRows.map((r) => r.date)));

  const sameDayUnpaired = db
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
        inArray(schema.transactions.date, dates),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .all();

  const candidates: (PairCandidate & { rowId: number })[] = sameDayUnpaired.map(
    (r) => ({
      id: r.id,
      rowId: r.id,
      accountId: r.accountId,
      date: r.date,
      amountCents: r.amountCents,
      bankTransactionNumber: r.bankTransactionNumber ?? "",
      rawMemo: r.rawMemo,
    }),
  );

  const pairs = findTransferPairs(candidates);

  for (const { a, b } of pairs) {
    db.update(schema.transactions)
      .set({ transferPairId: b.rowId })
      .where(eq(schema.transactions.id, a.rowId))
      .run();
    db.update(schema.transactions)
      .set({ transferPairId: a.rowId })
      .where(eq(schema.transactions.id, b.rowId))
      .run();
  }

  return pairs.length;
}
