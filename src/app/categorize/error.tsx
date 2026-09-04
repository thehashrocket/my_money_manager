"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/** DS47/E10 — `/categorize` had no error boundary. */
export default function CategorizeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <RouteErrorCard title="Something went wrong loading the categorize queue" error={error} reset={reset} />
    </main>
  );
}
