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
 * schema that validates them, and imported by the buttons that EMIT the value
 * (`_review-queue.tsx`, both constants) and the action that BRANCHES on it
 * (`actions.ts`, `REJECT_INTENT` only — `LINK_INTENT` reaches
 * `resolveSameAccountReversalAction` implicitly, as the `else`). So a rename is
 * a build error at the declaration and at every site that names the constant,
 * rather than a button that silently starts taking the other branch. That
 * mattered enough to wire up because the two branches have opposite effects on
 * money.
 *
 * The stronger guarantee is the annotation on each constant below: typing them
 * `ResolveIntent` makes a bad VALUE a compile error even where the constant is
 * not imported.
 *
 * Both consumers are server-side (`_review-queue.tsx` is a Server Component,
 * `actions.ts` is `"use server"`), so unlike `src/lib/transactions/limits.ts`
 * there is no client-bundle reason to keep these out of a zod module — an
 * earlier revision split them into their own file on exactly that argument and
 * it did not apply. `page.tsx` is NOT a consumer; it imports only the actions.
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

/**
 * `.and()` rather than `.extend()` is FORCED, not chosen.
 *
 * `resolveTransferInputSchema` carries a `.refine`, which makes it a
 * `ZodEffects` — `.extend()` does not exist on one. The obvious
 * "simplification" (flatten both halves into a single `z.object`) would
 * silently drop the `aId !== bId` guard, so the two ids of a "reversal" could
 * name the same row. `validateSyncInputs.test.ts` pins that the refine survives
 * the intersection.
 */

/**
 * Compile-time proof that `intent` is REQUIRED on the wire.
 *
 * This exists because the invariant above is otherwise defended only by two
 * runtime tests. `z.infer` — the OUTPUT type — is byte-identical with and
 * without `.default("link")`: `"link" | "reject"` either way. So adding the
 * default back produces no error in this file, in `ResolveReversalInput`, in
 * `actions.ts`'s destructure, or anywhere else in the repo; `tsc` and `eslint`
 * stay green while a lost submitter silently LINKS a pair again.
 *
 * `z.input` is where the two spellings actually differ — a `.default(...)`
 * makes the key optional on the INPUT side, so `undefined extends …` flips from
 * false to true and this annotation stops compiling (verified: restoring the
 * default fails `tsc` here with TS2322). Same idiom, and the same reason for
 * it, as `NO_UNCARRIED_SCHEMA_KEYS` in
 * `src/app/transactions/_filter-bar.test.ts`: fail at the edit, not at the test
 * run. Kept in the source module rather than in a test because the edit it
 * guards is made HERE.
 */
type IntentInput = z.input<typeof resolveReversalInputSchema>["intent"];
const _INTENT_IS_REQUIRED: undefined extends IntentInput ? never : true = true;
void _INTENT_IS_REQUIRED;

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
