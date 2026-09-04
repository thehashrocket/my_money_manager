"use client";

import { RouteErrorCard } from "@/app/_components/RouteErrorCard";

/** DS47/E10 — `/import/preview/[id]` had no error boundary. */
export default function ImportPreviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-6xl p-6">
      <RouteErrorCard
        title="Something went wrong loading the import preview"
        reassurance={
          <p>
            Nothing was written — a preview is read-only. Committing the import (a separate step) is the
            only action that writes rows, and it snapshots the database first.
          </p>
        }
        error={error}
        reset={reset}
      />
    </main>
  );
}
