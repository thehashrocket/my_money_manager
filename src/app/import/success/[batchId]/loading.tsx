import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — `/import/success/[batchId]` had no loading boundary. */
export default function ImportSuccessLoading() {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <StateCard variant="loading" title="Loading the import result…" />
    </main>
  );
}
