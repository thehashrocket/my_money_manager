import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — `/goals` had no loading boundary. */
export default function GoalsLoading() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <StateCard variant="loading" title="Loading your goals…" />
    </main>
  );
}
