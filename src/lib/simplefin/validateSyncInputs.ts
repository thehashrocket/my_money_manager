import { z } from "zod";

/**
 * Server Action input validation for the sync screen. SimpleFIN account ids are
 * opaque strings from the provider ("ACT-d326a3ba-…"), so they are length- and
 * charset-bounded rather than pattern-matched.
 */
export const linkAccountInputSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  simplefinAccountId: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9._:-]*$/, "unexpected characters in SimpleFIN account id")
    // An empty string is how the form says "unlink".
    .transform((v) => (v.trim() === "" ? null : v.trim())),
});

export const undoSyncInputSchema = z.object({
  batchId: z.coerce.number().int().positive(),
});

export const resolveTransferInputSchema = z
  .object({
    aId: z.coerce.number().int().positive(),
    bId: z.coerce.number().int().positive(),
  })
  .refine((v) => v.aId !== v.bId, {
    message: "a transfer pair needs two different transactions",
  });

export type LinkAccountInput = z.infer<typeof linkAccountInputSchema>;
export type UndoSyncInput = z.infer<typeof undoSyncInputSchema>;
export type ResolveTransferInput = z.infer<typeof resolveTransferInputSchema>;

type Validation<T> = { success: true; data: T } | { success: false; error: z.ZodError };

export function validateLinkAccountInput(i: unknown): Validation<LinkAccountInput> {
  return linkAccountInputSchema.safeParse(i);
}
export function validateUndoSyncInput(i: unknown): Validation<UndoSyncInput> {
  return undoSyncInputSchema.safeParse(i);
}
export function validateResolveTransferInput(
  i: unknown,
): Validation<ResolveTransferInput> {
  return resolveTransferInputSchema.safeParse(i);
}
