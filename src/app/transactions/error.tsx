"use client";

import { StateCard } from "@/components/ledger/state-card";
import { Button } from "@/components/ui/button";

/** DS47/E10 — `/transactions` had no error boundary. */
export default function TransactionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <StateCard
        variant="error"
        title="Something went wrong loading your transactions"
        description={
          <pre className="mt-1 overflow-x-auto rounded-md bg-[var(--bg-inset)] p-3 text-left text-xs text-ink-2">
            {error.message}
          </pre>
        }
        primaryAction={
          <Button type="button" variant="primary" onClick={reset}>
            Try again
          </Button>
        }
      />
    </main>
  );
}
