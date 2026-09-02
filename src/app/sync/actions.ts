"use server";

import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { syncSimpleFin, linkTransferPairManually } from "@/lib/simplefin/sync";
import { undoSyncBatch } from "@/lib/simplefin/undoSync";
import { setAccountLink } from "@/lib/simplefin/link";
import {
  validateLinkAccountInput,
  validateResolveTransferInput,
  validateUndoSyncInput,
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

export type SyncActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

export async function syncNowAction(): Promise<SyncActionState> {
  let outcome: Awaited<ReturnType<typeof syncSimpleFin>>;
  try {
    outcome = await syncSimpleFin();
  } catch (err) {
    // A bad credential or an unreachable bridge is an expected outcome here,
    // not a crash — surface it in the page instead of the error overlay.
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  revalidateAll();

  if (outcome.status === "no-linked-accounts") {
    return {
      status: "error",
      message: "No accounts are linked to SimpleFIN yet — link one below first.",
    };
  }
  if (outcome.status === "up-to-date") {
    return { status: "ok", message: "Already up to date — nothing new to import." };
  }

  const parts = [
    `Imported ${outcome.insertedCount} transaction${outcome.insertedCount === 1 ? "" : "s"}`,
    `linked ${outcome.pairsLinked} transfer pair${outcome.pairsLinked === 1 ? "" : "s"}`,
  ];
  if (outcome.ambiguous.length > 0) {
    parts.push(`${outcome.ambiguous.length} needing review`);
  }
  return { status: "ok", message: parts.join(", ") + "." };
}

export async function undoSyncAction(formData: FormData): Promise<void> {
  const parsed = validateUndoSyncInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid undo request — ${rejectionMessage(parsed.error)}`);
  }
  undoSyncBatch(parsed.data.batchId);
  revalidateAll();
}

export async function linkAccountAction(formData: FormData): Promise<void> {
  const parsed = validateLinkAccountInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid link request — ${rejectionMessage(parsed.error)}`);
  }
  setAccountLink(parsed.data.accountId, parsed.data.simplefinAccountId);
  revalidatePath("/sync");
}

export async function resolveTransferAction(formData: FormData): Promise<void> {
  const parsed = validateResolveTransferInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid transfer pairing — ${rejectionMessage(parsed.error)}`);
  }
  linkTransferPairManually(parsed.data.aId, parsed.data.bId);
  revalidateAll();
}
