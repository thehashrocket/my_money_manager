import { StateCard } from "@/components/ledger/state-card";

export default function AccountsLoading() {
  return (
    <main className="mx-auto max-w-3xl p-5">
      <StateCard variant="loading" title="Loading your accounts…" />
    </main>
  );
}
