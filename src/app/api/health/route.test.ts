import { describe, it, expect, vi, afterEach } from "vitest";

// `await connection()` (added for cache-components-migration, Stage 0) throws
// "called outside a request scope" when the route's GET is invoked directly
// in a Vitest process rather than through Next's real App Router request
// handling — there is no request-scoped AsyncLocalStorage here to read.
// Mocked to a no-op resolved promise so these tests keep exercising the
// actual behavior under test (the DB-error-to-generic-503 mapping), not
// Next's own request-scope machinery.
//
// `vi.fn()`, not a bare arrow function: `await connection()` is the whole
// reason this route no longer silently freezes `{ok:true}` at build time
// (see route.ts's own comment) — a `pnpm build` route-table check is what
// actually proves static-vs-dynamic, but that only runs at ship time. A bare
// no-op mock would let every test here keep passing even if a future edit
// deleted the `await connection()` call entirely; the assertion below is the
// unit-test-level guard for that regression (pre-landing review, testing
// specialist).
const connectionMock = vi.fn(async () => {});
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: connectionMock };
});

describe("/api/health", () => {
  afterEach(() => {
    vi.doUnmock("@/db");
    vi.resetModules();
    connectionMock.mockClear();
  });

  // Dynamic import under a full parallel test-suite run can exceed vitest's
  // 5s default (observed flaky; instant standalone) — see the matching note
  // in src/db/migration0010.test.ts.
  it("returns 200 { ok: true } when the DB responds", async () => {
    vi.doMock("@/db", () => ({ db: { get: () => ({ "1": 1 }) } }));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Regression guard: `await connection()` is what stops this route
    // freezing static under Cache Components (route.ts's own comment).
    expect(connectionMock).toHaveBeenCalledTimes(1);
  }, 15_000);

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
