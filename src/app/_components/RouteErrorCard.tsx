import { StateCard } from "@/components/ledger/state-card";
import { Button } from "@/components/ui/button";

/**
 * Shared shell for every route's `error.tsx` boundary. Two things every
 * ad-hoc copy of this card kept losing: `error.digest` (in a production
 * build, Server Component error messages are redacted to a generic string —
 * the digest is the only thing left to correlate against server logs), and
 * a route-specific `reassurance` slot so only routes with a real snapshot-
 * before-write guarantee (CLAUDE.md rule 5) claim one.
 */
export function RouteErrorCard({
  title,
  reassurance,
  error,
  reset,
}: {
  title: string;
  reassurance?: React.ReactNode;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <StateCard
      variant="error"
      title={title}
      description={
        <>
          {reassurance}
          <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--bg-inset)] p-3 text-left text-xs text-ink-2">
            {error.message}
            {error.digest ? `\nRef: ${error.digest}` : null}
          </pre>
        </>
      }
      primaryAction={
        <Button type="button" variant="primary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
