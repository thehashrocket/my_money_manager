"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { commitImport } from "@/lib/importBatch";
import {
  deletePendingImport,
  readPendingImport,
  savePendingImport,
} from "@/lib/pendingImport";

export async function createAccountAction(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "");
  const startingBalanceRaw = String(formData.get("startingBalance") ?? "").trim();
  const startingBalanceDate = String(formData.get("startingBalanceDate") ?? "").trim();

  if (!name) throw new Error("Account name is required");
  if (type !== "checking" && type !== "savings") {
    throw new Error(`Invalid account type: ${type}`);
  }
  const bal = Number(startingBalanceRaw);
  if (!Number.isFinite(bal)) throw new Error("Invalid starting balance");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startingBalanceDate)) {
    throw new Error("Starting balance date must be YYYY-MM-DD");
  }

  db.insert(schema.accounts)
    .values({
      name,
      type,
      startingBalanceCents: Math.round(bal * 100),
      startingBalanceDate,
    })
    .run();

  revalidatePath("/import");
  redirect("/import");
}

export async function uploadCsvAction(formData: FormData): Promise<void> {
  const accountIdRaw = String(formData.get("accountId") ?? "");
  const file = formData.get("file");
  const accountId = Number(accountIdRaw);

  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw new Error("Please select an account");
  }
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Please choose a CSV file");
  }

  const csv = await file.text();
  const pending = savePendingImport({
    accountId,
    filename: file.name,
    csv,
  });

  redirect(`/import/preview/${pending.id}`);
}

export async function confirmImportAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const pending = readPendingImport(id);
  if (!pending) throw new Error("Pending import not found or expired");

  const result = commitImport({
    accountId: pending.accountId,
    filename: pending.filename,
    csvText: pending.csv,
  });

  deletePendingImport(id);
  revalidatePath("/import");
  redirect(`/import/success/${result.batchId}`);
}

export async function cancelImportAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  deletePendingImport(id);
  redirect("/import");
}
