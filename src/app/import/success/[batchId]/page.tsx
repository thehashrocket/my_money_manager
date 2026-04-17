import Link from "next/link";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

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

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import complete</h1>
        <p className="text-sm text-zinc-500">
          Batch #{batch.id} — {batch.filename}
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
        {batch.snapshotPath && (
          <div className="col-span-2">
            <dt className="text-[10px] uppercase tracking-wide text-zinc-500">snapshot</dt>
            <dd className="font-mono text-xs break-all">{batch.snapshotPath}</dd>
          </div>
        )}
      </dl>

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
