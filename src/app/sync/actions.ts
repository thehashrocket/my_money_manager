"use server";

import { revalidatePath } from "next/cache";
import { formatCents } from "@/lib/money";
import type { ZodError } from "zod";
import {
  syncSimpleFin,
  linkTransferPairManually,
  rejectTransferPairManually,
  unlinkTransferPair,
} from "@/lib/simplefin/sync";
import { undoSyncBatch } from "@/lib/simplefin/undoSync";
import { setAccountLink } from "@/lib/simplefin/link";
import {
  validateLinkAccountInput,
  validateResolveTransferInput,
  validateUndoSyncInput,
  validateUnlinkTransferInput,
} from "@/lib/simplefin/validateSyncInputs";

function rejectionMessage(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(input)"}: ${i.message}`)
    .join("; ");
}

function revalidateAll(): void {
  // A sync moves balances, the categorize backlog, the transaction list and
  // every month view at once.
  //
  // Deliberately NOT revalidatePath("/", "layout"): that invalidates the root
  // layout, which unmounts the client component holding this action's
  // useActionState, so the transition never settles and the button sticks on
  // "Syncing…" forever. Target the pages instead, using the route pattern for
  // the dynamic month segments so they are covered too.
  for (const p of ["/sync", "/", "/transactions", "/categorize", "/budget"]) {
    revalidatePath(p);
  }
  revalidatePath("/budget/[year]/[month]", "page");
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

  revalidateAll();

  if (outcome.status === "no-linked-accounts") {
    return fail("No accounts are linked to SimpleFIN yet — link one below first.");
  }

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
    return ok(message, outcome.warnings);
  }

  const parts = [
    `Imported ${outcome.insertedCount} transaction${outcome.insertedCount === 1 ? "" : "s"}`,
    `linked ${outcome.pairsLinked} transfer pair${outcome.pairsLinked === 1 ? "" : "s"}`,
  ];
  if (outcome.ambiguous.length > 0) {
    parts.push(`${outcome.ambiguous.length} needing review`);
  }
  const summary = parts.join(", ") + ".";
  return ok(balanceNote === null ? summary : `${summary} ${balanceNote}`, outcome.warnings);
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

  revalidateAll();

  // Discarding this result made a no-op undo indistinguishable from a
  // successful one: the page revalidated, nothing was deleted, and the user was
  // told nothing either way. Reachable by double-clicking or from a second tab.
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
  revalidatePath("/sync");
  return ok(
    parsed.data.simplefinAccountId
      ? "Account linked — it will be included in the next sync."
      : "Account unlinked — it will no longer be synced.",
    result.warning ? [result.warning] : [],
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
  try {
    linkTransferPairManually(parsed.data.aId, parsed.data.bId);
  } catch (err) {
    // Includes the stale-tab race ("already paired — reload the page"), which
    // is a normal thing to hit with two tabs open, not a crash.
    return fail(toMessage(err));
  }
  revalidateAll();
  return ok("Linked as a transfer — both rows are now excluded from spending.");
}

/**
 * The same-account half of the review queue: a transaction and its reversal on
 * ONE account. A SEPARATE action from `resolveTransferAction` on purpose — the
 * same-account opt-in is carried by which action ran, not by a form field, so
 * a crafted or stale POST to the ordinary transfer action can never set it.
 * Validation is otherwise identical, and `linkTransferPairManually` still
 * enforces same-day, opposite signs and equal magnitude underneath.
 */
export async function resolveSameAccountReversalAction(
  _prev: SyncActionState,
  formData: FormData,
): Promise<SyncActionState> {
  const parsed = validateResolveTransferInput(Object.fromEntries(formData));
  if (!parsed.success) {
    return fail(`Invalid reversal pairing — ${rejectionMessage(parsed.error)}`);
  }

  // Two buttons, one form, because both need the SAME two <select> values —
  // "these are a reversal" and "these are not" are answers to one question, and
  // the rejection is pair-scoped so it has to name the pair the user picked.
  // Anything that is not exactly "reject" links, so a missing or tampered
  // intent falls back to the path with the stricter guards rather than the one
  // that writes a durable "never ask me again".
  const reject = formData.get("intent") === "reject";

  try {
    if (reject) {
      rejectTransferPairManually(parsed.data.aId, parsed.data.bId);
    } else {
      linkTransferPairManually(parsed.data.aId, parsed.data.bId, undefined, {
        allowSameAccountReversal: true,
      });
    }
  } catch (err) {
    return fail(toMessage(err));
  }
  revalidateAll();
  return ok(
    reject
      ? "Marked as not a reversal — these two stay in your spending, and this pairing won't be suggested again."
      : "Linked as a reversal — both rows are now excluded from spending.",
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
  try {
    unlinkTransferPair(parsed.data.id);
  } catch (err) {
    return fail(toMessage(err));
  }
  revalidateAll();
  return ok("Unpaired — both rows count towards spending again.");
}
