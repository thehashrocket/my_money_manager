import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { buildPreview } from "@/lib/importBatch";
import { formatCents } from "@/lib/money";
import { readPendingImport } from "@/lib/pendingImport";
import { cancelImportAction, confirmImportAction } from "../../actions";

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const pending = readPendingImport(id);
  if (!pending) notFound();

  const [account] = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, pending.accountId))
    .all();
  if (!account) notFound();

  const preview = buildPreview({
    accountId: pending.accountId,
    filename: pending.filename,
    csvText: pending.csv,
  });

  const canCommit = preview.totals.newRows > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Preview import</h1>
        <p className="text-sm text-zinc-500">
          {pending.filename} → <span className="font-medium">{account.name}</span> (
          {account.type})
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="parsed" value={preview.totals.parsedRows} />
        <Stat label="new" value={preview.totals.newRows} highlight />
        <Stat label="duplicates" value={preview.totals.duplicates} />
        <Stat label="pending" value={preview.totals.pendingRows} />
        <Stat label="errors" value={preview.totals.errors} />
      </section>

      {!canCommit && (
        <section className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium">Nothing new to import</div>
          <div className="mt-1 text-amber-800">
            {preview.totals.parsedRows === 0
              ? "No rows were parsed from this file."
              : preview.totals.duplicates === preview.totals.parsedRows
                ? `All ${preview.totals.duplicates} rows are already in this account. Cancel to start over.`
                : `${preview.totals.duplicates} duplicate${preview.totals.duplicates === 1 ? "" : "s"}, ${preview.totals.errors} error${preview.totals.errors === 1 ? "" : "s"}, and no new rows. Cancel to start over.`}
          </div>
        </section>
      )}

      {preview.errors.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-red-700">
            Parse errors ({preview.errors.length})
          </h2>
          <ul className="divide-y divide-zinc-200 rounded-md border border-red-200 bg-red-50 text-xs">
            {preview.errors.slice(0, 20).map((e) => (
              <li key={`${e.rowIndex}-${e.reason}`} className="px-3 py-2">
                <span className="font-mono text-red-700">row {e.rowIndex}</span> —{" "}
                {e.reason}
                <div className="mt-1 truncate font-mono text-zinc-500">{e.raw}</div>
              </li>
            ))}
            {preview.errors.length > 20 && (
              <li className="px-3 py-2 text-zinc-500">
                … {preview.errors.length - 20} more
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Rows</h2>
        <div className="overflow-x-auto rounded-md border border-zinc-200">
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 text-left">
              <tr>
                <th className="px-2 py-1 font-medium">#</th>
                <th className="px-2 py-1 font-medium">date</th>
                <th className="px-2 py-1 font-medium">amount</th>
                <th className="px-2 py-1 font-medium">type</th>
                <th className="px-2 py-1 font-medium">merchant</th>
                <th className="px-2 py-1 font-medium">card</th>
                <th className="px-2 py-1 font-medium">status</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 200).map((r) => (
                <tr
                  key={r.importRowHash}
                  className={`border-t border-zinc-100 ${
                    r.duplicate ? "bg-zinc-50 text-zinc-400" : ""
                  }`}
                >
                  <td className="px-2 py-1 font-mono">{r.rowIndex}</td>
                  <td className="px-2 py-1 font-mono">{r.date}</td>
                  <td
                    className={`px-2 py-1 font-mono ${
                      r.amountCents < 0 ? "text-red-700" : "text-emerald-700"
                    }`}
                  >
                    {formatCents(r.amountCents)}
                  </td>
                  <td className="px-2 py-1">{r.rawDescription}</td>
                  <td className="px-2 py-1 truncate max-w-[28ch]" title={r.rawMemo}>
                    <div>{r.normalizedMerchant}</div>
                    <div className="text-[10px] text-zinc-400 truncate">
                      {r.rawMemo}
                    </div>
                  </td>
                  <td className="px-2 py-1 font-mono">{r.cardLastFour ?? "—"}</td>
                  <td className="px-2 py-1">
                    {r.duplicate ? (
                      <span className="text-zinc-500">duplicate</span>
                    ) : r.isPending ? (
                      <span className="text-amber-700">pending</span>
                    ) : (
                      <span className="text-emerald-700">new</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > 200 && (
            <div className="px-3 py-2 text-xs text-zinc-500 border-t border-zinc-200">
              showing first 200 of {preview.rows.length}
            </div>
          )}
        </div>
      </section>

      <section className="flex items-center gap-3">
        {canCommit && (
          <form action={confirmImportAction}>
            <input type="hidden" name="id" value={pending.id} />
            <button
              type="submit"
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
            >
              Confirm import ({preview.totals.newRows} rows)
            </button>
          </form>
        )}
        <form action={cancelImportAction}>
          <input type="hidden" name="id" value={pending.id} />
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
        </form>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        highlight ? "border-emerald-300 bg-emerald-50" : "border-zinc-200"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
