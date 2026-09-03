/**
 * `import_batches.label` is null for sync batches — there's no file, so
 * nothing meaningful to store. This derives the display string instead of
 * persisting a synthetic one.
 *
 * `source` has no DB-level CHECK constraint (the enum is TypeScript-only), so
 * this throws on anything else rather than silently rendering a plausible
 * but wrong label ("CSV import" for a row that isn't actually a CSV batch) —
 * that would mask a real data-integrity problem instead of surfacing it.
 */
const STAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function deriveBatchLabel(
  source: "csv" | "simplefin",
  importedAt: Date,
): string {
  // Local time, not UTC: this string is computed at render time (not stored,
  // see below), so nothing depends on the literal UTC form the way it might
  // if it were persisted — a local reading is just easier for the one user
  // of this app to place on their own clock.
  const stamp = STAMP_FORMAT.format(importedAt);
  switch (source) {
    case "simplefin":
      return `SimpleFIN sync — ${stamp}`;
    case "csv":
      return `CSV import — ${stamp}`;
    default: {
      const unreachable: never = source;
      throw new Error(`deriveBatchLabel: unrecognized import_batches.source ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The `label ?? deriveBatchLabel(...)` fallback, in one place for every
 * render site — centralized so `/sync`, `/import/success`, and any future
 * render site can't independently forget the empty-label check.
 *
 * Treats a blank string the same as null: `label` is nullable specifically
 * because sync batches have nothing to store, but an empty `file.name` on a
 * CSV upload would otherwise slip past `?? ` (it's not nullish) and render a
 * blank label instead of falling through to a derived one.
 */
export function resolveBatchLabel(batch: {
  label: string | null;
  source: "csv" | "simplefin";
  importedAt: Date;
}): string {
  return batch.label && batch.label.trim() !== ""
    ? batch.label
    : deriveBatchLabel(batch.source, batch.importedAt);
}
