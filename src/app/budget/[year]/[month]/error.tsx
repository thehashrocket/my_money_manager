"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/**
 * A7 — this route had no error boundary; `src/app/sync/error.tsx` was the
 * only one in the app. `upsertBudgetAllocationAction` still throws (its
 * signature predates this merge), and `setCategoryKindAction` returns state
 * for the failures reachable from ordinary use (DS32) but can still throw on
 * something genuinely unexpected — this is the backstop for both.
 */
export default function BudgetMonthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <RouteErrorCard
        title="Something went wrong loading your budget"
        reassurance={
          <p>
            Nothing was written that you didn&apos;t already ask for — every allocation is its own database
            write, not a batch that could be half-applied.
          </p>
        }
        error={error}
        reset={reset}
      />
    </main>
  );
}
