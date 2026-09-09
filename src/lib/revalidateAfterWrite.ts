/**
 * The ONE spelling of "this revalidation follows a COMMITTED write".
 *
 * `revalidatePath` throws. Not hypothetically — this app has hit it twice, and
 * CLAUDE.md records both. The failure it produces is specific and nasty: the
 * write is already durable, so every honest outcome is "it saved", but an
 * unguarded throw makes the action report either a refusal (when the call sits
 * inside the write's own `try`) or a route-level crash (when it sits outside).
 * Both are lies, and the second is the worse one, because every `error.tsx` in
 * this app reassures the reader that nothing was written.
 *
 *   commit ──▶ revalidatePath ──┬── ok ──▶ fresh page, plain success
 *                               │
 *                               └── throw ──┬── caught by the write's try
 *                                           │     ▶ "failed" for a write that landed
 *                                           └── uncaught
 *                                                 ▶ error.tsx: "Nothing was written"
 *
 * So the refresh is guarded ON ITS OWN, and a failure comes back as a WARNING
 * folded into the already-successful outcome. A stale page with an accurate
 * message beats a crash with a false one.
 *
 * THIS EXISTS BECAUSE FIXING ONE INSTANCE DID NOT CLOSE THE CLASS. `/sync`
 * grew `guardRefresh` first; v0.26.0 grew a second, hand-maintained copy in
 * `src/app/budget/actions.ts` for the same reason, with its own warning string
 * that had already drifted. The other six route action files had none at all —
 * 49 unguarded calls, including `confirmImportAction`, where the failure mode
 * is a committed several-hundred-row CSV import rendering `/import/error.tsx`'s
 * "Nothing was imported." That is rule 11's own lesson in a different guise, so
 * the answer is one function rather than an eighth copy.
 *
 * Deliberately NOT a `"use server"` module. Such a module may only export async
 * functions, so `REFRESH_FAILED_WARNING` living beside an action would make
 * Turbopack report "the module has no exports at all" and every importer of
 * every action in that file would fail to resolve — blanking the route, with
 * `tsc` and vitest both structurally blind to it (it is a bundler rule, not a
 * type rule). That is why the constant lives here and route files import it.
 */

/**
 * One sentence for every surface. It says the two things the reader needs — the
 * write landed, and what they see may be stale — and nothing about which page
 * or which write, so no caller has to keep a variant in sync.
 */
export const REFRESH_FAILED_WARNING =
  "Your change was saved, but this page couldn't refresh — reload to see the current state.";

/**
 * Runs a post-commit revalidation and converts a failure into a warning.
 *
 * `scope` is the route tag for the log line only (`"/accounts"`, `"/import"`).
 * It is logged as well as returned because a failing `revalidatePath` is a bug
 * in this app rather than a user error, and the returned warning is aimed at
 * someone who cannot act on it.
 *
 * Returns `undefined` on success so a caller can spread it into an outcome
 * (`{ status: "ok", warning }`) without branching. A caller that DISCARDS the
 * result makes a failed refresh silent again, which is the whole failure this
 * guards — so the return type is not `void` on purpose.
 *
 * `run` must contain revalidation ONLY. Do not put a `redirect()` inside it:
 * `redirect` signals by throwing, and this would swallow it into a warning.
 */
export function guardRefresh(scope: string, run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (err) {
    console.error(`[${scope}] revalidation failed after a committed write`, err);
    return REFRESH_FAILED_WARNING;
  }
}
