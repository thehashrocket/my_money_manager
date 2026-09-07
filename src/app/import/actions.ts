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
import { checkAssetAccount } from "@/lib/import/assetAccountGuard";
import { validateCreateAccountInput } from "@/lib/import/validateCreateAccountInput";
import { validateImportIdInput } from "@/lib/import/validateImportIdInput";
import { validateUndoImportCategorizationInput } from "@/lib/import/validateUndoImportCategorizationInput";
import { validateUpdateAnchorInput } from "@/lib/import/validateUpdateAnchorInput";
import { validateUploadCsvInput } from "@/lib/import/validateUploadCsvInput";
import type { CreateAccountField, CreateAccountState } from "./action-state";

function rejectionMessage(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(input)"}: ${i.message}`)
    .join("; ");
}

/**
 * Returns its outcome as state; it does NOT throw and does NOT redirect.
 *
 * A thrown Server Action unmounts the route into `import/error.tsx`'s generic
 * card, so every DS61 message written for this form ("Enter what you owe as a
 * positive number.") was replaced by "Something went wrong loading the import
 * page" — and the whole form, the longest in the app, was wiped. `/accounts`
 * made this call under T28/E20 for the same reason; this brings the account
 * form to the same contract.
 *
 * The redirect is gone with it: it pointed at `/import`, the page the form is
 * already on, so its only real effect was clearing the fields. `revalidatePath`
 * refreshes the account list in place and the success message names what was
 * created.
 */
export async function createAccountAction(
  _prev: CreateAccountState,
  formData: FormData,
): Promise<CreateAccountState> {
  const parsed = validateCreateAccountInput(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return {
      status: "error",
      // The zod message itself, not a rewrite of it. Every message on this
      // schema was written to DS61's register already — stating the
      // consequence, naming no schema concept — so surfacing it directly is
      // what makes that work visible instead of discarding it.
      message: issue?.message ?? rejectionMessage(parsed.error),
      field: typeof field === "string" ? (field as CreateAccountField) : undefined,
    };
  }
  const {
    name,
    type,
    startingBalanceCents,
    startingBalanceDate,
    creditLimitCents,
    minimumPaymentCents,
  } = parsed.data;

  db.insert(schema.accounts)
    .values({
      name,
      type,
      // Already signed by validateCreateAccountInput — a liability's
      // "Balance owed" was negated there, in the one place that decides an
      // account's opening sign (DS64). Do not re-derive it here.
      startingBalanceCents,
      startingBalanceDate,
      creditLimitCents,
      minimumPaymentCents,
      // E4 — a hand-typed opening balance IS a manual reconcile, and DS57's
      // 35-day clock is the right one to start. Leaving this NULL is what
      // made every new card render with neither Refresh nor Reconcile.
      balanceSource: "manual",
    })
    .run();

  revalidatePath("/import");
  return { status: "ok", message: `${name} added.` };
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

  // E18. This form is the raw signed twin of /accounts' Reconcile: it takes a
  // signed balance with no relabelling and no negation, so offering it a Visa
  // reintroduces the exact ledger-corruption path T15 was raised to P1 to
  // close, in the second form on the same page. Liabilities get exactly one
  // anchor surface and it is /accounts.
  const target = checkAssetAccount(accountId);
  if (!target.ok) throw new Error(target.reason);

  // Records the anchor it replaces, same as /accounts' Reconcile and the sync
  // balance pass. Without this the prior-anchor columns tracked only SOME
  // anchor moves, so a revert offered on an account last edited here would
  // restore a figure two moves old — the columns have to mean "the anchor
  // immediately before the current one" on every path that writes one, or
  // they mean nothing reliable on any of them.
  const before = db
    .select({
      cents: schema.accounts.startingBalanceCents,
      date: schema.accounts.startingBalanceDate,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();

  const result = db
    .update(schema.accounts)
    .set({
      startingBalanceCents: Math.round(startingBalance * 100),
      startingBalanceDate,
      priorStartingBalanceCents: before?.cents ?? null,
      priorStartingBalanceDate: before?.date ?? null,
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

  // E6. The picker is filtered to assets, but a stale tab rendered before the
  // card existed still posts, and this is where a CSV import would otherwise
  // move a credit card's anchor off another account's balance chain —
  // forward-only, and therefore not undoable by re-importing.
  const target = checkAssetAccount(accountId);
  if (!target.ok) throw new Error(target.reason);

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
