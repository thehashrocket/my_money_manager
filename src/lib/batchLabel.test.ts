import { describe, expect, it } from "vitest";
import { deriveBatchLabel, resolveBatchLabel } from "./batchLabel";

describe("deriveBatchLabel", () => {
  it("labels a sync batch with the sync timestamp", () => {
    const label = deriveBatchLabel("simplefin", new Date("2026-09-02T17:00:00Z"));
    expect(label).toBe("SimpleFIN sync — 2026-09-02 17:00Z");
  });

  it("labels a csv batch with the import timestamp as a fallback", () => {
    const label = deriveBatchLabel("csv", new Date("2026-09-02T17:00:00Z"));
    expect(label).toBe("CSV import — 2026-09-02 17:00Z");
  });
});

describe("resolveBatchLabel", () => {
  it("prefers the stored label when present", () => {
    const label = resolveBatchLabel({
      label: "starone.csv",
      source: "csv",
      importedAt: new Date("2026-09-02T17:00:00Z"),
    });
    expect(label).toBe("starone.csv");
  });

  it("derives a label when none is stored", () => {
    const label = resolveBatchLabel({
      label: null,
      source: "simplefin",
      importedAt: new Date("2026-09-02T17:00:00Z"),
    });
    expect(label).toBe("SimpleFIN sync — 2026-09-02 17:00Z");
  });
});
