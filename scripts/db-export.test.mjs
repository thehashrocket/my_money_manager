import { describe, it, expect } from "vitest";
import { evaluateSnapshotOutput } from "./db-export.mjs";

describe("evaluateSnapshotOutput", () => {
  it("refuses a degraded (consistent:false) snapshot — no file emitted", () => {
    const raw = JSON.stringify({
      snapshotPath: "/app/backups/money.db.pre-import-x",
      consistent: false,
      degradedReason: "not a database file",
    });

    const result = evaluateSnapshotOutput(raw);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("degraded to a plain copy");
    expect(result.message).toContain("not a database file");
  });

  it("refuses when snapshot-cli.mjs itself reported an error", () => {
    const raw = JSON.stringify({ error: "database file does not exist: /app/data/money.db" });

    const result = evaluateSnapshotOutput(raw);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("database file does not exist");
  });

  it("accepts a consistent snapshot and returns its container path", () => {
    const raw = JSON.stringify({
      snapshotPath: "/app/backups/money.db.pre-import-20260101T000000_000Z",
      timestamp: "20260101T000000_000Z",
      consistent: true,
      degradedReason: null,
    });

    const result = evaluateSnapshotOutput(raw);

    expect(result).toEqual({
      ok: true,
      snapshotPath: "/app/backups/money.db.pre-import-20260101T000000_000Z",
    });
  });

  it("does not throw on empty output — reports it as a failure instead", () => {
    const result = evaluateSnapshotOutput("");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no readable JSON");
  });

  it("does not throw when the last line isn't valid JSON", () => {
    const raw = 'time="2026-09-02T19:00:00Z" level=warning msg="compose deprecation notice"\n';
    const result = evaluateSnapshotOutput(raw);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no readable JSON");
  });

  it("reads only the last line — docker compose exec can prepend warnings", () => {
    const raw =
      "time=\"2026-09-02T19:00:00Z\" level=warning msg=\"some docker warning\"\n" +
      JSON.stringify({ snapshotPath: "/app/backups/x", consistent: true, degradedReason: null });

    const result = evaluateSnapshotOutput(raw);

    expect(result.ok).toBe(true);
    expect(result.snapshotPath).toBe("/app/backups/x");
  });
});
