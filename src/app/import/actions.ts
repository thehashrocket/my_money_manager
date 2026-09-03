"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import type { ZodError } from "zod";
import { db, schema } from "@/db";
import { commitImport } from "@/lib/importBatch";
import { undoImportCategorization } from "@/lib/categorize/undoImportCategorization";
import {
  deletePendingImport,
  readPendingImport,
  savePendingImport,
} from "@/lib/pendingImport";
import { validateCreateAccountInput } from "@/lib/import/validateCreateAccountInput";
import { validateImportIdInput } from "@/lib/import/validateImportIdInput";
import { validateUndoImportCategorizationInput } from "@/lib/import/validateUndoImportCategorizationInput";
import { validateUpdateAnchorInput } from "@/lib/import/validateUpdateAnchorInput";
import { validateUploadCsvInput } from "@/lib/import/validateUploadCsvInput";

function rejectionMessage(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(input)"}: ${i.message}`)
    .join("; ");
}

export async function createAccountAction(formData: FormData): Promise<void> {
  const parsed = validateCreateAccountInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid account input — ${rejectionMessage(parsed.error)}`);
  }
  const { name, type, startingBalance, startingBalanceDate } = parsed.data;

  db.insert(schema.accounts)
    .values({
      name,
      type,
      startingBalanceCents: Math.round(startingBalance * 100),
      startingBalanceDate,
    })
    .run();

  revalidatePath("/import");
  redirect("/import");
}

/**
 * Re-point an existing account's starting-balance anchor.
 *
 * The escape hatch for a too-late anchor, which no import can undo on its own:
 * `anchorStartingBalance` only moves the anchor forward, so a full-history CSV
 * always derives an earlier date and is rejected. See
 * `validateUpdateAnchorInput` for the whole story.
 *
 * Revalidates every surface that renders a balance, not just /import — the
 * anchor is the base of `loadAccountBalances`, which also backs the Spine
 * (every route's balance peek), the dashboard, and the month view. Same
 * route set as sync/actions.ts's `revalidateAll`, minus the dynamic
 * `/budget/[year]/[month]` pattern (this action isn't reachable from a
 * budget-month page, so there's no stale month segment to target).
 */
export async function updateAccountAnchorAction(
  formData: FormData,
): Promise<void> {
  const parsed = validateUpdateAnchorInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid anchor input — ${rejectionMessage(parsed.error)}`);
  }
  const { accountId, startingBalance, startingBalanceDate } = parsed.data;

  const result = db
    .update(schema.accounts)
    .set({
      startingBalanceCents: Math.round(startingBalance * 100),
      startingBalanceDate,
      updatedAt: new Date(),
    })
    .where(eq(schema.accounts.id, accountId))
    .run();

  // A stale tab submitting against a deleted account would otherwise report
  // success having written nothing.
  if (result.changes === 0) {
    throw new Error(`Account ${accountId} not found`);
  }

  for (const p of ["/import", "/sync", "/", "/transactions", "/categorize", "/budget"]) {
    revalidatePath(p);
  }
  redirect("/import");
}

export async function uploadCsvAction(formData: FormData): Promise<void> {
  const parsed = validateUploadCsvInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid upload — ${rejectionMessage(parsed.error)}`);
  }
  const { accountId, file } = parsed.data;

  const csv = await file.text();
  const pending = savePendingImport({
    accountId,
    filename: file.name,
    csv,
  });

  redirect(`/import/preview/${pending.id}`);
}

export async function confirmImportAction(formData: FormData): Promise<void> {
  const parsed = validateImportIdInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid import id — ${rejectionMessage(parsed.error)}`);
  }
  const { id } = parsed.data;

  const pending = readPendingImport(id);
  if (!pending) throw new Error("Pending import not found or expired");

  const result = commitImport({
    accountId: pending.accountId,
    filename: pending.filename,
    csvText: pending.csv,
  });

  if (result.status === "empty") {
    redirect(`/import/preview/${id}`);
  }

  deletePendingImport(id);
  revalidatePath("/import");
  redirect(`/import/success/${result.batchId}`);
}

/**
 * Undo everything a batch's rule matching auto-categorized at import time —
 * the P1 gap CLAUDE.md rule 6 flags: import-time categorization had no undo
 * of its own, only the full pre-import DB snapshot (which reverts the whole
 * batch, not just the categorization). See `undoImportCategorization` for the
 * stale-row-safe revert logic.
 *
 * Redirects back to the same success page rather than away from it — this is
 * a correction to what that page is showing, not a new destination.
 */
export async function undoImportCategorizationAction(
  formData: FormData,
): Promise<void> {
  const parsed = validateUndoImportCategorizationInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid undo request — ${rejectionMessage(parsed.error)}`);
  }
  const { batchId } = parsed.data;

  undoImportCategorization(db, batchId);

  // Includes the success page itself: it was just rendered with the pre-undo
  // revertibleCount/form, and the redirect below returns to that exact URL —
  // without this, Next.js can serve the stale pre-undo payload instead of
  // rendering the undo as having taken effect (Codex structured review,
  // `/ship` 2026-09-03). `/sync` also shows this batch's revertible count
  // when it's the SimpleFIN-sourced one.
  for (const p of ["/import", `/import/success/${batchId}`, "/sync", "/", "/transactions", "/categorize", "/budget"]) {
    revalidatePath(p);
  }
  revalidatePath("/budget/[year]/[month]", "page");
  redirect(`/import/success/${batchId}`);
}

export async function cancelImportAction(formData: FormData): Promise<void> {
  const parsed = validateImportIdInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid import id — ${rejectionMessage(parsed.error)}`);
  }
  deletePendingImport(parsed.data.id);
  redirect("/import");
}
