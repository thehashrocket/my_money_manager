import { eq } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import type { PriorRuleSnapshot } from "./priorRuleSnapshot";

/** How the snapshot got back in. See {@link restorePriorRule}. */
export type RuleRestoreMechanism = "updated" | "inserted" | "merged";

/**
 * Put a `priorRule` snapshot back, whether the original call OVERWROTE it
 * (upsert) or REMOVED it (a trainability refusal — see `applyRuleWrite`).
 *
 * Three mechanisms, in the order they are tried:
 *
 *   updated   the row still exists at `prior.id`; set its columns back.
 *   inserted  it is gone and its `(match_type, match_value)` slot is free, so
 *             re-insert it under the SAME id. An UPDATE by primary key silently
 *             no-ops on a row that no longer exists, so the restore has to
 *             notice it changed nothing rather than reporting success.
 *   merged    it is gone and something else now occupies that slot. Uniqueness
 *             in `category_rules` is on `(match_type, match_value)`, NOT on
 *             `id` (`schema.ts`), so a plain INSERT here threw
 *             `UNIQUE constraint failed` — and because both undo paths call
 *             this INSIDE their transaction and AFTER reverting rows, the throw
 *             rolled the whole undo back and surfaced a raw SQLite error. It is
 *             reachable in ordinary use: a refusal deletes this key's rule, a
 *             second Remember tick (or a `/subscriptions` run, or another tab)
 *             trains a new one, then the still-open 10s Undo fires. Writing the
 *             snapshot's columns onto the occupying row honours the undo's
 *             intent — the key points where it pointed before — and only the
 *             surrogate id differs.
 *
 * Shared by both undo paths, because a fix applied to one of them only is how a
 * deleted rule stays deleted on the other.
 *
 * One thing a restore does NOT recover, stated rather than implied by the id
 * reuse: `import_batch_categorizations.rule_id` references this table with
 * `onDelete: "set null"` (`schema.ts`), so the DELETE behind a refusal nulls the
 * provenance pointer on every row that rule ever auto-filed, and re-inserting
 * the rule under the same id does not put those pointers back. Nothing reads
 * that column today — it has writers only (`importBatch.ts`, `simplefin/sync.ts`)
 * — so there is no visible consequence, but the column is genuinely lossy across
 * a delete/restore cycle and the first reader will have to know it.
 */
export function restorePriorRule(
  tx: AnyDb,
  prior: PriorRuleSnapshot,
): RuleRestoreMechanism {
  const columns = {
    categoryId: prior.categoryId,
    matchType: prior.matchType,
    matchValue: prior.matchValue,
    priority: prior.priority,
    source: prior.source,
    createdAt: prior.createdAt,
    updatedAt: prior.updatedAt,
  };
  const updated = tx
    .update(schema.categoryRules)
    .set(columns)
    .where(eq(schema.categoryRules.id, prior.id))
    .returning({ id: schema.categoryRules.id })
    .all();
  if (updated.length > 0) return "updated";

  const [inserted] = tx
    .insert(schema.categoryRules)
    .values({ id: prior.id, ...columns })
    .onConflictDoUpdate({
      target: [schema.categoryRules.matchType, schema.categoryRules.matchValue],
      /* `createdAt`/`updatedAt` included deliberately: the point of a restore is
         that `compareRules` ranks the rule exactly as it did before, and that
         tie-breaker is `updated_at DESC`. Letting the occupying row keep its own
         fresh stamp would silently promote it over a rule that was actually
         firing, and rule 10's backfill DELETES the loser of a collision. */
      set: columns,
    })
    .returning({ id: schema.categoryRules.id })
    .all();
  return inserted !== undefined && inserted.id === prior.id
    ? "inserted"
    : "merged";
}
