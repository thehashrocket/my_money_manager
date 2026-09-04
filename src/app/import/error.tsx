"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/** DS47/E10 — `/import` had no error boundary. */
export default function ImportError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <RouteErrorCard
        title="Something went wrong loading the import page"
        reassurance={
          <p>
            Nothing was imported. Every import snapshots the database before it writes, and commits happen
            in a single transaction.
          </p>
        }
        error={error}
        reset={reset}
      />
    </main>
  );
}
