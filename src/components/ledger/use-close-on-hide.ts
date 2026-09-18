"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Resets a disclosure's `open` state to `false` when the ROUTE it lives on
 * is hidden by Activity (Cache Components' navigation-away preservation —
 * cache-components-migration plan, Stage 1 finding).
 *
 * Before Cache Components, navigating away from a route unmounted it, which
 * destroyed every `useState` including a disclosure's own `open` boolean —
 * this app's toggle-wrapper disclosures (`CardTermsDisclosure`,
 * `ReconcileDisclosure`, `_charge-dialog.tsx`'s dialog toggle) were each
 * built to rely on exactly that, splitting into "toggle wrapper + remountable
 * inner form" specifically so closing (or leaving) gave a clean slate. Under
 * Activity, the route is hidden rather than unmounted, so `open` — and
 * whatever `useActionState` message or typed-but-unsaved value the open
 * form was holding — survives the round trip. Reproduced live: open a
 * card's terms form, save (leaving the success message showing), navigate
 * to a different route and back — the form was still open with the stale
 * "Updated…" message, exactly the failure mode Next's own preserving-UI-
 * state guide names ("Resetting stale status messages").
 *
 * `useLayoutEffect`, not `useEffect`: Activity runs cleanup functions
 * synchronously before hiding a subtree, matching real unmount timing — an
 * async `useEffect` cleanup would still close the disclosure, but a beat
 * later than the hide itself, risking a visible flash of stale content the
 * instant the route becomes visible again before the cleanup from ITS OWN
 * prior hide has had a chance to run (Activity re-shows synchronously; the
 * guide's own dropdown-reset example uses `useLayoutEffect` for the same
 * reason).
 *
 * Deliberately does NOT distinguish "the user closed this on purpose" from
 * "Activity hid the route" — closing already calls `setOpen(false)`
 * directly, so this cleanup re-running against an already-false state is a
 * no-op, and there is no down side to unconditionally resetting once
 * hidden.
 *
 * **Known dev-only cosmetic artifact (pre-landing review, red-team pass):**
 * this repo's `next.config.ts` doesn't set `reactStrictMode`, so App Router
 * Strict Mode is on by default, and dev mode double-invokes every effect on
 * mount (setup → simulated cleanup → setup again) to surface non-idempotent
 * effects. For a caller that opens with `startOpen={true}`
 * (`ReconcileDisclosure` via `_card-controls.tsx`'s `startOpen={handoff > 0}`
 * DS56 handoff), the simulated cleanup fires this hook's `setOpen(false)`
 * once, synchronously, right after mount — closing a disclosure that was
 * meant to start open, in `pnpm dev` only. Production has no double-invoke
 * and is unaffected. A "skip the first cleanup" fix was considered and
 * rejected: the only signal available inside the effect (a ref flipped on
 * setup) can't tell Strict Mode's synchronous fake cleanup apart from a
 * genuinely-real one without also skipping the ONE cleanup production ever
 * fires — the naive version is wrong in exactly the build that matters.
 * React's own guidance here is "make effects safe to run twice," not "detect
 * Strict Mode," and this effect already IS safe to run twice — the visible
 * symptom is specific to the one `startOpen` caller, is dev-only, and is
 * recorded here rather than patched with a fragile detection hack.
 *
 * **`pending` skips the forced close (silent-failure-hunter finding,
 * post-landing).** `CardTermsForm`'s own Cancel button is `disabled={pending}`
 * specifically because closing (unmounting) mid-Save lets the NEXT mount
 * reseed `values`/`snapshot` from pre-write props, and an edit to some OTHER
 * field in that window can then repost this field's stale value and clobber
 * the in-flight write once it lands. An unconditional forced close on hide
 * reopened that exact door through routing instead of a button click —
 * `ReconcileForm` has no Cancel button to compare against at all, so hide was
 * its ONLY close path, making the race the sole way it could ever unmount
 * mid-write. Passing `pending` leaves the disclosure open (and hidden, not
 * gone) until the in-flight submit resolves, matching what a real unmount
 * would have to wait for anyway; the next genuine hide, once `pending` has
 * gone false, closes it normally. Read via a ref updated in a plain
 * `useEffect` (not during render, which `react-hooks/refs` forbids) so the
 * layout effect's own mount-once `[]` deps — required for the synchronous
 * hide-timing guarantee above — don't have to include it.
 */
export function useCloseOnHide(
  setOpen: (open: boolean) => void,
  pending = false,
): void {
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  });

  useLayoutEffect(() => {
    return () => {
      if (!pendingRef.current) {
        setOpen(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
