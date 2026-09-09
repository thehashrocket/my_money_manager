import type { ActionState } from "@/components/ledger/action-status";

/**
 * The returned-state shape for `/goals`' two server actions.
 *
 * Deliberately NOT in `actions.ts`: a `"use server"` module may only export
 * async functions, and `IDLE_GOALS` below is a real runtime value — putting it
 * beside the actions makes Turbopack report that the module has no exports at
 * all, so every importer of every action in it fails to resolve and the route
 * blanks. `tsc` and vitest are both structurally blind to that (it is a bundler
 * rule, not a type rule), which is exactly why the split is a convention here
 * rather than a judgement call. Same reasoning as
 * `src/app/accounts/action-state.ts`.
 *
 * IT HAS A DISCRIMINANT, and it did not until the v0.27.0 type review.
 *
 * It was `{ warning?: string; error?: string }` — two independent optionals
 * with no `status`, which made three separate problems:
 *
 *   - `{}` was BOTH "idle" and "committed, refresh fine". They are the same
 *     value, so nothing downstream could tell them apart, and
 *     `updateGoalTargetAction` returns `{ warning: undefined }` on its happy
 *     path — structurally identical to `IDLE_GOALS`. The Update-target form
 *     therefore had NO success feedback at all: the button went "Saving…" →
 *     "Save" and nothing else changed, on the one route where every sibling
 *     surface announces its writes.
 *   - `{ warning, error }` both set was representable and contradictory. The
 *     renderer checked `error` first and returned, so a warning would be
 *     silently swallowed — the exact class of drop this branch exists to end,
 *     reproduced inside the fix for it.
 *   - It was documented as "the one shape that does NOT satisfy `ActionState`",
 *     which stopped being true the moment `error` was added in this same
 *     branch. It was then one field away from conforming, and that field is
 *     the one that fixes the two problems above.
 *
 * `warning: string | undefined` rather than `warning?:` on the `ok` arm is
 * deliberate: optional makes DROPPING the field invisible to `tsc`, and
 * `guardRefresh` returns a string for the sole purpose of not being droppable.
 * The explicit `undefined` at the handful of `ok` returns that legitimately
 * skip a refresh is a feature — it says "considered, none" rather than reading
 * as an oversight.
 */
export type GoalsActionState =
  | { status: "idle" }
  /**
   * The write COMMITTED. `warning` is set only when the post-commit
   * `revalidatePath` threw — the page may be showing the state from before it.
   * See `src/lib/revalidateAfterWrite.ts`.
   */
  | { status: "ok"; message: string; warning: string | undefined }
  /**
   * A refusal the user can act on, rendered inline. Nothing was written.
   *
   * `createGoalAction` used to let `assertNameAvailable`'s
   * `CategoryNameTakenError` escape into `/goals/error.tsx`. That was survivable
   * while the action always redirected on success — but once it began STAYING
   * PUT on a refresh warning (so the user is told the fund exists), the form is
   * still mounted with the same name in it, and the obvious second click took
   * the whole Funds page down. Both adversarial reviewers found that path
   * independently.
   *
   * A name collision is ordinary use, not an exceptional condition: it is what
   * a double-submit and a stale tab both produce. `/sync` settled this posture
   * for the same reason — several failures are reachable from ordinary use, and
   * a throw takes out unrelated controls on the same page.
   */
  | { status: "error"; message: string };

export const IDLE_GOALS: GoalsActionState = { status: "idle" };

/**
 * `GoalsActionState` conforms to the shared `ActionState`, checked here rather
 * than asserted in prose.
 *
 * The predecessor shape did not, and its docblock said so — a fact that went
 * stale inside one branch. Structural assignability is not enough on its own
 * (TypeScript permits excess properties on the source of an assignment), but it
 * does catch the case that matters: a future arm that drops `status`, or one
 * whose `ok` loses `message`. Erased at build; same idiom as `_DB_IS_NOT_A_TX`.
 */
const _GOALS_STATE_CONFORMS: ActionState = null as unknown as GoalsActionState;
void _GOALS_STATE_CONFORMS;
