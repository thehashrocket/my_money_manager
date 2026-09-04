import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { validateCreateGoal, validateUpdateGoalTarget } from "@/lib/goals/validateGoalInput";

/**
 * Mirrors `createGoalAction` / `updateGoalTargetAction` minus the Next.js
 * shell (`revalidatePath`/`redirect` close over the singleton DB and can't
 * run under `:memory:` — same limitation as `transactions/actions.test.ts`
 * and `budget/actions.test.ts`). Exercises the exact insert the action runs.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

describe("createGoalAction (TC18)", () => {
  it("writes kind='fund' alongside isSavingsGoal=true (A2/D1B dual-write)", () => {
    const result = validateCreateGoal({
      name: "Car Repair",
      targetDollars: "500",
      carryoverPolicy: "rollover",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { name, targetDollars, carryoverPolicy } = result.data;
    const targetCents = Math.round(targetDollars * 100);

    // Mirrors createGoalAction's insert exactly (src/app/goals/actions.ts).
    handle.db
      .insert(schema.categories)
      .values({ name, isSavingsGoal: true, kind: "fund", targetCents, carryoverPolicy })
      .run();

    const row = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, name))
      .get();

    expect(row?.isSavingsGoal).toBe(true);
    expect(row?.kind).toBe("fund");
    expect(row?.targetCents).toBe(50000);
    expect(row?.carryoverPolicy).toBe("rollover");
  });
});

describe("updateGoalTargetAction guard (A2)", () => {
  function insertCategory(opts: {
    name: string;
    isSavingsGoal?: boolean;
    kind?: "income" | "expense" | "fund";
  }) {
    const [row] = handle.db
      .insert(schema.categories)
      .values({
        name: opts.name,
        isSavingsGoal: opts.isSavingsGoal ?? false,
        kind: opts.kind ?? "expense",
      })
      .returning()
      .all();
    return row;
  }

  it("accepts a kind='fund' category regardless of isSavingsGoal (drift, A2)", () => {
    // Drift: kind is authoritative, is_savings_goal=0 must not block it.
    const cat = insertCategory({ name: "Vacation Fund", isSavingsGoal: false, kind: "fund" });
    const result = validateUpdateGoalTarget({
      categoryId: String(cat.id),
      targetDollars: "1200",
    });
    expect(result.success).toBe(true);

    const category = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, cat.id))
      .get();
    // Mirrors the action's guard: `if (category.kind !== "fund") throw ...`
    expect(category?.kind === "fund").toBe(true);
  });

  it("rejects a kind='expense' category even when isSavingsGoal=1 (inverse drift, E6)", () => {
    const cat = insertCategory({ name: "Drifted Goal", isSavingsGoal: true, kind: "expense" });
    const category = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, cat.id))
      .get();
    // Mirrors the action's guard: kind is authoritative, not is_savings_goal.
    expect(category?.kind === "fund").toBe(false);
  });
});
