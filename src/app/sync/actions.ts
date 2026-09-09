"use server";

import { revalidatePath } from "next/cache";
import { formatCents } from "@/lib/money";
import { guardRefresh as guardSharedRefresh } from "@/lib/revalidateAfterWrite";
import type { ZodError } from "zod";
import {
  syncSimpleFin,
  linkTransferPairManually,
  rejectTransferPairManually,
  unlinkTransferPair,
  type RejectOutcome,
} from "@/lib/simplefin/sync";
import { undoSyncBatch } from "@/lib/simplefin/undoSync";
import { setAccountLink } from "@/lib/simplefin/link";
import {
  REJECT_INTENT,
  validateLinkAccountInput,
  validateResolveTransferInput,
  validateResolveReversalInput,
  validateUndoSyncInput,
  validateUnlinkTransferInput,
} from "@/lib/simplefin/validateSyncInputs";

function rejectionMessage(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(input)"}: ${i.message}`)
    .join("; ");
}

/**
 * Wraps the shared `guardRefresh` for this route.
 *
 * The warning sentence and the try/catch used to live here; they are now
 * `src/lib/revalidateAfterWrite.ts`, because six other route action files
 * needed the same thing and a second hand-maintained copy had already drifted
 * on the wording. `/sync`'s callers fold ARRAYS of warnings into `ok(...)`, so
 * the shared `string | undefined` is adapted here rather than at nine call
 * sites.
 *
 * Returns any warning produced by the refresh itself — NOT void. A caller must
 * fold the result into its `ok(...)` warnings, or a failed refresh is silent.
 */
function guardRefresh(run: () => void): string[] {
  const warning = guardSharedRefresh("/sync", run);
  return warning === undefined ? [] : [warning];
}

/**
 * Returns any warning produced by the refresh itself — NOT void. A caller must
 * fold the result into its `ok(...)` warnings, or a failed refresh is silent.
 */
function revalidateAll(): string[] {
  // A sync moves balances, the categorize backlog, the transaction list and
  // every month view at once.
  //
  // Deliberately NOT revalidatePath("/", "layout"): that invalidates the root
  // layout, which unmounts the client component holding this action's
  // useActionState, so the transition never settles and the button sticks on
  // "Syncing…" forever. Target the pages instead, using the route pattern for
  // the dynamic month segments so they are covered too.
  return guardRefresh(() => {
    for (const p of ["/sync", "/", "/transactions", "/categorize", "/budget"]) {
      revalidatePath(p);
    }
    revalidatePath("/budget/[year]/[month]", "page");
  });
}

/**
 * Every action on this page returns its outcome rather than throwing.
 *
 * A thrown Server Action error has nowhere to land: there is no error boundary
 * on this route, so it replaces the whole page with the crash overlay and takes
 * the undo button, the remaining review buckets and the balance check with it.
 * Several of these failures are reachable from ordinary use — a stale tab
 * resolving a bucket another tab already resolved, a double-submitted undo — so
 * they belong next to the form that caused them. (src/app/sync/error.tsx is the
 * backstop for anything genuinely unexpected.)
 */
export type SyncActionState =
  | { status: "idle" }
  | { status: "ok"; message: string; warnings: string[] }
  /** Succeeded, but something the user needs to know about came back with it. */
  | { status: "warning"; message: string; warnings: string[] }
  | { status: "error"; message: string; warnings: string[] };

function ok(message: string, warnings: string[] = []): SyncActionState {
  return warnings.length > 0
    ? { status: "warning", message, warnings }
    : { status: "ok", message, warnings };
}

function fail(message: string, warnings: string[] = []): SyncActionState {
  return { status: "error", message, warnings };
}

/** Turns a thrown domain error into returned state; rethrows nothing. */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One sentence naming every liability whose balance the feed just moved.
 *
 * Never silent: an anchor move is a real write, and the outcome it rides in
 * on (`up-to-date`) otherwise tells the user nothing happened.
 */
function describeBalanceUpdates(
  updates: { name: string; balanceCents: number }[],
): string | null {
  if (updates.length === 0) return null;
  const named = updates
    .map((u) => `${u.name} is now ${formatCents(u.balanceCents)}`)
    .join("; ");
  return `Balance updated: ${named}.`;
}

