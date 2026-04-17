import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { parseStarOneCsv, type ParsedRow, type ParseError } from "./parseCsv";
import { normalizeMerchant, extractCardLastFour } from "./normalize";
import { computeImportRowHash } from "./hash";
import { findTransferPairs, type PairCandidate } from "./transferPair";
import { createSnapshot, type SnapshotResult } from "./snapshot";

type Db = typeof defaultDb;

const DB_PATH = path.join(process.cwd(), "data", "money.db");

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
): Omit<ImportPreviewRow, "duplicate"> {
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

  const rows: ImportPreviewRow[] = transformed.map((r) => ({
    ...r,
    duplicate: existingSet.has(r.importRowHash),
  }));

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

export type CommitResult = {
  batchId: number;
  insertedCount: number;
  duplicateCount: number;
  errorCount: number;
  pairsLinked: number;
  snapshot: SnapshotResult;
};

export function commitImport(
  opts: { accountId: number; filename: string; csvText: string },
  db: Db = defaultDb,
): CommitResult {
  const preview = buildPreview(opts, db);
  const toInsert = preview.rows.filter((r) => !r.duplicate);

  if (toInsert.length === 0) {
    throw new Error(
      `nothing to import: ${preview.totals.duplicates} duplicates, ${preview.totals.errors} errors`,
    );
  }

  const snapshot = createSnapshot(DB_PATH);

  const batchId = db.transaction((tx) => {
    const [batch] = tx
      .insert(schema.importBatches)
      .values({
        source: "csv",
        filename: opts.filename,
        snapshotPath: snapshot.snapshotPath,
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

  const pairsLinked = linkTransferPairs(batchId, db);

  return {
    batchId,
    insertedCount: toInsert.length,
    duplicateCount: preview.totals.duplicates,
    errorCount: preview.totals.errors,
    pairsLinked,
    snapshot,
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
