"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { db, schema } from "@/db";
import { commitImport } from "@/lib/importBatch";
import {
  deletePendingImport,
  readPendingImport,
  savePendingImport,
} from "@/lib/pendingImport";
import { validateCreateAccountInput } from "@/lib/import/validateCreateAccountInput";
import { validateImportIdInput } from "@/lib/import/validateImportIdInput";
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

export async function cancelImportAction(formData: FormData): Promise<void> {
  const parsed = validateImportIdInput(Object.fromEntries(formData));
  if (!parsed.success) {
    throw new Error(`Invalid import id — ${rejectionMessage(parsed.error)}`);
  }
  deletePendingImport(parsed.data.id);
  redirect("/import");
}
