/**
 * `import_batches.label` is null for sync batches — there's no file, so
 * nothing meaningful to store. This derives the display string instead of
 * persisting a synthetic one.
 */
export function deriveBatchLabel(
  source: "csv" | "simplefin",
  importedAt: Date,
): string {
  const stamp = importedAt.toISOString().slice(0, 16).replace("T", " ");
  return source === "simplefin" ? `SimpleFIN sync — ${stamp}Z` : `CSV import — ${stamp}Z`;
}

/** The `label ?? deriveBatchLabel(...)` fallback, in one place for every render site. */
export function resolveBatchLabel(batch: {
  label: string | null;
  source: "csv" | "simplefin";
  importedAt: Date;
}): string {
  return batch.label ?? deriveBatchLabel(batch.source, batch.importedAt);
}
