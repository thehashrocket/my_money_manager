import { describe, it, expect, vi, afterEach } from "vitest";

describe("/api/health", () => {
  afterEach(() => {
    vi.doUnmock("@/db");
    vi.resetModules();
  });

  it("returns 200 { ok: true } when the DB responds", async () => {
    vi.doMock("@/db", () => ({ db: { get: () => ({ "1": 1 }) } }));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 503 with a generic error — the raw driver message is never returned to the caller", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("@/db", () => ({
      db: {
        get: () => {
          throw new Error("database disk image is malformed at /app/data/money.db");
        },
      },
    }));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "database unavailable" });
    expect(body.error).not.toContain("/app/data");

    // The real error still reaches the server logs — just not the response.
    expect(consoleError).toHaveBeenCalledWith(
      "Health check failed:",
      expect.objectContaining({ message: expect.stringContaining("malformed") }),
    );
    consoleError.mockRestore();
  });

  it("returns the same generic 503 shape when the DB throws a non-Error value", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("@/db", () => ({
      db: {
        get: () => {
          throw "disk full";
        },
      },
    }));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "database unavailable" });
    consoleError.mockRestore();
  });
});
