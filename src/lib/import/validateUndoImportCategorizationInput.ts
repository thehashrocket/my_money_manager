import { z } from "zod";

/**
 * Server Action input validation for undoing a batch's import-time
 * auto-categorization (`undoImportCategorizationAction`). Same shape as
 * `undoSyncInputSchema` in `src/lib/simplefin/validateSyncInputs.ts` — kept
 * separate rather than shared because it validates a different action in a
 * different route, not because the rule differs.
 */
export const undoImportCategorizationInputSchema = z.object({
  batchId: z.coerce.number().int().positive(),
});

export type UndoImportCategorizationInput = z.infer<
  typeof undoImportCategorizationInputSchema
>;

export type UndoImportCategorizationValidation =
  | { success: true; data: UndoImportCategorizationInput }
  | { success: false; error: z.ZodError };

export function validateUndoImportCategorizationInput(
  input: unknown,
): UndoImportCategorizationValidation {
  return undoImportCategorizationInputSchema.safeParse(input);
}
