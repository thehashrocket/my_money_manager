import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { describeRuleRefusal } from "./refusalNotice";
import type { PriorRuleSnapshot } from "./priorRuleSnapshot";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedCategory(name: string) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: null,
      isSavingsGoal: false,
      kind: "expense",
      carryoverPolicy: "none",
      archivedAt: null,
    })
    .returning()
    .all();
  return row;
}

function snapshot(categoryId: number): PriorRuleSnapshot {
  return {
    id: 42,
    matchType: "exact",
    categoryId,
    matchValue: "SAFEWAY",
    priority: 50,
    source: "manual",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const MULTI = {
  trainable: false as const,
  reason: "multi-category" as const,
  message:
    '"SAFEWAY" is already filed under a different category, so filing it here as well means no single rule can be right for both.',
};

describe("describeRuleRefusal", () => {
  it("says only that no rule was saved when nothing was removed", () => {
    const notice = describeRuleRefusal(handle.db, {
      ...MULTI,
      removedRule: null,
    });
    expect(notice.removedRule).toBe(false);
    expect(notice.message).toContain("Rule not saved");
    expect(notice.message).toContain("SAFEWAY");
    // No promise of a restore, because there is nothing to restore.
    expect(notice.message).not.toContain("Undo restores");
  });

  it("NAMES the category a removed rule pointed at", () => {
    /* The one fact the user needs to decide whether to hit Undo, and the reason
       this runs server-side at all: the write path has the category ID, not its
       name. "Existing rule removed." — the old copy — named neither. */
    const groceries = seedCategory("Groceries");
    const notice = describeRuleRefusal(handle.db, {
      ...MULTI,
      removedRule: snapshot(groceries.id),
    });
    expect(notice.removedRule).toBe(true);
    expect(notice.message).toContain(groceries.name);
    expect(notice.message).toContain("Removed the rule");
    // And it says the removal is reversible, because the toast carries the Undo.
    expect(notice.message).toContain("Undo restores it");
  });

  it("falls back to the id rather than rendering `undefined` for a missing category", () => {
    // `category_rules.category_id` cascades on delete, so a snapshot naming a
    // category that no longer exists is not reachable today. Degrading to the id
    // keeps the sentence legible if it ever becomes so.
    const notice = describeRuleRefusal(handle.db, {
      ...MULTI,
      removedRule: snapshot(98_765),
    });
    expect(notice.message).toContain("category 98765");
    expect(notice.message).not.toContain("undefined");
  });

  it("lower-cases the appended sentence but leaves a quoted key alone", () => {
    // The refusal messages are standalone sentences, so they read as a run-on
    // when appended to a clause — but the multi-category one opens with a quoted
    // merchant key, which must not be touched.
    const notice = describeRuleRefusal(handle.db, {
      ...MULTI,
      removedRule: null,
    });
    expect(notice.message).toContain('"SAFEWAY"');

    const lossy = describeRuleRefusal(handle.db, {
      trainable: false,
      reason: "lossy-key",
      message:
        "These rows have no merchant name, so a rule would match every future transaction with a blank memo.",
      removedRule: null,
    });
    expect(lossy.message).toContain("these rows have no merchant name");
  });
});
