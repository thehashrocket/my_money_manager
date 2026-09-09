import { unstable_rethrow } from "next/navigation";

/**
 * The ONE spelling of "this READ follows a COMMITTED write".
 *
 * The sibling of `guardRefresh` (`@/lib/revalidateAfterWrite`), and it exists
 * for the same reason that one does: PAST THE COMMIT, nothing may turn the
 * outcome into a failure. `guardRefresh` covers the write path's revalidation;
 * this covers the lookups a write path does afterwards purely to describe what
 * it did — the category NAME behind an id, which is the only fact the user can
 * act on and the only one the client cannot resolve for itself.
 *
 * `SQLITE_BUSY` is a live class in this app, not a hypothetical: WAL mode,
 * `createSnapshot`'s `VACUUM INTO` and `pnpm db:export` all hold readers, and
 * the driver is synchronous. So a post-commit read CAN throw, and when it did
 * the whole Server Action rejected:
 *
 *   commit ──▶ describe it ──┬── ok ────▶ "Filed 12 rows to Groceries"
 *                            │
 *                            └── throw ─▶ the action REJECTS
 *                                          ▶ client catch: "Categorize failed."
 *                                          ▶ the undo snapshot never ships
 *
 * That second branch is the destructive one, and specifically because of rule
 * 6: the write it is denying may have DELETED a hand-trained `category_rules`
 * row, whose only surviving copy is `snapshot.priorRule` in the value being
 * thrown away. There is no rules-management surface in this app, so the rule
 * is then unrecoverable — while the user is told nothing happened.
 *
 * A read we cannot complete therefore degrades to the caller's `fallback` (a
 * bare id where a name would have gone) and the write is still reported as
 * what it is. It is logged rather than swallowed: a failing post-commit read
 * is an operational fact about this machine, and the degraded sentence is
 * aimed at someone who cannot act on it.
 *
 * `run` should contain a read only. `unstable_rethrow` is belt-and-braces for
 * the same reason it is in `guardRefresh` — `redirect()` and `notFound()`
 * signal by THROWING, so a bare catch would swallow a navigation and hand back
 * a fallback value instead. No caller here redirects today; rule 11's point is
 * that a property defended only by prose is one waiting to be refactored away.
 */
export function guardPostCommitRead<T>(
  scope: string,
  read: () => T,
  fallback: T,
): T {
  try {
    return read();
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      `[${scope}] a read after a committed write failed; degrading the message`,
      err,
    );
    return fallback;
  }
}
