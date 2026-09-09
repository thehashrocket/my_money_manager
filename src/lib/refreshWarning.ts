/**
 * The one sentence every surface shows when a write LANDED but the page behind
 * it could not be refreshed.
 *
 * Its own module, with ZERO imports, because `_month-editor.tsx` is a client
 * component and needs it — while `revalidateAfterWrite.ts`, which owns the
 * guard itself, now imports `next/navigation` for `unstable_rethrow`. Keeping
 * the constant here is the same client-graph discipline `limits.ts`,
 * `merchantLabel.ts` and `kindsImplyUsed.ts` already follow in this repo (the
 * measured +376 KB case), applied one module earlier than before.
 */
export const REFRESH_FAILED_WARNING =
  "Your change was saved, but this page couldn't refresh — reload to see the current state.";
