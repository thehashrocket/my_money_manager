import type { SimpleFinCredentials } from "./accessUrl";
import type { SimpleFinResponse } from "./types";

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

  let res: Response;
  try {
    res = await fetch(url, {
      // Credentials go in a header, never inline in the URL, so they cannot
      // leak into a redirect target or a server log line.
      headers: { Authorization: creds.authHeader },
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (cause) {
    throw new SimpleFinFetchError(
      `Could not reach ${creds.host}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const body = await res.text();
  if (!res.ok) {
    throw new SimpleFinFetchError(
      res.status === 403
        ? "SimpleFIN rejected the credentials (403). The access URL may have been revoked."
        : `SimpleFIN returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      res.status,
    );
  }

  try {
    return JSON.parse(body) as SimpleFinResponse;
  } catch {
    throw new SimpleFinFetchError("SimpleFIN returned a non-JSON response.");
  }
}
