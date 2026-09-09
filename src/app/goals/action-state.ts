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
 */
export type GoalsActionState = {
  /**
   * Set only when the post-commit `revalidatePath` threw.
   *
   * Both actions still THROW on a validation failure — that path is unchanged
   * and lands in `error.tsx`. This is the opposite case: the write is already
   * durable, so there is no failure to report, only a page that may be showing
   * the state from before it. See `src/lib/revalidateAfterWrite.ts`.
   */
  warning?: string;
};

export const IDLE_GOALS: GoalsActionState = {};
