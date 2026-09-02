import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchAccounts, SimpleFinFetchError } from "./client";
import type { SimpleFinCredentials } from "./accessUrl";

/**
 * Every case here runs against a stubbed global fetch — no network, no
 * SIMPLEFIN_ACCESS_URL.
 */
const CREDS: SimpleFinCredentials = {
  accountsEndpoint: "https://bridge.simplefin.org/simplefin/accounts",
  authHeader: "Basic YWxpY2U6c2VjcmV0",
  host: "bridge.simplefin.org",
};

function respond(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function stubFetch(impl: () => Promise<Response>) {
  const mock = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>(
    () => impl(),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAccounts", () => {
  it("builds the query the bridge expects and keeps credentials in the header", async () => {
    const mock = stubFetch(async () => respond('{"accounts":[]}'));

    await fetchAccounts(CREDS, {
      // Fractional seconds must floor — the API rejects a decimal start-date.
      startDate: 1788264000.9,
      accountIds: ["ACT-1", "ACT-2"],
      balancesOnly: true,
    });

    const [target, init] = mock.mock.calls[0];
    const url = new URL(String(target));
    expect(url.pathname).toBe("/simplefin/accounts");
    expect(url.searchParams.get("start-date")).toBe("1788264000");
    expect(url.searchParams.getAll("account")).toEqual(["ACT-1", "ACT-2"]);
    expect(url.searchParams.get("balances-only")).toBe("1");
    // Not inline in the URL, so it cannot leak into a redirect or a log line.
    expect(url.username).toBe("");
    expect(String(target)).not.toContain(CREDS.authHeader);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      CREDS.authHeader,
    );
    expect(init?.cache).toBe("no-store");
  });

  it("omits account and balances-only params when they were not asked for", async () => {
    const mock = stubFetch(async () => respond('{"accounts":[]}'));

    await fetchAccounts(CREDS, { startDate: 1788264000 });

    const url = new URL(String(mock.mock.calls[0][0]));
    expect(url.searchParams.getAll("account")).toEqual([]);
    expect(url.searchParams.has("balances-only")).toBe(false);
  });

  it("names a revoked access URL specifically on 403", async () => {
    stubFetch(async () => respond("Forbidden", 403));

    await expect(fetchAccounts(CREDS, { startDate: 0 })).rejects.toThrow(
      /access URL may have been revoked/,
    );
    await expect(fetchAccounts(CREDS, { startDate: 0 })).rejects.toMatchObject({
      name: "SimpleFinFetchError",
      status: 403,
    });
  });

  it("surfaces the status and a bounded slice of the body on any other error", async () => {
    stubFetch(async () => respond("x".repeat(500), 500));

    const err = await fetchAccounts(CREDS, { startDate: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(SimpleFinFetchError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("HTTP 500");
    // The body is truncated so a giant HTML error page cannot flood the UI.
    expect(err.message.length).toBeLessThan(300);
  });

  it("distinguishes an unreachable host from a 200 that isn't JSON", async () => {
    stubFetch(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND");
    });
    await expect(fetchAccounts(CREDS, { startDate: 0 })).rejects.toThrow(
      /Could not reach bridge\.simplefin\.org: getaddrinfo ENOTFOUND/,
    );

    vi.unstubAllGlobals();
    stubFetch(async () => respond("<html>maintenance</html>"));
    await expect(fetchAccounts(CREDS, { startDate: 0 })).rejects.toThrow(
      /non-JSON response/,
    );
  });
});