export async function syncNowAction(): Promise<SyncActionState> {
  let outcome: Awaited<ReturnType<typeof syncSimpleFin>>;
  try {
    outcome = await syncSimpleFin();
  } catch (err) {
    // A bad credential or an unreachable bridge is an expected outcome here,
    // not a crash — surface it in the page instead of the error overlay.
    return fail(toMessage(err));
  }

  // Checked BEFORE the refresh, like every other refusal in this file.
  // `syncSimpleFin` returns this status before it writes anything, so there is
  // nothing to refresh and revalidating would only re-render the page under a
  // message about a write that never happened. This was the THIRD instance of
  // revalidate-before-fail, not one of two: it went unnoticed because
  // `SyncButton` renders at a fixed position and never unmounts, so unlike the
  // undo and unlink forms it does not lose its own refusal — which makes it a
  // latent trap for whoever next moves that button into a conditional section
  // rather than a live bug.
  if (outcome.status === "no-linked-accounts") {
    return fail("No accounts are linked to SimpleFIN yet — link one below first.");
  }

  const refresh = revalidateAll();

  // The warnings carry the only signal that a bank connection is broken:
  // SimpleFIN reports per-institution failures in `errors[]` on an HTTP 200, and
  // an account the feed silently omitted produces no rows and no error. Dropping
  // them here is what made a dead connection render as a green "Already up to
  // date" while transactions aged past the 45-day window into CSV-only
  // territory. A sync carrying warnings is never a plain success.
  // F8 — the balance pass runs BEFORE syncSimpleFin's `up-to-date` early
  // return and must be reported through it. "Already up to date — nothing new
  // to import" is a true statement about transactions and a false one about
  // the ledger if a mortgage's anchor just moved underneath it.
  const balanceNote = describeBalanceUpdates(outcome.balanceUpdates);

  if (outcome.status === "up-to-date") {
    const message =
      balanceNote === null
        ? "Already up to date — nothing new to import."
        : `No new transactions. ${balanceNote}`;
    return ok(message, [...outcome.warnings, ...refresh]);
  }

  const parts = [
    `Imported ${outcome.insertedCount} transaction${outcome.insertedCount === 1 ? "" : "s"}`,
    `linked ${outcome.pairsLinked} transfer pair${outcome.pairsLinked === 1 ? "" : "s"}`,
  ];
  if (outcome.ambiguous.length > 0) {
    parts.push(`${outcome.ambiguous.length} needing review`);
  }
  const summary = parts.join(", ") + ".";
  return ok(balanceNote === null ? summary : `${summary} ${balanceNote}`, [
    ...outcome.warnings,
    ...refresh,
  ]);
}

export async function undoSyncAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  const parsed = validateUndoSyncInput(Object.fromEntries(formData));
  if (!parsed.success) {
    return fail(`Invalid undo request — ${rejectionMessage(parsed.error)}`);
  }

  let result: ReturnType<typeof undoSyncBatch>;
  try {
    result = undoSyncBatch(parsed.data.batchId);
  } catch (err) {
    return fail(toMessage(err));
  }

  // Discarding this result made a no-op undo indistinguishable from a
  // successful one: the page revalidated, nothing was deleted, and the user was
  // told nothing either way. Reachable by double-clicking or from a second tab.
  //
  // These two checks run BEFORE `revalidateAll()`, and the order is the whole
  // point. Both are paths that wrote nothing, so revalidating is not merely
  // wasted — it re-renders `page.tsx`'s `{lastBatch && …}` section out from
  // under the form whose inline `role="alert"` is the only place this refusal
  // is ever shown. `ActionForm`'s "a failure skips revalidateAll(), so the form
  // is still on screen" is the contract; this used to be one of three places
  // that broke it, alongside `unlinkTransferAction` and `syncNowAction`.
  if (result.status === "nothing-to-undo") {
    return fail(
      "That sync has already been undone, or is no longer the batch shown here — reload the page.",
    );
  }
  if (result.status === "stale") {
    return fail(result.reason);
  }

  return ok(
    `Undid the sync — removed ${result.deletedCount} transaction${result.deletedCount === 1 ? "" : "s"}.`,
    revalidateAll(),
  );
}

