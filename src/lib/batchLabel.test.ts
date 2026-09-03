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
