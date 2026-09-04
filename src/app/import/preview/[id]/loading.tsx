import { StateCard } from "@/components/ledger/state-card";

/** DS47/E10 — the preview parses and dedup-checks the whole CSV before rendering. */
export default function ImportPreviewLoading() {
  return (
    <main className="mx-auto max-w-6xl p-6">
      <StateCard variant="loading" title="Loading the import preview…" />
    </main>
  );
}
