/**
 * The SimpleFIN access URL embeds Basic Auth credentials
 * (https://user:pass@host/path). It is a long-lived bearer credential, so it
 * lives in .env.local (gitignored) and is never logged, echoed, or returned to
 * the browser — only `host` is ever safe to display.
 */
/**
 * Wrapper for a value that must never be logged, serialized or returned to the
 * browser. Reading it requires an explicit, greppable `.expose()`.
 *
 * The rule this enforces used to live only in the comment above: in a Next.js
 * Server Action codebase "accidentally returned to the browser" is one careless
 * `return creds` away, and a plain string would be happily serialized by
 * JSON.stringify, by a console.log, or by an error-reporting payload. All three
 * now print [redacted] instead of a live bank credential.
 */
export class Secret {
  constructor(private readonly value: string) {}
  expose(): string {
    return this.value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

export type SimpleFinCredentials = {
  /** Origin + path only — derived from the same URL but carries no secret. */
  accountsEndpoint: string;
  authHeader: Secret;
  /** The one field that is safe to display. */
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

  // A bare "%" in the credential makes decodeURIComponent throw a URIError,
  // which would escape as an unhandled crash instead of landing in the page's
  // config-error banner like every other bad-credential case here.
  let user: string;
  let pass: string;
  try {
    user = decodeURIComponent(url.username);
    pass = decodeURIComponent(url.password);
  } catch {
    throw new SimpleFinConfigError(
      "SIMPLEFIN_ACCESS_URL has malformed percent-encoding in its credentials. Re-run `pnpm simplefin:claim` with a fresh setup token.",
    );
  }

  return {
    accountsEndpoint: `${url.origin}${url.pathname.replace(/\/$/, "")}/accounts`,
    authHeader: new Secret(
      `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
    ),
    host: url.host,
  };
}
