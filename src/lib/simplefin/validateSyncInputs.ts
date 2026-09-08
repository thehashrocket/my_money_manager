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

/**
 * The same-account reversal queue's form: the two ids, plus which button was
 * pressed.
 *
 * `intent` lives in the schema rather than being read raw off `FormData`
 * because it is the discriminant that chooses between "link these two" (an
 * undoable write) and "record a durable never-ask-again" — the one field with
 * an opposite effect on money, and so the last one that should skip
 * validation. `.default("link")` encodes the deliberate fail-safe direction:
 * a missing or tampered value takes the path with the stricter guards, which
 * is also the reversible one.
 */
export const resolveReversalInputSchema = resolveTransferInputSchema.and(
  z.object({ intent: z.enum(["link", "reject"]).default("link") }),
);

/** Unlink takes either leg — the pair is cleared from whichever id is given. */
export const unlinkTransferInputSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type LinkAccountInput = z.infer<typeof linkAccountInputSchema>;
export type UndoSyncInput = z.infer<typeof undoSyncInputSchema>;
export type ResolveTransferInput = z.infer<typeof resolveTransferInputSchema>;
export type ResolveReversalInput = z.infer<typeof resolveReversalInputSchema>;
export type UnlinkTransferInput = z.infer<typeof unlinkTransferInputSchema>;

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
export function validateResolveReversalInput(
  i: unknown,
): Validation<ResolveReversalInput> {
  return resolveReversalInputSchema.safeParse(i);
}
export function validateUnlinkTransferInput(
  i: unknown,
): Validation<UnlinkTransferInput> {
  return unlinkTransferInputSchema.safeParse(i);
}
