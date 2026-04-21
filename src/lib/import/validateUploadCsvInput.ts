import { z } from "zod";

/** 10 MB — Star One's largest conceivable single-year export is ~5 MB. */
export const MAX_CSV_BYTES = 10 * 1024 * 1024;

/**
 * Pure validation for `uploadCsvAction`. Guards the raw File metadata from
 * the browser: a positive integer `accountId` and a CSV file under
 * {@link MAX_CSV_BYTES}. Closes the v0.2.0 P3 TODO where `uploadCsvAction`
 * had no file-size cap.
 *
 * Read the file body in the Server Action (not here) — this schema only
 * inspects `file.name`, `file.size`, and `file.type` so it stays pure.
 */
export const uploadCsvInputSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  file: z
    .instanceof(File, { message: "file must be a File" })
    .refine((f) => f.size > 0, { message: "file is empty" })
    .refine((f) => f.size <= MAX_CSV_BYTES, {
      message: `file exceeds ${MAX_CSV_BYTES} bytes`,
    }),
});

export type UploadCsvInput = z.infer<typeof uploadCsvInputSchema>;

export type UploadCsvValidation =
  | { success: true; data: UploadCsvInput }
  | { success: false; error: z.ZodError };

export function validateUploadCsvInput(input: unknown): UploadCsvValidation {
  return uploadCsvInputSchema.safeParse(input);
}
