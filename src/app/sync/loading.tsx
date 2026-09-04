import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — `/sync` has an `error.tsx` (the app's oldest boundary) but no
 * `loading.tsx` — E10's count correction: the route glob this task started
 * from was short exactly this one file. */
export default function SyncLoading() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <StateCard variant="loading" title="Loading your sync status…" />
    </main>
  );
}
