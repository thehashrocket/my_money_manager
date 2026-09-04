import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — the dashboard reads accounts, the month view and the trend
 * chart on every render; a slow query used to flash blank. */
export default function DashboardLoading() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <StateCard variant="loading" title="Loading your dashboard…" />
    </main>
  );
}