export async function linkAccountAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  const parsed = validateLinkAccountInput(Object.fromEntries(formData));
  if (!parsed.success) {
    return fail(`Invalid link request — ${rejectionMessage(parsed.error)}`);
  }
  let result: ReturnType<typeof setAccountLink>;
  try {
    result = setAccountLink(parsed.data.accountId, parsed.data.simplefinAccountId);
  } catch (err) {
    return fail(toMessage(err));
  }
  const refresh = guardRefresh(() => revalidatePath("/sync"));
  const warnings = result.warning ? [result.warning, ...refresh] : refresh;

  // A no-op does not claim to have done something. `setAccountLink` already
  // computes `linkChanged` (it gates both of its warnings on it) and used to
  // discard it, so saving the value an account already had reported "Account
  // linked — it will be included in the next sync." Reachable by double-clicking
  // Save, or from a second tab. Same class as `nothing-to-undo` and
  // `already-unpaired`; this was the fourth and last one in this file.
  //
  // Unlike those two it is `ok`, not `fail`. They refuse because a durable fact
  // the user asked for is MISSING — no rows deleted, no "not a transfer"
  // recorded. Here the end state is exactly what was asked for; it just already
  // held. Reporting that as an error would train the user to distrust a page
  // that is telling them the truth.
  if (!result.linkChanged) {
    return ok(
      parsed.data.simplefinAccountId
        ? "That account was already linked to this SimpleFIN account — nothing changed."
        : "That account was already unlinked — nothing changed.",
      warnings,
    );
  }

  return ok(
    parsed.data.simplefinAccountId
      ? "Account linked — it will be included in the next sync."
      : "Account unlinked — it will no longer be synced.",
    warnings,
  );
}

export async function resolveTransferAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  const parsed = validateResolveTransferInput(Object.fromEntries(formData));
  if (!parsed.success) {
    return fail(`Invalid transfer pairing — ${rejectionMessage(parsed.error)}`);
  }
  let linked: { clearedRejection: boolean };
  try {
    linked = linkTransferPairManually(parsed.data.aId, parsed.data.bId);
  } catch (err) {
    // Includes the stale-tab race ("already paired — reload the page"), which
    // is a normal thing to hit with two tabs open, not a crash.
    return fail(toMessage(err));
  }
  return ok(
    linkMessage(
      "Linked as a transfer — both rows are now excluded from spending.",
      linked.clearedRejection,
      "transfer",
    ),
    revalidateAll(),
  );
}

/**
 * Appends the erasure to a link's success message when there was one.
 *
 * Linking a pair DELETES any `transfer_pair_rejections` row for it, which is a
 * durable decision the user made earlier and cannot get back from any surface
 * in this app. Saying so is the whole point: on the cross-account queue the
 * `rejected` bucket at least explains itself in its own blurb, but on a
 * multi-candidate reversal bucket the card is byte-identical before and after a
 * rejection, so a second click here silently reverses an answer the user
 * believes is still recorded. CLAUDE.md rule 4 names this as the reason the
 * link branch is not the reversible one.
 */
function linkMessage(
  base: string,
  clearedRejection: boolean,
  noun: "transfer" | "reversal",
): string {
  if (!clearedRejection) return base;
  return `${base} This also cleared the “not a ${noun}” you had recorded for this pair.`;
}

/**
 * The same-account half of the review queue: a transaction and its reversal on
 * ONE account. A SEPARATE action from `resolveTransferAction` on purpose — the
 * same-account opt-in is carried by which action ran, not by a form field, so
 * a crafted or stale POST to the ordinary transfer action can never set it.
 * Validation is otherwise identical. `linkTransferPairManually` still enforces
 * opposite signs and equal magnitude unconditionally, plus same-day and
 * not-hand-entered FOR THE SAME-ACCOUNT CASE specifically — those two live
 * inside its `a.accountId === b.accountId` branch, so a pair of cross-account
 * ids posted here is date-unchecked exactly as it is on the ordinary transfer
 * action.
 *
 * The real protection is that guard set, not which action ran. This action is
 * an ordinary Server Action whose id is in the page whenever the queue
 * renders, and it does not verify that `(aId, bId)` came from a bucket the
 * user was shown. What the split buys is narrower and still worth having: a
 * post to `resolveTransferAction` can never turn ITSELF into a same-account
 * link. Do not relax a guard in `linkTransferPairManually` on the strength of
 * the split alone.
 */
