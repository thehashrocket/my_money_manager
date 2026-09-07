import { describe, expect, it } from "vitest";
import { deriveBatchLabel, resolveBatchLabel } from "./batchLabel";

// The label renders in the runner's local time zone (see batchLabel.ts), so
// assertions build their expectation the same way rather than hardcoding a
// zone-specific string — otherwise these would pass on one machine and fail
// on another (or in CI) depending on its default TZ.
const STAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const WHEN = new Date("2026-09-02T17:00:00Z");
const STAMP = STAMP_FORMAT.format(WHEN);

describe("deriveBatchLabel", () => {
  it("labels a sync batch with the sync timestamp", () => {
    const label = deriveBatchLabel("simplefin", WHEN);
    expect(label).toBe(`SimpleFIN sync — ${STAMP}`);
  });

  it("labels a csv batch with the import timestamp as a fallback", () => {
    const label = deriveBatchLabel("csv", WHEN);
    expect(label).toBe(`CSV import — ${STAMP}`);
  });

  it("throws rather than mislabeling an unrecognized source", () => {
    // source has no DB-level CHECK constraint, so a bad manual edit or a
    // future third source can reach this function with neither "csv" nor
    // "simplefin" — this must fail loud, not render a wrong-but-plausible
    // label.
    expect(() =>
      deriveBatchLabel("bogus" as unknown as "csv" | "simplefin", WHEN),
    ).toThrow(/unrecognized/i);
  });
});

describe("resolveBatchLabel", () => {
  it("prefers the stored label when present", () => {
    const label = resolveBatchLabel({
      label: "starone.csv",
      source: "csv",
      importedAt: WHEN,
    });
    expect(label).toBe("starone.csv");
  });

  it("derives a label when none is stored", () => {
    const label = resolveBatchLabel({
      label: null,
      source: "simplefin",
      importedAt: WHEN,
    });
    expect(label).toBe(`SimpleFIN sync — ${STAMP}`);
  });

  it("derives a label when the stored one is an empty string", () => {
    // Reachable via a malformed upload with an empty file.name — `label ??`
    // alone treats "" as present since it isn't nullish, which would render
    // a blank label instead of falling through.
    const label = resolveBatchLabel({
      label: "",
      source: "csv",
      importedAt: WHEN,
    });
    expect(label).toBe(`CSV import — ${STAMP}`);
  });

  it("derives a label when the stored one is whitespace-only", () => {
    const label = resolveBatchLabel({
      label: "   ",
      source: "csv",
      importedAt: WHEN,
    });
    expect(label).toBe(`CSV import — ${STAMP}`);
  });
});

describe("'manual' source (migration 0018, F7)", () => {
  it("renders a label instead of throwing", () => {
    // Failure mode F7. Before migration 0018 taught this switch about
    // 'manual', the `never` exhaustiveness check at the bottom of
    // deriveBatchLabel threw on any other value — so the first hand-entered
    // card charge would have crashed every batch-label render in the app,
    // including /sync's and /import/success's, neither of which has anything
    // to do with manual entry.
    expect(deriveBatchLabel("manual", WHEN)).toBe(`Manual entry — ${STAMP}`);
  });

  it("derives through resolveBatchLabel, since a manual batch stores no label", () => {
    expect(resolveBatchLabel({ label: null, source: "manual", importedAt: WHEN })).toBe(
      `Manual entry — ${STAMP}`,
    );
  });

  it("still throws on a source that is not in the enum at all", () => {
    // The column has no CHECK constraint, so a corrupted row is reachable and
    // this throw is live code, not a formality.
    expect(() =>
      // @ts-expect-error guarding the runtime boundary, not the type
      deriveBatchLabel("wire-transfer", WHEN),
    ).toThrow(/unrecognized import_batches.source/);
  });
});
