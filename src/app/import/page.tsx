import { connection } from "next/server";
import { db, schema } from "@/db";
import { accountClass } from "@/lib/accounts/accountClass";
import { todayIso } from "@/lib/now";
import { CreateAccountForm } from "./_create-account-form";
import { updateAccountAnchorAction, uploadCsvAction } from "./actions";

export default async function ImportPage() {
  // Without this, Next 16 prerenders the route at build time. On the host
  // that only freezes the starting-balance date default; inside the Docker
  // builder stage it is worse — `.dockerignore` excludes `data/`, so the
  // better-sqlite3 query below throws `SQLITE_CANTOPEN` and the image build
  // fails outright (see docs/plans/dockerize-postgres.md, F13).
  await connection();
  const allAccounts = db.select().from(schema.accounts).all();
  const today = todayIso();

  // E6 + E18 — both surfaces below are asset-only, for two different reasons
  // that happen to share a filter. A CSV imported into a credit card would
  // move that card's anchor off another account's balance chain
  // (forward-only, and silent), and the anchor-repair form is a raw signed
  // twin of /accounts' Reconcile that would offer a Visa an un-negated
  // balance field — the exact bug the create form above was raised to P1 to
  // close. Liabilities have exactly one anchor surface, and it is /accounts.
  // Both server actions re-check this; a stale tab still posts.
  const accounts = allAccounts.filter((a) => accountClass(a.type) === "asset");
  const liabilityCount = allAccounts.length - accounts.length;

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
            {liabilityCount > 0
              ? "No checking or savings accounts yet. Create one below to import a CSV."
              : "No accounts yet. Create one below to get started."}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200">
              {accounts.map((a) => (
                <li key={a.id} className="px-4 py-3 text-sm">
                  <form
                    action={updateAccountAnchorAction}
                    className="flex flex-wrap items-center gap-3"
                  >
                    <input type="hidden" name="accountId" value={a.id} />
                    <div className="min-w-40 flex-1">
                      <span className="font-medium">{a.name}</span>
                      <span className="ml-2 text-zinc-500">({a.type})</span>
                    </div>
                    <label className="flex items-center gap-1 text-zinc-500">
                      <span>start</span>
                      <input
                        type="number"
                        name="startingBalance"
                        step="0.01"
                        required
                        // Dollars, matching the create form — the action
                        // converts to cents. `.toFixed(2)` rather than a bare
                        // division so a whole-dollar anchor still renders as
                        // 984.00 in a step=0.01 field.
                        defaultValue={(a.startingBalanceCents / 100).toFixed(2)}
                        className="w-28 rounded-md border border-zinc-300 px-2 py-1 [font-variant-numeric:tabular-nums]"
                      />
                    </label>
                    <label className="flex items-center gap-1 text-zinc-500">
                      <span>on</span>
                      <input
                        type="date"
                        name="startingBalanceDate"
                        required
                        max={today}
                        defaultValue={a.startingBalanceDate}
                        className="rounded-md border border-zinc-300 px-2 py-1"
                      />
                    </label>
                    <button
                      type="submit"
                      className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100"
                    >
                      Save
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            <p className="text-xs text-zinc-500">
              The anchor is the balance at the <em>close</em> of its date; every
              transaction dated after it is summed on top. A CSV import can only
              move it <em>forward</em>, so if it is set too late — leaving your
              imported history out of the balance — this is the only way to move
              it back.
              {liabilityCount > 0 ? (
                <>
                  {" "}
                  Credit cards and loans are not listed here; update those from{" "}
                  <a href="/accounts" className="underline underline-offset-4">
                    Accounts
                  </a>
                  .
                </>
              ) : null}
            </p>
          </>
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
        <h2 className="font-display text-lg font-medium">Add an account</h2>
        <CreateAccountForm today={today} />
      </section>
    </div>
  );
}
