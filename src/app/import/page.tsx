import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { createAccountAction, uploadCsvAction } from "./actions";

export default function ImportPage() {
  const accounts = db.select().from(schema.accounts).all();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Import CSV</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Upload a Star One CU export. You&apos;ll see a preview before anything is committed.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Accounts</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No accounts yet. Create one below to get started.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <div>
                  <span className="font-medium">{a.name}</span>
                  <span className="ml-2 text-zinc-500">({a.type})</span>
                </div>
                <div className="text-zinc-500 [font-variant-numeric:tabular-nums]">
                  start {formatCents(a.startingBalanceCents)} on {a.startingBalanceDate}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {accounts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Upload CSV</h2>
          <form
            action={uploadCsvAction}
            className="space-y-4 rounded-md border border-zinc-200 p-4"
          >
            <label className="block text-sm">
              <span className="block mb-1 font-medium">Account</span>
              <select
                name="accountId"
                required
                className="w-full rounded-md border border-zinc-300 px-3 py-2"
                defaultValue={String(accounts[0].id)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="block mb-1 font-medium">CSV file</span>
              <input
                type="file"
                name="file"
                accept=".csv,text/csv"
                required
                className="w-full text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Preview import
            </button>
          </form>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Add an account</h2>
        <form
          action={createAccountAction}
          className="grid grid-cols-1 gap-3 rounded-md border border-zinc-200 p-4 sm:grid-cols-2"
        >
          <label className="block text-sm sm:col-span-1">
            <span className="block mb-1 font-medium">Name</span>
            <input
              type="text"
              name="name"
              required
              placeholder="Checking"
              className="w-full rounded-md border border-zinc-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm sm:col-span-1">
            <span className="block mb-1 font-medium">Type</span>
            <select
              name="type"
              required
              defaultValue="checking"
              className="w-full rounded-md border border-zinc-300 px-3 py-2"
            >
              <option value="checking">checking</option>
              <option value="savings">savings</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-1">
            <span className="block mb-1 font-medium">Starting balance (USD)</span>
            <input
              type="number"
              name="startingBalance"
              step="0.01"
              required
              placeholder="0.00"
              className="w-full rounded-md border border-zinc-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm sm:col-span-1">
            <span className="block mb-1 font-medium">Starting balance date</span>
            <input
              type="date"
              name="startingBalanceDate"
              required
              defaultValue={today}
              className="w-full rounded-md border border-zinc-300 px-3 py-2"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Create account
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
