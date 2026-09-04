import { StateCard } from "@/components/ledger/state-card";

/**
 * DS34: `loadMonthView` is the app's heaviest read (six-to-eight queries).
 * Every other route already flashed blank on a slow query; this is the one
 * PR1b restyles, so it's the one that stops flashing blank in the same
 * merge rather than waiting for T17c to sweep the rest.
 */
export default function BudgetMonthLoading() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <StateCard variant="loading" title="Loading your budget…" />
    </main>
  );
}
