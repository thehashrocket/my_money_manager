import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — groups the whole uncategorized backlog by merchant on every render. */
export default function CategorizeLoading() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <StateCard variant="loading" title="Loading the categorize queue…" />
    </main>
  );
}
