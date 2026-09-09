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
 * The two answers the reversal queue's buttons carry. Declared here, next to the
 * schema that validates them, and imported by BOTH the buttons that emit the
 * value (`_review-queue.tsx`) and the action that branches on it
 * (`resolveSameAccountReversalAction`) — so renaming either one is a build
 * error in all three places rather than a button that silently starts taking
 * the other branch. That mattered enough to wire up because the two branches
 * have opposite effects on money.
 *
 * Every consumer is server-side (`_review-queue.tsx` and `page.tsx` are Server
 * Components), so unlike `src/lib/transactions/limits.ts` there is no
 * client-bundle reason to keep these out of a zod module — an earlier revision
 * split them into their own file on exactly that argument and it did not apply.
 */
export const RESOLVE_INTENTS = ["link", "reject"] as const;

export type ResolveIntent = (typeof RESOLVE_INTENTS)[number];

/** The value the primary "Link as reversal" submitter carries. */
export const LINK_INTENT: ResolveIntent = "link";

/** The value the "Not a reversal" submitter carries. */
export const REJECT_INTENT: ResolveIntent = "reject";

/**
 * The same-account reversal queue's form: the two ids, plus which button was
 * pressed.
 *
 * `intent` lives in the schema rather than being read raw off `FormData`
 * because it is the discriminant that chooses between "link these two" (which
 * removes both rows from every spending surface) and "record a durable
 * never-ask-again" — the one field with an opposite effect on money, and so
 * the last one that should skip validation.
 *
 * It is REQUIRED, with no `.default(...)`, and that is load-bearing. An
 * earlier revision defaulted a missing value to `"link"` on the argument that
 * it was the branch "with the stricter guards, which is also the reversible
 * one". Both halves were wrong. Every guard in `linkTransferPairManually`
 * (same-day, not-`manual`, opposite signs, equal magnitude, neither leg
 * already paired) is satisfied BY CONSTRUCTION for any pair this queue can
 * render, so they cannot tell a dropped field from a deliberate click; and the
 * link is not reversible in the sense that matters, because it also calls
 * `clearPairRejection`, erasing a "not a pair" the user had recorded earlier.
 *
 * The real problem was that ABSENCE was the affirmative signal for the
 * destructive branch: "the user pressed Link" and "the submitter's field was
 * lost" were byte-identical on the wire. Both buttons now name themselves, so
 * a lost submitter is a refusal (`Invalid reversal pairing — …`) rather than
 * a silent write of the kind CLAUDE.md rule 4 exists to prevent.
 */
export const resolveReversalInputSchema = resolveTransferInputSchema.and(
  z.object({ intent: z.enum(RESOLVE_INTENTS) }),
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
