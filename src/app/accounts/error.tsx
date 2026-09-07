"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/**
 * T36 / E19 — the reassurance names the mechanism that actually exists.
 *
 * DS54-57 originally justified using this slot on the grounds that
 * `/accounts` "writes anchors behind rule 5's snapshot guarantee." That was
 * verified FALSE: `createSnapshot` has exactly two production callers,
 * `importBatch.ts` and `sync.ts`, and no anchor write is one of them. A
 * reassurance shown at the moment something broke must not itself be untrue.
 *
 * What is real is the prior anchor: every balance change on this route
 * persists the previous balance and date onto the account row
 * (`prior_starting_balance_cents`/`_date`), so the change is one reconcile
 * away from being reversed. A whole-database VACUUM INTO before a reversible
 * single-column update was considered and rejected as over-engineering that
 * would also churn the retention-of-10 snapshot pool.
 */
export default function AccountsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <RouteErrorCard
        title="Something went wrong loading your accounts"
        reassurance={
          <p>
            Your transactions are untouched. If a balance was being updated, the
            previous balance and date are kept, so the change is one step to
            reverse.
          </p>
        }
        error={error}
        reset={reset}
      />
    </main>
  );
}
