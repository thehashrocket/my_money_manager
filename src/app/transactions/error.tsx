"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

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
      <RouteErrorCard title="Something went wrong loading your transactions" error={error} reset={reset} />
    </main>
  );
}
