import { z } from "zod";

export const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(100),
  targetDollars: z.coerce.number().positive(),
  carryoverPolicy: z.enum(["none", "rollover", "reset"]).default("none"),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const updateGoalTargetSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  targetDollars: z.coerce.number().positive(),
});

export type UpdateGoalTargetInput = z.infer<typeof updateGoalTargetSchema>;

type GoalValidation<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export function validateCreateGoal(input: unknown): GoalValidation<CreateGoalInput> {
  const result = createGoalSchema.safeParse(input);
  if (!result.success) {
    return { success: false, error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { success: true, data: result.data };
}

export function validateUpdateGoalTarget(input: unknown): GoalValidation<UpdateGoalTargetInput> {
  const result = updateGoalTargetSchema.safeParse(input);
  if (!result.success) {
    return { success: false, error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { success: true, data: result.data };
}
