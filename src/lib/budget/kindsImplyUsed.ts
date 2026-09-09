import type { CategoryKind } from "./categoryKindLock";

/**
 * Does the kind list itself say the category is USED?
 *
 * The inverse of `isCategoryUsed`, read off the OUTPUT of `assignableKinds`
 * rather than off a usage record — which is the only form available to a client
 * component holding the server-rendered prop. It is exact, not a heuristic:
 * `assignableKinds` returns all three kinds in its first branch and only when
 * `!isCategoryUsed(usage)`, so `length < 3` and "used" are the same fact. That
 * in turn makes it the test for "the only change on offer is X1", because rule
 * 8 refuses every other transition on a used category — and X1 is one-way, so
 * it is also the test for "this change cannot be undone".
 *
 * Extracted because the literal `< 3` had grown THREE inline spellings
 * (`_month-editor`'s `liveAssignableKinds` and `liveKindLockReason`, and
 * `CategoryMenu`'s confirm gate), and the newest one decides whether an
 * irreversible write gets a confirmation step — a rule 8 fact restated in a
 * component where no test could reach it.
 *
 * ZERO RUNTIME IMPORTS, and that is the whole reason this is its own file
 * rather than a function in `categoryKindLock.ts`. That module imports
 * `drizzle-orm` and `@/db`; both callers here are `"use client"`, so a value
 * import from it would pull better-sqlite3 into the browser bundle. Same
 * constraint, and same resolution, as `limits.ts`, `merchantLabel.ts` and
 * `keyTrainability.ts`. The `CategoryKind` import is `import type`, which the
 * compiler erases. `categoryKindLock.ts` re-exports this so the server side
 * still reads rule 8's vocabulary from one place.
 */
/**
 * Every kind the schema enum admits — the ONE list, and the one
 * `assignableKinds` returns from its unused branch.
 *
 * The `3` below is the CARDINALITY of that enum, and nothing tied it there.
 * Add a fourth kind and `kindsImplyUsed` starts returning `true` for an unused
 * category, so `CategoryMenu` shows "This cannot be undone" before a
 * REVERSIBLE change — teaching people to click through the one modal in the
 * app that guards a one-way write. `tsc` would say nothing. This is the same
 * class `CategoryKind`'s derivation from the schema exists to prevent: the
 * type was derived, the arity was not.
 */
export const ALL_KINDS = ["expense", "income", "fund"] as const satisfies readonly CategoryKind[];

/** Adding a kind to the schema without adding it here is a build error. */
type _AllKindsIsExhaustive = CategoryKind extends (typeof ALL_KINDS)[number] ? true : never;
const _ALL_KINDS_IS_EXHAUSTIVE: _AllKindsIsExhaustive = true;
void _ALL_KINDS_IS_EXHAUSTIVE;

export function kindsImplyUsed(kinds: readonly CategoryKind[]): boolean {
  return kinds.length < ALL_KINDS.length;
}
