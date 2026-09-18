import { useLayoutEffect, useState } from "react";

/**
 * Returns `idleState` instead of `state` once this component has been
 * hidden by Activity (Cache Components' navigation-away preservation) and
 * no NEW action result has arrived since — i.e. the exact "Resetting stale
 * status messages" pattern from Next's preserving-ui-state guide, for a
 * `useActionState` result rendered permanently in place rather than behind
 * a toggle that already handles this via `useCloseOnHide`.
 *
 * Found live (cache-components-migration plan, Stage 1): `/goals`'
 * `UpdateTargetForm` has no open/close boolean at all — it's a
 * `useActionState` result shown inline inside a native `<details>`, which
 * itself never unmounts (browser-native visibility, not React conditional
 * rendering) even under the OLD pre-Activity model. Leaving `/goals` after
 * a save and coming back showed "Target updated." for a save that happened
 * on a previous visit.
 *
 * `hiddenState` tracks WHICH `state` value was showing at the moment this
 * component was last hidden. The effect's dependency array is `[state]`,
 * deliberately not empty: this is what keeps the closure's `state` fresh
 * across ordinary re-renders (a ref written during render would do the
 * same, but this codebase's lint config refuses reading or writing a ref
 * during render — `react-hooks/refs` — so this uses only `useState`,
 * React's own "adjust state during render" idiom already used elsewhere in
 * this codebase, e.g. `_charge-dialog.tsx`'s `handledState`).
 *
 * Walked through by hand: `state` A→B (an ordinary new action result) cleans
 * up the effect registered for A (`setHidden({v:A})`, a no-op against the
 * NEW `state` B) and registers a fresh one for B — renders B normally.
 * Activity hides the route: B's cleanup fires, `setHidden({v:B})` — now
 * `hidden.v === state`, renders `idleState`. Activity shows it again with
 * `state` unchanged (still B, per the guide's "effects run on every
 * hide-to-visible transition"): the effect re-registers for B, still hidden.
 * A genuinely new submit (B→C) cleans up B's effect again (`setHidden({v:B})`,
 * still a no-op) and registers for C — `hidden.v (B) !== state (C)`,
 * renders C normally regardless of hide history.
 *
 * `hidden` is `{ v: T } | null`, not `T | null` directly — `null` marks
 * "never hidden yet." `T` is generic and today's three callers only ever
 * pass a real action-result object, never `null` itself, but a bare
 * `T | null` sentinel would misfire the moment a future caller's `T` CAN be
 * `null`: on first render `hidden` starts `null`, and if `state` were also
 * legitimately `null` at that instant, `hidden === state` would be true
 * with nothing actually hidden yet, rendering `idleState` before any submit.
 * Wrapping the captured value in `{ v: T }` makes the sentinel structurally
 * distinct from every possible `T`, `null` included.
 */
export function useStatusResetOnHide<T>(state: T, idleState: T): T {
  const [hidden, setHidden] = useState<{ v: T } | null>(null);

  useLayoutEffect(() => {
    return () => {
      setHidden({ v: state });
    };
  }, [state]);

  return hidden !== null && hidden.v === state ? idleState : state;
}
