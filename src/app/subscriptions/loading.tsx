import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — `/subscriptions` had no loading boundary. */
export default function SubscriptionsLoading() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <StateCard variant="loading" title="Loading your subscriptions…" />
    </main>
  );
}
