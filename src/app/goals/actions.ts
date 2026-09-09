"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import {
  CategoryArchivedError,
  CategoryNameTakenError,
  CategoryNotFoundError,
  NotASavingsGoalError,
} from "@/lib/categoryErrors";
import { assertNameAvailable } from "@/lib/budget/manageCategories";
import { validateCreateGoal, validateUpdateGoalTarget } from "@/lib/goals/validateGoalInput";
import { guardRefresh } from "@/lib/revalidateAfterWrite";
import type { GoalsActionState } from "./action-state";

/** Route tag for `guardRefresh`'s log line; not user-facing. */
const SCOPE = "/goals";

/**
 * The four paths a fund write invalidates, split in two — and the split decides
 * whether `createGoalAction` redirects.
 *
 * Guarded, and handing back strings rather than `void`: these ran bare after a
 * COMMITTED insert/update, so a throw from `revalidatePath` escaped into
 * `/goals/error.tsx`, whose title says the page failed to LOAD — a load failure
 * reported for a write that landed. Re-submitting on that reading creates a
 * SECOND fund, or — on the create path — collides with the name that now exists
 * and produces a second, unrelated-looking error.
 *
 * `/goals` is the page the user is being sent BACK to; the budget surfaces are
 * secondary readers of the same row. Guarding them together meant a failure
 * invalidating `/budget/categories` suppressed the redirect and stranded the
 * user on the create form — for a staleness on a page they were not going to.
 * Found by the Codex structured review.
 *
 * Returns both halves so the caller can act on the one that concerns it and
 * still REPORT the other; a secondary failure is real, it just is not a reason
 * to hold someone on a form.
 */
function revalidateAfterFundWrite(): { destination?: string; secondary?: string } {
  const destination = guardRefresh(SCOPE, () => {
    revalidatePath("/goals");
  });
  const secondary = guardRefresh(SCOPE, () => {
    // `/budget` too, since D3=C: the FUNDS band renders this fund's row and
    // its `targetCents` ("Left to target"). A fund created here and not
    // revalidated there is missing from the band — and when it is the FIRST
    // fund, the band itself does not render, because `<MonthEditor>` gates
    // the whole section on `fundRows.length > 0`.
    revalidatePath("/budget");
    revalidatePath("/budget/[year]/[month]", "page");
    // The write is a new row in `categories`, and `/budget/categories` is the
    // surface that LISTS them — omitting it meant creating a fund on /goals and
    // finding it missing from Categories until some unrelated category action
    // happened to revalidate that route. Same writer/reader edge CLAUDE.md
    // records v0.23.0 getting wrong four times.
    revalidatePath("/budget/categories");
  });
  return { destination, secondary };
}

export async function createGoalAction(
  _prev: GoalsActionState,
  formData: FormData,
): Promise<GoalsActionState> {
  const raw = Object.fromEntries(formData);
  const result = validateCreateGoal(raw);
  if (!result.success) throw new Error(result.error);

  const { name, targetDollars, carryoverPolicy } = result.data;
  const targetCents = Math.round(targetDollars * 100);

  // `categories.name` is globally unique, and this action used to insert with
  // no check at all — so a collision surfaced as a raw
  // `UNIQUE constraint failed: categories.name`, which the shipped build
  // replaces with a generic digest. `createCategory` (the other fund-creation
  // path, /budget's "+ Add a line") has always checked, so the two surfaces
  // disagreed about the same collision; they now share one function rather
  // than each carrying their own copy of the query. The archived case is why
  // this became worth fixing now: v0.24.0 filters archived funds out of
  // `loadGoals`, so the colliding category is no longer visible on the page
  // the user is standing on.
  // Returned as STATE, never thrown. A name collision is what a double-submit
  // and a stale tab both produce — ordinary use — and since this action now
  // stays put on a refresh warning, the form is still mounted with the same
  // name in it when the user clicks again. Throwing took `/goals` down; both
  // adversarial reviewers found that path independently.
  try {
    assertNameAvailable(db, name);
  } catch (err) {
    if (err instanceof CategoryNameTakenError) return { status: "error", message: err.message };
    throw err;
  }

  // Dual-write (T5, D1B/A2): kind is authoritative everywhere else in the
  // app now, but isSavingsGoal keeps being written so it stays truthful for
  // anything not yet migrated, until PR3 drops the column entirely.
  db.insert(schema.categories)
    .values({ name, isSavingsGoal: true, kind: "fund", targetCents, carryoverPolicy })
    .run();

  // `secondary` is deliberately not read here: this path redirects, which
  // discards returned state anyway, and `guardRefresh` has already logged it.
  const { destination } = revalidateAfterFundWrite();

  // `redirect` STAYS OUTSIDE the guard: it signals by throwing, so running it
  // inside `guardRefresh`'s callback would catch the navigation and report it
  // as a failed refresh. (`unstable_rethrow` now makes that structural, but
  // keeping it out here is still clearer.)
  //
  // ONLY the destination's own failure holds the user here. Landing on `/goals`
  // when THAT cache could not be invalidated shows a page that may not list the
  // fund they just created, with no message anywhere — a redirect discards the
  // returned state, so staying put is the only way to say so. A failure on
  // `/budget` or `/budget/categories` is a different fact: those pages are
  // stale, but the one they are being sent to is not, and stranding them on a
  // form over it is a worse answer than a stale band they may never open.
  if (destination !== undefined) {
    return { status: "ok", message: `${name} created.`, warning: destination };
  }
  redirect("/goals");
}

export async function updateGoalTargetAction(
  _prev: GoalsActionState,
  formData: FormData,
): Promise<GoalsActionState> {
  const raw = Object.fromEntries(formData);
  const result = validateUpdateGoalTarget(raw);
  if (!result.success) throw new Error(result.error);

  const { categoryId, targetDollars } = result.data;
  const targetCents = Math.round(targetDollars * 100);

  const category = db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();

  if (!category) throw new CategoryNotFoundError(categoryId);
  // A2: kind is authoritative, not is_savings_goal (T5).
  if (category.kind !== "fund") throw new NotASavingsGoalError(categoryId);
  // v0.24.0 dropped archived funds from `loadGoals`, which turned an already
  // odd write into an invisible one: a tab opened before the fund was archived
  // still renders its "Edit target" form, and submitting it used to succeed
  // against a fund the page can no longer show. `upsertAllocation` already
  // refuses an archived category for the same reason (a write whose result is
  // unreadable is worse than a refusal); this is the matching guard on the
  // other quantity `/budget`'s FUNDS band reads from this row.
  if (category.archivedAt !== null) {
    throw new CategoryArchivedError(categoryId, category.name);
  }

  db.update(schema.categories)
    .set({ targetCents, updatedAt: new Date() })
    .where(eq(schema.categories.id, categoryId))
    .run();

  // `/budget` reads this same target for the band's "Left to target"
  // column (`fundTargetGap`), so a target changed here has to invalidate
  // there or the gap keeps reporting against the old number.
  // No redirect on this path, so both halves are equally reportable — the user
  // stays on `/goals` either way and any stale surface is worth naming.
  const { destination, secondary } = revalidateAfterFundWrite();
  // A SUCCESS, not a bare warning. This used to return `{ warning: undefined }`
  // on the happy path — structurally identical to `IDLE_GOALS` under the old
  // shape — so the form said nothing at all when it worked, on the one route
  // where every sibling surface announces its writes.
  return { status: "ok", message: "Target updated.", warning: destination ?? secondary };
}
