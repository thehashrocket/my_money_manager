import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — `/transactions` had no loading boundary. */
export default function TransactionsLoading() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <StateCard variant="loading" title="Loading your transactions…" />
    </main>
  );
}
