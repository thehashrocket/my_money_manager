import { Suspense } from "react";
import Link from "next/link";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { countRevertibleCategorizations } from "@/lib/categorize/undoImportCategorization";
import { loadAccountBalancesForRequest } from "@/lib/accounts/loadAccountBalances";
import { readAccessUrl } from "@/lib/simplefin/accessUrl";
import { listRemoteAccounts, type RemoteAccount } from "@/lib/simplefin/link";
import {
  findAmbiguousTransfers,
  findLinkedTransferPairs,
  findSameAccountReversalCandidates,
} from "@/lib/simplefin/sync";
import { overlappingRowIds } from "@/lib/simplefin/sameAccountReversals";
import { findLastSyncBatch } from "@/lib/simplefin/undoSync";
import { daysAgoIso, formatLocalDateTime, toLocalIso } from "@/lib/now";
import {
  classifyBalanceFreshness,
  type BalanceFreshness,
} from "@/lib/simplefin/balanceFreshness";
import { ReviewQueue } from "./_review-queue";
import { ActionFeedbackProvider } from "./_action-feedback";
import { SyncButton } from "./SyncButton";
import { ActionForm } from "./ActionForm";
import { PendingFieldset, SubmitButton } from "./_submit-button";
import {
  linkAccountAction,
  undoSyncAction,
  unlinkTransferAction,
} from "./actions";

// Never serve a cached balance. The bank round-trip is isolated inside
// <RemoteSections> behind Suspense, so the ledger-backed parts of this page
// (linked accounts, transfers needing review, undo) render straight from SQLite
// and only the SimpleFIN-dependent sections wait on the network.
export const dynamic = "force-dynamic";

/**
 * Deliberately wider than sync's own 45-day MAX_LOOKBACK_DAYS. This list is not
 * limited to what a sync touched: it surfaces every unresolved same-day,
 * same-amount collision in recent history, including ones that predate the first
 * sync and came in from CSV. Do not "fix" this to match MAX_LOOKBACK_DAYS —
 * they answer different questions.
 *
 * Widened from 120 to 240 for the load-the-ledger backfill. 120 days back from
 * the day that backfill ran was 2026-05-05, and it imports from 2026-04-21 — so
 * the ambiguous buckets from the first two weeks of it landed outside the only
 * surface that can resolve them, and their rows would have been counted as
 * spending, invisibly. The window has to cover the oldest history a CSV import
 * can introduce, which is unbounded by anything in this file; 240 buys roughly
 * eight months, which is the shape of a "catch up on a stale ledger" import.
 */
const REVIEW_WINDOW_DAYS = 240;

/** Minus sign, not hyphen — matches the tabular figures beside it. */
function sign(cents: number): string {
  return cents > 0 ? "+" : "−";
}

/**
 * The one line of copy explaining the ledger-vs-bank number. A missing
 * `balance-date` (SimpleFIN's `bankAsOfDate: null`) is inconclusive for a
 * different reason than a merely-stale one — there's no date to say "isn't
 * newer than" — so it gets its own wording rather than inheriting the
 * dated-and-stale message.
 */
function describeDrift(
  drift: number | null,
  freshness: BalanceFreshness | null,
): string {
  if (drift === null) return "no bank figure to compare";
  if (freshness?.state === "conclusive") {
    return drift === 0
      ? "matches the bank exactly"
      : `drift ${sign(drift)}${formatCents(Math.abs(drift))} — a row is missing or duplicated, or the starting balance is wrong`;
  }
  if (freshness?.bankAsOfDate === null) {
    return drift === 0
      ? "matches for now — SimpleFIN reported no balance date for this account, so this can't be confirmed against your ledger"
      : `differs by ${sign(drift)}${formatCents(Math.abs(drift))} — SimpleFIN reported no balance date for this account, so this can't be attributed to unreported activity or a ledger problem`;
  }
  return drift === 0
    ? `matches for now — the bank's figure isn't newer than your newest ledger row (${freshness?.ledgerAsOfDate}), so this could still be missing today's activity`
    : `differs by ${sign(drift)}${formatCents(Math.abs(drift))} — the bank's figure isn't newer than your newest ledger row (${freshness?.ledgerAsOfDate}), so some or all of this is activity it hasn't reported yet`;
}

