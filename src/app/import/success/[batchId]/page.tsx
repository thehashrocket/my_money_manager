import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { resolveBatchLabel } from "@/lib/batchLabel";
import { formatCents } from "@/lib/money";
import { countRevertibleCategorizations } from "@/lib/categorize/undoImportCategorization";
import { undoImportCategorizationAction } from "../../actions";

export default async function SuccessPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId: raw } = await params;
  const batchId = Number(raw);
  if (!Number.isInteger(batchId)) notFound();

  const [batch] = db
    .select()
    .from(schema.importBatches)
    .where(eq(schema.importBatches.id, batchId))
    .all();
  if (!batch) notFound();

  const [{ pairsLinked }] = db
    .select({ pairsLinked: sql<number>`COUNT(*)` })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.importBatchId, batchId),
        isNotNull(schema.transactions.transferPairId),
      ),
    )
    .all();

  // Rows this batch resolved against a trained rule on the way in. Shown so the
  // rule engine is visible work rather than a silent write — the remainder is
  // exactly what lands in the /categorize backlog.
  const [{ autoCategorized }] = db
    .select({ autoCategorized: sql<number>`COUNT(*)` })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.importBatchId, batchId),
        isNotNull(schema.transactions.categoryId),
      ),
    )
    .all();

  // Rows still revertible via undoImportCategorizationAction — present only
  // while the batch's rule-matched categorization hasn't been undone yet AND
  // the transaction hasn't since been hand-categorized to something else
  // (countRevertibleCategorizations mirrors undoImportCategorization's own
  // stale-row check, so this number is never an overclaim).
  const revertibleCount = countRevertibleCategorizations(db, batchId);

  // A CSV import can move the account's starting-balance anchor onto a real
  // bank balance read from the file's running-balance column. That rewrites the
  // number every displayed balance is computed from, so it is shown rather than
  // changed silently — but ONLY when this batch actually moved it.
  // `anchoredStartingBalanceCents`/`Date` are what `commitImport` persisted
  // onto the batch at commit time, not the account's current anchor: a live
  // re-read would render on every batch (the derivation can decline for two
  // ordinary reasons — a non-chaining file, or a date that would move the
  // anchor backwards) and would attribute a later batch's anchor move to an
  // earlier one on a revisit.
  const anchored =
    batch.anchoredStartingBalanceCents !== null && batch.anchoredStartingBalanceDate !== null
      ? {
          startingBalanceCents: batch.anchoredStartingBalanceCents,
          startingBalanceDate: batch.anchoredStartingBalanceDate,
          name: db
            .select({ name: schema.accounts.name })
            .from(schema.transactions)
            .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
            .where(eq(schema.transactions.importBatchId, batchId))
            .limit(1)
            .get()?.name,
        }
      : null;

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import complete</h1>
        <p className="text-sm text-zinc-500">
          Batch #{batch.id} — {resolveBatchLabel(batch)}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-4 rounded-md border border-zinc-200 p-4 text-sm">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-zinc-500">imported</dt>
          <dd className="text-lg font-semibold">{batch.transactionCount}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
            transfer pairs linked
          </dt>
          <dd className="text-lg font-semibold">{pairsLinked}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
            auto-categorized
          </dt>
          <dd className="text-lg font-semibold">{autoCategorized}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
            left to categorize
          </dt>
          <dd className="text-lg font-semibold">
            {batch.transactionCount - autoCategorized}
          </dd>
        </div>
        {anchored && (
          <div className="col-span-2">
            <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
              {anchored.name} starting balance
            </dt>
            <dd className="font-mono text-sm [font-variant-numeric:tabular-nums]">
              {formatCents(anchored.startingBalanceCents)} as of{" "}
              {anchored.startingBalanceDate}
              {batch.priorStartingBalanceCents !== null &&
                batch.priorStartingBalanceDate !== null && (
                  <span className="block text-xs text-zinc-500">
                    was {formatCents(batch.priorStartingBalanceCents)} as of{" "}
                    {batch.priorStartingBalanceDate} — use the anchor form on{" "}
                    <Link href="/import" className="underline">
                      /import
                    </Link>{" "}
                    to revert
                  </span>
                )}
            </dd>
          </div>
        )}
        {batch.snapshotPath && (
          <div className="col-span-2">
            <dt className="text-[10px] uppercase tracking-wide text-zinc-500">snapshot</dt>
            <dd className="font-mono text-xs break-all">{batch.snapshotPath}</dd>
          </div>
        )}
      </dl>

      {batch.snapshotWarning && (
        <p
          role="status"
          className="rounded-md border p-2 text-sm"
          style={{
            background:
              "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
            borderColor:
              "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
          }}
        >
          {batch.snapshotWarning}
        </p>
      )}

      {revertibleCount > 0 && (
        <div className="rounded-md border border-zinc-200 p-4 text-sm">
          <p>
            {revertibleCount} of the {autoCategorized} auto-categorized row
            {autoCategorized === 1 ? "" : "s"} above {revertibleCount === 1 ? "is" : "are"} still
            exactly as a trained rule left {revertibleCount === 1 ? "it" : "them"}. If one matched
            too broadly, undo just the categorization — the rest of this import stays.
          </p>
          <form action={undoImportCategorizationAction} className="mt-3">
            <input type="hidden" name="batchId" value={batch.id} />
            <button
              type="submit"
              className="rounded-md border px-3 py-1 text-sm hover:opacity-80"
              style={{
                borderColor:
                  "color-mix(in oklch, var(--accent-redbrown) 45%, transparent)",
                color: "var(--accent-redbrown)",
              }}
            >
              Undo auto-categorization
            </button>
          </form>
        </div>
      )}

      <div className="flex gap-3">
        <Link
          href="/import"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Import another
        </Link>
      </div>
    </div>
  );
}
