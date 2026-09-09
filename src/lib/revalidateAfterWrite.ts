import { unstable_rethrow } from "next/navigation";
import { REFRESH_FAILED_WARNING } from "./refreshWarning";

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
 * functions, so a guard living beside an action would make Turbopack report
 * "the module has no exports at all" and every importer of every action in that
 * file would fail to resolve — blanking the route, with `tsc` and vitest both
 * structurally blind to it (it is a bundler rule, not a type rule).
 *
 * This module is no longer import-free — `unstable_rethrow` pulls
 * `next/navigation` — so the WARNING STRING moved to `./refreshWarning`, which
 * is. A client component needs the sentence and must not drag this graph in
 * with it.
 */

/** Re-exported for the callers that already import it from here. The constant
 *  itself lives in a zero-import module because this one is no longer one. */
export { REFRESH_FAILED_WARNING } from "./refreshWarning";

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
 * `run` should contain revalidation only, but a `redirect()` slipping in is no
 * longer silent: `unstable_rethrow` sends Next's control-flow throws back up.
 */
export function guardRefresh(scope: string, run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (err) {
    // STRUCTURAL, NOT A COMMENT. `redirect()`, `notFound()` and Next's dynamic
    // bailouts all signal by THROWING, so a bare catch here would swallow a
    // navigation and hand back a warning string instead — on
    // `confirmImportAction` that is a committed several-hundred-row import
    // whose redirect silently vanishes, with no state channel to notice
    // (`Promise<void>`). Five call sites keep their `redirect` outside `run`
    // by hand, guided only by prose; rule 11 is explicit that a property
    // defended by a comment is a property waiting to be refactored away.
    // `unstable_rethrow` re-throws exactly those control-flow signals and
    // returns for everything else.
    unstable_rethrow(err);
    console.error(`[${scope}] revalidation failed after a committed write`, err);
    return REFRESH_FAILED_WARNING;
  }
}
