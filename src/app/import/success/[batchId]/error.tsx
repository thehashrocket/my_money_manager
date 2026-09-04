"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/** DS47/E10 — `/import/success/[batchId]` had no error boundary. */
export default function ImportSuccessError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <RouteErrorCard
        title="Something went wrong loading the import result"
        reassurance={
          <p>
            Your import already ran — this page only failed to render its summary. Check{" "}
            <a href="/transactions" className="underline underline-offset-4">
              /transactions
            </a>{" "}
            for what landed, or re-open this page from{" "}
            <a href="/import" className="underline underline-offset-4">
              /import
            </a>
            .
          </p>
        }
        error={error}
        reset={reset}
      />
    </main>
  );
}
