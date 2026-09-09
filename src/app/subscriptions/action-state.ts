import type {
  CategorizeAllSubscriptionsOutcome,
  SubscriptionCategorizeOutcome,
} from "@/lib/subscriptions/categorizeSubscriptions";

/**
 * The returned-state shapes for every `/subscriptions` server action.
 *
 * Deliberately NOT in `actions.ts`, for the same reason
 * `src/app/accounts/action-state.ts` exists: a `"use server"` module may only
 * export async functions. Nothing here is a runtime value today — every export
 * is a type, which is erased — but the constraint is a BUNDLER rule that `tsc`
 * and vitest are both blind to, so the shapes live on this side of the line
 * from the start rather than being moved the first time one of them needs a
 * sentinel.
 */

/**
 * The refresh warning every action on this page can carry.
 *
 * Present only when the post-commit `revalidatePath` threw. It is never a
 * failure: the write is already durable at that point, so the outcome stays
 * whatever it was and this rides alongside it (see
 * `src/lib/revalidateAfterWrite.ts`).
 */
type RefreshWarning = { warning?: string };

/**
 * One merchant's filing outcome plus the refresh warning.
 *
 * The outcome half is the load-bearing one. `/subscriptions` has NO undo (rule
 * 6), so `refusal` / `retargetedRule` are the only record the user ever gets
 * that a hand-trained rule was withheld or repointed — a failed refresh must
 * not be allowed to discard them by turning the whole call into a throw.
 */
export type SubscriptionCategorizeResult = SubscriptionCategorizeOutcome &
  RefreshWarning;

/** {@link SubscriptionCategorizeResult} for the "Categorize all" sweep. */
export type CategorizeAllSubscriptionsResult = CategorizeAllSubscriptionsOutcome &
  RefreshWarning;

/**
 * Dismiss / restore return the warning and nothing else.
 *
 * Both writes are idempotent (`onConflictDoNothing`, and a delete by key), so
 * there is no outcome to report beyond "it saved" — but a stale page after a
 * dismiss looks exactly like a dismiss that did not take, which is the silence
 * this shape exists to break.
 */
export type SubscriptionDismissResult = RefreshWarning;
