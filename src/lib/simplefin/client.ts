import type { SimpleFinCredentials } from "./accessUrl";
import { simpleFinResponseSchema, type SimpleFinResponse } from "./types";

export class SimpleFinFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SimpleFinFetchError";
  }
}

export type FetchOptions = {
  /** Unix seconds. The API hard-caps the window at 90 days regardless. */
  startDate: number;
  /** SimpleFIN account ids to request. Omit to get everything on the token. */
  accountIds?: string[];
  /** Skip transaction retrieval — used when only listing accounts to link. */
  balancesOnly?: boolean;
  signal?: AbortSignal;
};

export async function fetchAccounts(
  creds: SimpleFinCredentials,
  opts: FetchOptions,
): Promise<SimpleFinResponse> {
  const url = new URL(creds.accountsEndpoint);
  url.searchParams.set("start-date", String(Math.floor(opts.startDate)));
  for (const id of opts.accountIds ?? []) url.searchParams.append("account", id);
  if (opts.balancesOnly) url.searchParams.set("balances-only", "1");

  // fetch() resolves as soon as the headers arrive, so reading the body is a
  // second place the connection can drop or the deadline can expire — and for a
  // 45-day first sync over a slow link, a timeout during the body read is the
  // likelier path. Both are wrapped, or the caller sees a bare "terminated"
  // with no mention of SimpleFIN or the host.
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, {
      // Credentials go in a header, never inline in the URL, so they cannot
      // leak into a redirect target or a server log line.
      headers: { Authorization: creds.authHeader.expose() },
      signal: opts.signal,
      cache: "no-store",
    });
    body = await res.text();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new SimpleFinFetchError(
      cause instanceof Error && cause.name === "TimeoutError"
        ? `${creds.host} did not respond in time (${detail}). A first sync pulls up to 45 days — try again, or import that history from CSV.`
        : `Could not reach ${creds.host}: ${detail}`,
    );
  }
  if (!res.ok) {
    throw new SimpleFinFetchError(
      res.status === 403
        ? "SimpleFIN rejected the credentials (403). The access URL may have been revoked."
        : `SimpleFIN returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      res.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SimpleFinFetchError("SimpleFIN returned a non-JSON response.");
  }

  // Validate rather than cast. This is the only untrusted input in the app, and
  // an unchecked cast would let a shape change through as `undefined` fields
  // that the downstream `?? []` fallbacks silently read as "no accounts, no
  // transactions" — reporting a clean "up to date" while importing nothing.
  const result = simpleFinResponseSchema.safeParse(parsed);
  if (!result.success) {
    const where = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new SimpleFinFetchError(
      `SimpleFIN returned an unexpected response shape — ${where}`,
    );
  }
  return result.data;
}
