"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/**
 * DS47/E10 — `/` had no error boundary; a thrown error fell through to
 * Next's default crash overlay instead of this route's own surface.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <RouteErrorCard title="Something went wrong loading your dashboard" error={error} reset={reset} />
    </main>
  );
}
