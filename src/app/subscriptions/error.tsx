"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/** DS47/E10 — `/subscriptions` had no error boundary. */
export default function SubscriptionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <RouteErrorCard title="Something went wrong loading your subscriptions" error={error} reset={reset} />
    </main>
  );
}
