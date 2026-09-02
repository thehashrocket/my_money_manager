import { describe, it, expect } from "vitest";
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
    expect(creds.authHeader).toBe(
      `Basic ${Buffer.from("alice:p@ss:word").toString("base64")}`,
    );
  });
});
