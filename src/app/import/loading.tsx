import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — `/import` had no loading boundary. */
export default function ImportLoading() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <StateCard variant="loading" title="Loading the import page…" />
    </main>
  );
}
