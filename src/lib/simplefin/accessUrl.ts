/**
 * The SimpleFIN access URL embeds Basic Auth credentials
 * (https://user:pass@host/path). It is a long-lived bearer credential, so it
 * lives in .env.local (gitignored) and is never logged, echoed, or returned to
 * the browser — only `host` is ever safe to display.
 */
export type SimpleFinCredentials = {
  accountsEndpoint: string;
  authHeader: string;
  host: string;
};

export class SimpleFinConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimpleFinConfigError";
  }
}

export function readAccessUrl(
  env: NodeJS.ProcessEnv = process.env,
): SimpleFinCredentials {
  const raw = env.SIMPLEFIN_ACCESS_URL?.trim();
  if (!raw) {
    throw new SimpleFinConfigError(
      "SIMPLEFIN_ACCESS_URL is not set. Run `pnpm simplefin:claim` with your setup token.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SimpleFinConfigError("SIMPLEFIN_ACCESS_URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new SimpleFinConfigError(
      `Refusing to send credentials over ${url.protocol} — expected https.`,
    );
  }
  if (!url.username) {
    throw new SimpleFinConfigError(
      "SIMPLEFIN_ACCESS_URL has no embedded credentials.",
    );
  }

  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);

  return {
    accountsEndpoint: `${url.origin}${url.pathname.replace(/\/$/, "")}/accounts`,
    authHeader: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
    host: url.host,
  };
}
