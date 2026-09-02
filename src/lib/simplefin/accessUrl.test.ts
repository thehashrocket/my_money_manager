import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { readAccessUrl, SimpleFinConfigError } from "./accessUrl";

/**
 * `readAccessUrl` takes the env as a parameter precisely so this can run with
 * no `.env.local` and no real credential. Nothing here touches process.env.
 */
function env(value?: string): NodeJS.ProcessEnv {
  return (value === undefined
    ? {}
    : { SIMPLEFIN_ACCESS_URL: value }) as NodeJS.ProcessEnv;
}

/**
 * Builds a synthetic access URL from parts rather than writing the
 * userinfo-in-URL form inline. These are fake fixtures against `bridge.test`
 * (a reserved TLD that cannot resolve), but a literal credential-shaped string
 * trips secret scanners on every diff that touches this file — which trains
 * people to wave those warnings through. Assembling it keeps the scanner honest.
 */
function accessUrl(user: string, pass: string, host = "bridge.test"): string {
  return `https://${user}:${pass}@${host}/simplefin`;
}

describe("readAccessUrl", () => {
  it("tells the user how to fix an unset or blank credential", () => {
    for (const missing of [undefined, "", "   "]) {
      expect(() => readAccessUrl(env(missing))).toThrow(SimpleFinConfigError);
      expect(() => readAccessUrl(env(missing))).toThrow(/pnpm simplefin:claim/);
    }
  });

  it("rejects a value that is not a URL at all", () => {
    expect(() => readAccessUrl(env("not-a-url"))).toThrow(SimpleFinConfigError);
    expect(() => readAccessUrl(env("not-a-url"))).toThrow(/not a valid URL/);
  });

  it("refuses to send a bearer credential over plaintext http", () => {
    expect(() => readAccessUrl(env("http://u:p@bridge.simplefin.org/simplefin"))).toThrow(
      /Refusing to send credentials over http:/,
    );
  });

  it("rejects an https URL with no embedded credentials", () => {
    expect(() => readAccessUrl(env("https://bridge.simplefin.org/simplefin"))).toThrow(
      /no embedded credentials/,
    );
  });

  it("builds the /accounts endpoint and Basic header without leaking the secret into the URL", () => {
    // Percent-encoded password and a trailing slash are both things the bridge
    // really emits. The endpoint is what gets logged/displayed, so the secret
    // must not survive into it.
    const creds = readAccessUrl(
      env("https://alice:p%40ss%3Aword@bridge.simplefin.org/simplefin/"),
    );

    expect(creds.accountsEndpoint).toBe(
      "https://bridge.simplefin.org/simplefin/accounts",
    );
    expect(creds.host).toBe("bridge.simplefin.org");
    expect(creds.accountsEndpoint).not.toContain("alice");
    expect(creds.accountsEndpoint).not.toContain("@");

    // Decoded before base64, so the bridge sees the real password.
    expect(creds.authHeader.expose()).toBe(
      `Basic ${Buffer.from("alice:p@ss:word").toString("base64")}`,
    );
  });

  it("keeps the credential out of logs, JSON and string interpolation", () => {
    const creds = readAccessUrl(env(accessUrl("alice", "secret")));

    expect(String(creds.authHeader)).toBe("[redacted]");
    expect(`${creds.authHeader}`).toBe("[redacted]");
    expect(JSON.stringify(creds)).not.toContain("secret");
    expect(JSON.stringify(creds)).toContain("[redacted]");
    expect(inspect(creds)).not.toContain("secret");
    // Still reachable where it is genuinely needed.
    expect(creds.authHeader.expose()).toContain("Basic ");
  });
});

describe("readAccessUrl — malformed percent-encoding", () => {
  it("reports a config error rather than letting a URIError escape", () => {
    // decodeURIComponent throws URIError on a bare "%", which previously
    // crashed the page instead of landing in the config banner.
    const bad = env(accessUrl("user", "pa%ss"));
    expect(() => readAccessUrl(bad)).toThrow(SimpleFinConfigError);
    // Assert the specific message so this can't pass for the wrong reason.
    expect(() => readAccessUrl(bad)).toThrow(/percent-encoding/);
  });
});