export default function SyncPage() {
  const accounts = db.select().from(schema.accounts).all();
  const lastBatch = findLastSyncBatch();
  // A sync batch auto-categorizes through the same rule engine as a CSV
  // import, but the undo control for THAT lives on /import/success/[batchId]
  // (Red Team, /ship 2026-09-03) — this page had no link there at all, so a
  // sync batch's per-categorization undo was reachable only by guessing the
  // URL. This surfaces it instead of duplicating the undo button here.
  const revertibleCount = lastBatch
    ? countRevertibleCategorizations(db, lastBatch.batchId)
    : 0;
  const ambiguous = findAmbiguousTransfers(daysAgoIso(REVIEW_WINDOW_DAYS));
  const sameAccountReversals = findSameAccountReversalCandidates(
    daysAgoIso(REVIEW_WINDOW_DAYS),
  );

  // The two queues can legitimately claim the same row (see
  // `overlappingRowIds`). Surface that in both rather than letting either one
  // decide it silently.
  const sharedRowIds = overlappingRowIds(ambiguous, sameAccountReversals);
  const linkedPairs = findLinkedTransferPairs(daysAgoIso(REVIEW_WINDOW_DAYS));

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
    // Wraps the whole page so the status region survives the revalidate that
    // removes a resolved review bucket — see ActionFeedbackProvider.
    <ActionFeedbackProvider>
      <div className="mx-auto w-full max-w-3xl px-5 py-10 space-y-10">
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
        <ReviewQueue
          kind="transfer"
          buckets={ambiguous}
          accountsById={accountsById}
          sharedRowIds={sharedRowIds}
        />
      )}

      {/* ---- same-account reversals: a charge and its cancellation ---- */}
      {sameAccountReversals.length > 0 && (
        <ReviewQueue
          kind="reversal"
          buckets={sameAccountReversals}
          accountsById={accountsById}
          sharedRowIds={sharedRowIds}
        />
      )}

      {/* ---- linked transfers, with a way back out ---- */}
      {linkedPairs.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            Linked pairs ({linkedPairs.length})
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Paired rows are excluded from every spending view. Sync links a
            transfer on its own when the counts balance; reversals are only ever
            linked by hand. Check anything that looks like a coincidence — a
            same-day, same-amount deposit and charge that aren&apos;t actually
            two halves of one movement.
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {linkedPairs.map((pair) => (
              <li
                key={pair.a.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
              >
                <span className="font-mono [font-variant-numeric:tabular-nums]">
                  {pair.a.date} · {formatCents(Math.abs(pair.a.amountCents))}
                </span>
                {/*
                  A same-account reversal is linked through the same
                  `transfer_pair_id` column, so it lands in this list too — and
                  `A ← B` with A and B equal renders as "Checking ← Checking",
                  an arrow from an account to itself. Name the account once and
                  say what the pairing is instead.
                */}
                <span className="min-w-40 flex-1 text-muted-foreground">
                  {pair.a.accountId === pair.b.accountId ? (
                    <>
                      {accountsById.get(pair.a.accountId)?.name ??
                        pair.a.accountId}{" "}
                      · reversal
                    </>
                  ) : (
                    <>
                      {accountsById.get(pair.a.accountId)?.name ??
                        pair.a.accountId}{" "}
                      ←{" "}
                      {accountsById.get(pair.b.accountId)?.name ??
                        pair.b.accountId}
                    </>
                  )}
                  {pair.b.rawMemo ? ` · ${pair.b.rawMemo.slice(0, 40)}` : ""}
                </span>
                {/*
                  `announceSuccess` because this row is GONE on success: the
                  pair leaves `linkedPairs`, the `<li>` unmounts, and the
                  confirmation would be destroyed before it could paint —
                  leaving an unpairing that moves two rows back into every
                  spending total looking exactly like a misclick.
                */}
                <ActionForm action={unlinkTransferAction} announceSuccess>
                  <PendingFieldset>
                    <input type="hidden" name="id" value={pair.a.id} />
                    <SubmitButton
                      label={
                        pair.a.accountId === pair.b.accountId
                          ? "Not a reversal"
                          : "Not a transfer"
                      }
                      busyLabel="Unlinking…"
                      className="min-h-11 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
                    />
                  </PendingFieldset>
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- undo ---- */}
      {lastBatch && (
        <section className="space-y-3">
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Last sync</h2>
          <div className="rounded-md border border-border p-4 text-sm">
            <p className="font-medium">{lastBatch.label}</p>
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
            {revertibleCount > 0 && (
              <p className="mt-2 text-muted-foreground">
                {revertibleCount} of the {lastBatch.categorizedCount} categorised row
                {lastBatch.categorizedCount === 1 ? "" : "s"} above{" "}
                {revertibleCount === 1 ? "is" : "are"} still exactly as a trained rule left{" "}
                {revertibleCount === 1 ? "it" : "them"}.{" "}
                <Link
                  href={`/import/success/${lastBatch.batchId}`}
                  className="underline underline-offset-2 hover:no-underline"
                >
                  Review or undo just the categorization
                </Link>{" "}
                without undoing the whole sync.
              </p>
            )}
            {/*
              `announceSuccess` because this section is gated on `lastBatch`.
              When the undone batch was the only one, the whole section
              unmounts and takes the confirmation with it. When an OLDER batch
              remains it is worse: the form is unkeyed, React reuses the node,
              and "Undid the sync — removed N transactions" would render under
              a DIFFERENT batch's description, which reads as true.
            */}
            <ActionForm
              action={undoSyncAction}
              className="mt-3"
              announceSuccess
              // Keyed on the batch so the node cannot be REUSED when an older
              // batch takes its place. Without this a refusal ("undo is no
              // longer safe") stays inline — errors are deliberately not
              // republished — and, after the next sync, renders under a
              // different batch's description, where it reads as true.
              key={lastBatch.batchId}
            >
              <PendingFieldset>
                <input type="hidden" name="batchId" value={lastBatch.batchId} />
                <SubmitButton
                  label="Undo this sync"
                  busyLabel="Undoing…"
                  className="min-h-11 rounded-md border border-destructive/40 px-3 py-1 text-sm text-destructive hover:bg-destructive/10"
                />
              </PendingFieldset>
            </ActionForm>
          </div>
        </section>
      )}
      </div>
    </ActionFeedbackProvider>
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
  const ledgerByAccountId = new Map(loadAccountBalancesForRequest().map((b) => [b.id, b]));

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
                {/*
                  The flex-wrap row lives on the FIELDSET, not the form: the
                  fieldset wraps every submitted control, so leaving the layout
                  on the form would make it the single flex item and collapse
                  the row into a column. `ActionStatus` is `ActionForm`'s own
                  last child and therefore now sits below the row rather than
                  wrapping inside it.
                */}
                <ActionForm action={linkAccountAction}>
                  <PendingFieldset className="flex flex-wrap items-center gap-3">
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
                    <SubmitButton
                      label="Save"
                      busyLabel="Saving…"
                      // A disabled <select> is omitted from FormData entirely, so
                      // submitting here would fail validation and surface an error
                      // overlay rather than doing nothing. ANDed with the pending
                      // state inside `SubmitButton`, not replaced by it — the
                      // fieldset only covers "an action is in flight", never "this
                      // account has nothing to link to".
                      disabled={!host || remote.length === 0}
                      className="min-h-11 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
                    />
                  </PendingFieldset>
                </ActionForm>
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
      {/* Rendered unconditionally. This is the app's only ledger-vs-bank
          integrity display, and gating it on a successful fetch meant a bridge
          hiccup silently removed the one thing that would reveal a duplicated or
          missing row — with nothing to say it was gone. */}
      <section className="space-y-3">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Balance check</h2>
        <p className="text-sm text-muted-foreground">
          The bank&apos;s own figure against the one this ledger computes. A
          difference means a row is missing or duplicated — but only once the
          bank&apos;s figure is newer than your newest row, so its as-of time is
          shown alongside it.
        </p>
        {remote.length === 0 ? (
          <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            {!host
              ? "SimpleFIN isn't configured, so there is no bank figure to compare against."
              : "Couldn't reach the bank to compare balances, so drift can't be checked right now. Your ledger is unchanged — reload to try again."}
          </p>
        ) : (
          <>
          <ul className="divide-y divide-border rounded-md border border-border">
            {remote
              .filter((r) => r.linkedAccountId !== null)
              .map((r) => {
                const local = accountsById.get(r.linkedAccountId!);
                const ledger = ledgerByAccountId.get(r.linkedAccountId!) ?? null;
                const drift =
                  ledger && r.balanceCents !== null
                    ? ledger.balanceCents - r.balanceCents
                    : null;
                // The feed's instant collapsed to a local calendar date, so it
                // is comparable with the ledger's date-only rows.
                const bankAsOf = r.balanceDate ? new Date(r.balanceDate) : null;
                const freshness = ledger
                  ? classifyBalanceFreshness(
                      bankAsOf ? toLocalIso(bankAsOf) : null,
                      ledger.ledgerAsOfDate,
                    )
                  : null;
                return (
                  <li key={r.simplefinAccountId} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{local?.name ?? r.name}</span>
                      <span className="font-mono [font-variant-numeric:tabular-nums] text-muted-foreground">
                        <span className="text-muted-foreground">ledger</span>{" "}
                        {ledger ? formatCents(ledger.balanceCents) : "—"}
                        <span className="ml-3 text-muted-foreground">bank</span>{" "}
                        {r.balanceCents !== null ? formatCents(r.balanceCents) : "—"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <span
                        className={
                          drift === null
                            ? "text-muted-foreground"
                            : freshness?.state === "conclusive"
                              ? drift === 0
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "font-medium text-amber-700 dark:text-amber-400"
                              : // Not an alarm: the ledger isn't accused of
                                // anything until the bank figure can settle it —
                                // including a coincidental zero, which a stale
                                // figure can't actually confirm.
                                "text-muted-foreground"
                        }
                      >
                        {describeDrift(drift, freshness)}
                      </span>
                      <span className="text-muted-foreground [font-variant-numeric:tabular-nums]">
                        {r.availableBalanceCents !== null &&
                          r.availableBalanceCents !== r.balanceCents && (
                            <>available {formatCents(r.availableBalanceCents)}</>
                          )}
                        {bankAsOf && (
                          <span className="ml-3">
                            bank figure as of {formatLocalDateTime(bankAsOf)}
                          </span>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
          </ul>
          <p className="text-xs text-muted-foreground">
            Pending card holds show up as the gap between balance and available —
            Star One doesn&apos;t expose them as individual rows.
          </p>
          </>
        )}
      </section>
    </>
  );
}
