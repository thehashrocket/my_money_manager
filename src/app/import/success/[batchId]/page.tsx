import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { resolveBatchLabel } from "@/lib/batchLabel";
import { formatCents } from "@/lib/money";

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

  // A CSV import can move the account's starting-balance anchor onto a real
  // bank balance read from the file's running-balance column. That rewrites the
  // number every displayed balance is computed from, so it is shown rather than
  // changed silently.
  const [anchored] = db
    .select({
      name: schema.accounts.name,
      startingBalanceCents: schema.accounts.startingBalanceCents,
      startingBalanceDate: schema.accounts.startingBalanceDate,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(eq(schema.transactions.importBatchId, batchId))
    .limit(1)
    .all();

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
            <dd className="text-sm">
              {formatCents(anchored.startingBalanceCents)} as of{" "}
              {anchored.startingBalanceDate}
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
