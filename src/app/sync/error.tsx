"use client";

/**
 * Backstop for the /sync route.
 *
 * The actions in ./actions.ts return their failures as state rather than
 * throwing, so this should not fire in normal use. It exists because without
 * any boundary on this route an unexpected throw — a locked database, a native
 * binding mismatch after a Node switch — replaced the entire page with the dev
 * crash overlay, taking the undo button and the balance check with it. Undo is
 * the recovery path for a bad sync, so it is the last thing that should vanish
 * when something goes wrong.
 */
export default function SyncError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 space-y-4">
      <h1 className="font-display text-xl font-semibold">Sync hit an error</h1>
      <p className="text-sm text-muted-foreground">
        Nothing was imported. Your ledger is unchanged — every sync snapshots the
        database before it writes, and writes happen in a single transaction.
      </p>
      <pre className="overflow-x-auto rounded-md border border-border p-3 text-xs">
        {error.message}
      </pre>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try again
        </button>
        <a
          href="/sync"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium"
        >
          Reload the page
        </a>
      </div>
    </div>
  );
}
