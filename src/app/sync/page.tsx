import { Suspense } from "react";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { loadAccountBalances } from "@/lib/accounts/loadAccountBalances";
import { readAccessUrl } from "@/lib/simplefin/accessUrl";
import { listRemoteAccounts, type RemoteAccount } from "@/lib/simplefin/link";
import { findAmbiguousTransfers } from "@/lib/simplefin/sync";
import { findLastSyncBatch } from "@/lib/simplefin/undoSync";
import { SyncButton } from "./SyncButton";
import { linkAccountAction, resolveTransferAction, undoSyncAction } from "./actions";

// Never serve a cached balance. The bank round-trip is isolated inside
// <RemoteSections> behind Suspense, so the ledger-backed parts of this page
// (linked accounts, transfers needing review, undo) render straight from SQLite
// and only the SimpleFIN-dependent sections wait on the network.
export const dynamic = "force-dynamic";

const REVIEW_WINDOW_DAYS = 120;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export default function SyncPage() {
  const accounts = db.select().from(schema.accounts).all();
  const lastBatch = findLastSyncBatch();
  const ambiguous = findAmbiguousTransfers(daysAgoIso(REVIEW_WINDOW_DAYS));

  let host: string | null = null;
  let configError: string | null = null;
  try {
    host = readAccessUrl().host;
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
  }

  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const linkedCount = accounts.filter((a) => a.simplefinAccountId).length;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 space-y-10">
      <header>
        <h1 className="font-display text-xl font-semibold">Sync</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulls posted transactions from Star One via SimpleFIN and writes them
          straight in. Every sync snapshots the database first and can be undone.
        </p>
      </header>

      {configError ? (
        <section
          className="rounded-md border p-4 text-sm"
          style={{
            background: "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
            borderColor: "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
          }}
        >
          <p className="font-medium">SimpleFIN isn&apos;t configured yet</p>
          <p className="mt-1 text-muted-foreground">{configError}</p>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Connection</h2>
            <span className="text-xs text-muted-foreground">{host}</span>
          </div>
          <SyncButton disabled={linkedCount === 0} />
          {linkedCount === 0 && (
            <p className="text-sm text-muted-foreground">
              Link at least one account below before syncing.
            </p>
          )}
        </section>
      )}

      <Suspense fallback={<RemoteSectionsFallback />}>
        <RemoteSections host={host} />
      </Suspense>

      {/* ---- transfers needing a decision ---- */}
      {ambiguous.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            Transfers needing review ({ambiguous.length})
          </h2>
          <p className="text-sm text-muted-foreground">
            Same day, same amount, opposite signs — but the counts don&apos;t
            balance, so which row pairs with which changes the budget. Pick the
            two halves of each transfer.
          </p>
          {ambiguous.map((bucket) => (
            <form
              key={`${bucket.date}-${bucket.absAmountCents}-${bucket.positives[0]?.id}`}
              action={resolveTransferAction}
              className="space-y-3 rounded-md border border-border p-4"
            >
              <p className="font-mono text-sm font-medium [font-variant-numeric:tabular-nums]">
                {bucket.date} · {formatCents(bucket.absAmountCents)}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Money in</span>
                  <select
                    name="aId"
                    required
                    className="w-full rounded-md border border-border bg-transparent px-2 py-1"
                  >
                    {bucket.positives.map((p) => (
                      <option key={p.id} value={p.id}>
                        {accountsById.get(p.accountId)?.name ?? p.accountId} —{" "}
                        {p.rawMemo.slice(0, 44)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">Money out</span>
                  <select
                    name="bId"
                    required
                    className="w-full rounded-md border border-border bg-transparent px-2 py-1"
                  >
                    {bucket.negatives.map((n) => (
                      <option key={n.id} value={n.id}>
                        {accountsById.get(n.accountId)?.name ?? n.accountId} —{" "}
                        {n.rawMemo.slice(0, 44)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="submit"
                className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
              >
                Link as transfer
              </button>
            </form>
          ))}
        </section>
      )}

      {/* ---- undo ---- */}
      {lastBatch && (
        <section className="space-y-3">
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Last sync</h2>
          <div className="rounded-md border border-border p-4 text-sm">
            <p className="font-medium">{lastBatch.filename}</p>
            <p className="mt-1 text-muted-foreground">
              {lastBatch.transactionCount} transaction
              {lastBatch.transactionCount === 1 ? "" : "s"}
              {lastBatch.categorizedCount > 0 &&
                ` · ${lastBatch.categorizedCount} since categorised`}
            </p>
            {lastBatch.categorizedCount > 0 && (
              <p className="mt-2 text-destructive">
                Undoing deletes {lastBatch.categorizedCount} row
                {lastBatch.categorizedCount === 1 ? "" : "s"} you&apos;ve already
                categorised — that work is lost too.
              </p>
            )}
            <form action={undoSyncAction} className="mt-3">
              <input type="hidden" name="batchId" value={lastBatch.batchId} />
              <button
                type="submit"
                className="rounded-md border border-destructive/40 px-3 py-1 text-sm text-destructive hover:bg-destructive/10"
              >
                Undo this sync
              </button>
            </form>
          </div>
        </section>
      )}
    </div>
  );
}

/** Skeleton shown while the SimpleFIN round-trip is in flight. */
function RemoteSectionsFallback() {
  return (
    <section className="space-y-3" aria-busy="true">
      <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        Linked accounts
      </h2>
      <div className="h-24 animate-pulse rounded-md border border-border bg-muted/40" />
      <p className="text-xs text-muted-foreground">Asking the bank…</p>
    </section>
  );
}

/**
 * Everything that needs a live SimpleFIN response. Split out so the bank
 * round-trip streams in rather than blocking the whole page: a slow or stalled
 * bridge costs you this section, not the undo button.
 */
async function RemoteSections({ host }: { host: string | null }) {
  let remote: RemoteAccount[] = [];
  let remoteError: string | null = null;
  if (host) {
    try {
      remote = await listRemoteAccounts();
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err);
    }
  }

  const accounts = db.select().from(schema.accounts).all();
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const ledgerByAccountId = new Map(
    loadAccountBalances().map((b) => [b.id, b.balanceCents]),
  );

  return (
    <>
      {/* ---- accounts ---- */}
      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Linked accounts</h2>
        {remoteError && (
          <p className="text-sm text-destructive">{remoteError}</p>
        )}
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No local accounts yet — create one on the Import page first.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {accounts.map((a) => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <form
                  action={linkAccountAction}
                  className="flex flex-wrap items-center gap-3"
                >
                  <input type="hidden" name="accountId" value={a.id} />
                  <div className="min-w-40 flex-1">
                    <span className="font-medium">{a.name}</span>
                    <span className="ml-2 text-muted-foreground">({a.type})</span>
                  </div>
                  <select
                    // Uncontrolled: React will not re-apply defaultValue when it
                    // reconciles this node after a link is saved, so the select
                    // would keep showing "Not linked". Keying on the saved value
                    // forces a remount whenever the link actually changes.
                    key={a.simplefinAccountId ?? "unlinked"}
                    name="simplefinAccountId"
                    defaultValue={a.simplefinAccountId ?? ""}
                    disabled={!host || remote.length === 0}
                    className="rounded-md border border-border bg-transparent px-2 py-1"
                  >
                    <option value="">Not linked (CSV only)</option>
                    {remote.map((r) => (
                      <option
                        key={r.simplefinAccountId}
                        value={r.simplefinAccountId}
                        disabled={
                          r.linkedAccountId !== null && r.linkedAccountId !== a.id
                        }
                      >
                        {r.name}
                        {r.balanceCents !== null
                          ? ` — ${formatCents(r.balanceCents)}`
                          : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    // A disabled <select> is omitted from FormData entirely, so
                    // submitting here would fail validation and surface an error
                    // overlay rather than doing nothing.
                    disabled={!host || remote.length === 0}
                    className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
                  >
                    Save
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {remote.length > 0 && (
          <p className="text-xs text-muted-foreground">
            SimpleFIN also returns accounts this app doesn&apos;t model (a
            mortgage, for one). Anything left unlinked is simply never imported.
          </p>
        )}
      </section>

      {/* ---- balance check ---- */}
      {remote.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Balance check</h2>
          <p className="text-sm text-muted-foreground">
            The bank&apos;s own figure against the one this ledger computes. Any
            drift means a row is missing or duplicated.
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {remote
              .filter((r) => r.linkedAccountId !== null)
              .map((r) => {
                const local = accountsById.get(r.linkedAccountId!);
                const ledger = ledgerByAccountId.get(r.linkedAccountId!) ?? null;
                const drift =
                  ledger !== null && r.balanceCents !== null
                    ? ledger - r.balanceCents
                    : null;
                return (
                  <li key={r.simplefinAccountId} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{local?.name ?? r.name}</span>
                      <span className="font-mono [font-variant-numeric:tabular-nums] text-muted-foreground">
                        <span className="text-muted-foreground">ledger</span>{" "}
                        {ledger !== null ? formatCents(ledger) : "—"}
                        <span className="ml-3 text-muted-foreground">bank</span>{" "}
                        {r.balanceCents !== null ? formatCents(r.balanceCents) : "—"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span
                        className={
                          drift === null
                            ? "text-muted-foreground"
                            : drift === 0
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "font-medium text-amber-700 dark:text-amber-400"
                        }
                      >
                        {drift === null
                          ? "no bank figure to compare"
                          : drift === 0
                            ? "matches the bank exactly"
                            : `drift ${drift > 0 ? "+" : "−"}${formatCents(Math.abs(drift))} — a row is missing or duplicated, or the starting balance is wrong`}
                      </span>
                      {r.availableBalanceCents !== null &&
                        r.availableBalanceCents !== r.balanceCents && (
                          <span className="text-muted-foreground [font-variant-numeric:tabular-nums]">
                            available {formatCents(r.availableBalanceCents)}
                          </span>
                        )}
                    </div>
                  </li>
                );
              })}
          </ul>
          <p className="text-xs text-muted-foreground">
            Pending card holds show up as the gap between balance and available —
            Star One doesn&apos;t expose them as individual rows.
          </p>
        </section>
      )}
    </>
  );
}
