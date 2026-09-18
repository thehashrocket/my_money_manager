import { useLayoutEffect } from "react";

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
 */
export function useCloseOnHide(setOpen: (open: boolean) => void): void {
  useLayoutEffect(() => {
    return () => {
      setOpen(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