export async function resolveSameAccountReversalAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  // Two buttons, one form, because both need the SAME two <select> values —
  // "these are a reversal" and "these are not" are answers to one question, and
  // the rejection is pair-scoped so it has to name the pair the user picked.
  // `intent` is validated with everything else rather than read raw off
  // FormData, and it is REQUIRED with no default: absence is a REFUSAL, never
  // an answer. An earlier revision defaulted a missing value to "link" and
  // called that fail-safe; see `resolveReversalInputSchema` for why both halves
  // of that argument were false. Do not reintroduce a default here to quiet an
  // `Invalid reversal pairing — intent: …` refusal — that refusal is a lost
  // submitter, and defaulting it silently LINKS the pair.
  const parsed = validateResolveReversalInput(Object.fromEntries(formData));
  if (!parsed.success) {
    return fail(`Invalid reversal pairing — ${rejectionMessage(parsed.error)}`);
  }
  const { aId, bId, intent } = parsed.data;

  // Only the DB call is inside the `try`. `revalidateAll()` used to sit inside
  // it on the reject branch, so a throw from `revalidatePath` reported an
  // already-committed `transfer_pair_rejections` row as a refusal — and a
  // rejection permanently suppresses both automatic matchers for that pair,
  // with no "Linked pairs" list to undo it from. Same shape as the no-op
  // refusals in `undoSyncAction` (above) and `unlinkTransferAction` (below),
  // which is why both branches here now revalidate in one place.
  //
  // Moving it out was only half the fix, though: outside the try the same throw
  // escaped the action entirely and hit `error.tsx`, which promises the ledger
  // is unchanged. `revalidateAll` guards itself now and returns a warning
  // instead — see `guardRefresh`.
  // Discriminated rather than two nullable locals, so that "which branch ran"
  // and "what it returned" cannot drift apart — with a nullable pair, reading
  // the link result after the reject branch needs a `!` that tsc cannot check.
  let resolution:
    | { kind: "rejected"; outcome: RejectOutcome }
    | { kind: "linked"; clearedRejection: boolean };
  try {
    resolution =
      intent === REJECT_INTENT
        ? { kind: "rejected", outcome: rejectTransferPairManually(aId, bId) }
        : {
            kind: "linked",
            ...linkTransferPairManually(aId, bId, undefined, {
              allowSameAccountReversal: true,
            }),
          };
  } catch (err) {
    return fail(toMessage(err));
  }
  const refresh = revalidateAll();
  if (resolution.kind === "rejected") {
    return ok(
      resolution.outcome === "recorded"
        ? "Marked as not a reversal — these two stay in your spending, and this pairing won't be suggested again."
        : "You had already marked these two as not a reversal — nothing changed.",
      refresh,
    );
  }
  return ok(
    linkMessage(
      "Linked as a reversal — both rows are now excluded from spending.",
      resolution.clearedRejection,
      "reversal",
    ),
    refresh,
  );
}

export async function unlinkTransferAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  const parsed = validateUnlinkTransferInput(Object.fromEntries(formData));
  if (!parsed.success) {
    return fail(`Invalid unlink request — ${rejectionMessage(parsed.error)}`);
  }
  let outcome;
  try {
    outcome = unlinkTransferPair(parsed.data.id);
  } catch (err) {
    return fail(toMessage(err));
  }
  // A no-op is NOT reported as a completed correction. `unlinkTransferPair`
  // returns early when the row is already unpaired, and that path records no
  // rejection — so the ordinary success message would be claiming a durable
  // "not a transfer" that was never written. Same reasoning as
  // `undoSyncAction`'s `nothing-to-undo` branch above, including the ordering:
  // this refusal is checked BEFORE `revalidateAll()`, because revalidating
  // drops this pair's `<li>` out of `linkedPairs` and takes the form — and so
  // the only rendering of this message — with it.
  if (outcome === "already-unpaired") {
    return fail(
      "These rows were already unpaired — nothing was changed, and no “not a transfer” was recorded. Reload the page to see the current state.",
    );
  }

  return ok(
    "Unpaired — both rows count towards spending again.",
    revalidateAll(),
  );
}
