import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { toPriorRuleSnapshot } from "./priorRuleSnapshot";
import { restorePriorRule } from "./restorePriorRule";
import { createOrUpdateRule, deleteExactRule } from "@/lib/rules";

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

function exactRule(matchValue: string) {
  return handle.db
    .select()
    .from(schema.categoryRules)
    .where(
      and(
        eq(schema.categoryRules.matchType, "exact"),
        eq(schema.categoryRules.matchValue, matchValue),
      ),
    )
    .get();
}

describe("restorePriorRule", () => {
  it("UPDATES in place when the row is still there (the overwrite case)", () => {
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const original = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });
    const snapshot = toPriorRuleSnapshot(original);

    // An upsert retargets the same row, as `createOrUpdateRule` does.
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: household.id,
      source: "manual",
    });

    expect(restorePriorRule(handle.db, snapshot)).toBe("updated");
    expect(exactRule("SAFEWAY")?.categoryId).toBe(groceries.id);
    expect(exactRule("SAFEWAY")?.id).toBe(original.id);
  });

  it("INSERTS under the original id when the row was deleted", () => {
    /* The refusal case. An UPDATE by primary key silently changes nothing on a
       row that is gone, so without the insert fallback a rule removed by a
       refusal stayed removed and the undo still reported success. */
    const groceries = seedCategory("Groceries");
    const original = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });
    const snapshot = toPriorRuleSnapshot(original);
    deleteExactRule(handle.db, "SAFEWAY");
    expect(exactRule("SAFEWAY")).toBeUndefined();

    expect(restorePriorRule(handle.db, snapshot)).toBe("inserted");
    const restored = exactRule("SAFEWAY");
    expect(restored?.id).toBe(original.id);
    expect(restored?.categoryId).toBe(groceries.id);
  });

  it("restores createdAt AND updatedAt byte-for-byte on the insert path", () => {
    /* `updatedAt` is not cosmetic. `compareRules` breaks priority ties on
       `updated_at DESC`, so a restored rule carrying a fresh stamp silently
       outranks a rule that was actually firing — and rule 10's backfill DELETES
       the loser of a `(match_type, match_value)` collision by that same order.
       Dropping this column from the INSERT left the whole suite green. */
    const groceries = seedCategory("Groceries");
    const created = new Date("2026-01-02T03:04:05.000Z");
    const updated = new Date("2026-02-03T04:05:06.000Z");
    const [original] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: groceries.id,
        matchType: "exact",
        matchValue: "SAFEWAY",
        priority: 70,
        source: "auto",
        createdAt: created,
        updatedAt: updated,
      })
      .returning()
      .all();
    const snapshot = toPriorRuleSnapshot(original);
    deleteExactRule(handle.db, "SAFEWAY");

    expect(restorePriorRule(handle.db, snapshot)).toBe("inserted");
    const restored = exactRule("SAFEWAY");
    expect(restored?.createdAt.getTime()).toBe(created.getTime());
    expect(restored?.updatedAt.getTime()).toBe(updated.getTime());
    expect(restored?.priority).toBe(70);
    expect(restored?.source).toBe("auto");
  });

  it("MERGES onto the occupying row instead of throwing on the unique index", () => {
    /* Uniqueness in `category_rules` is on `(match_type, match_value)`, not on
       `id`. A plain INSERT here threw `UNIQUE constraint failed` — and because
       both undo paths call this inside their transaction AFTER reverting rows,
       the throw rolled the whole undo back and surfaced a raw SQLite error
       through a server action.

       Reachable in ordinary use: a refusal removes this key's rule, a second
       Remember tick (or another tab, or a `/subscriptions` run) trains a new one
       for the same key, and the first action's 10s Undo is still open. */
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const original = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });
    const snapshot = toPriorRuleSnapshot(original);
    deleteExactRule(handle.db, "SAFEWAY");

    const replacement = createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: household.id,
      source: "manual",
    });
    expect(replacement.id).not.toBe(original.id);

    expect(restorePriorRule(handle.db, snapshot)).toBe("merged");

    // The undo's INTENT is honoured — the key points where it pointed before.
    // Only the surrogate id differs, and nothing readable depends on it.
    const restored = exactRule("SAFEWAY");
    expect(restored?.categoryId).toBe(groceries.id);
    expect(restored?.id).toBe(replacement.id);
    expect(restored?.updatedAt.getTime()).toBe(snapshot.updatedAt.getTime());
    // Exactly one rule for the key — the merge must not leave two behind.
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(
          and(
            eq(schema.categoryRules.matchType, "exact"),
            eq(schema.categoryRules.matchValue, "SAFEWAY"),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("round-trips the empty key, which a refusal can also remove a rule for", () => {
    // `""` is a real stored key (a blank bank memo), it is in
    // `LOSSY_MERCHANT_KEYS`, and `/transactions` cannot disable its checkbox —
    // so a refusal there removes that key's rule and this is its only way back.
    const misc = seedCategory("Misc");
    const original = createOrUpdateRule(handle.db, {
      normalizedMerchant: "",
      categoryId: misc.id,
      source: "manual",
    });
    const snapshot = toPriorRuleSnapshot(original);
    deleteExactRule(handle.db, "");

    expect(restorePriorRule(handle.db, snapshot)).toBe("inserted");
    expect(exactRule("")?.categoryId).toBe(misc.id);
  });
});

describe("toPriorRuleSnapshot", () => {
  it("refuses a non-exact rule rather than widening the snapshot type", () => {
    /* The snapshot crosses to the client and comes back for Undo, and
       `restorePriorRule` writes it verbatim — so a `regex`/`contains` value in
       there is a way to install an arbitrary rule. Both producers filter on
       `match_type = 'exact'`, so this cannot fire; it is the invariant asserting
       itself at the one place it could be broken. */
    const misc = seedCategory("Misc");
    const [contains] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: misc.id,
        matchType: "contains",
        matchValue: "SOMETHING",
        priority: 40,
        source: "auto",
      })
      .returning()
      .all();

    expect(() => toPriorRuleSnapshot(contains)).toThrow(/expected an exact rule/);
  });
});
