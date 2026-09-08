import { eq } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import type { PriorRuleSnapshot } from "./bulkCategorize";

/**
 * Put a `priorRule` snapshot back exactly as it was, whether the original call
 * OVERWROTE it (upsert) or REMOVED it (a trainability refusal — see
 * `deleteExactRule`). An UPDATE by primary key silently no-ops on a row that
 * no longer exists, so the restore has to notice it changed nothing and INSERT
 * instead; the id is re-used deliberately so anything holding it still
 * resolves. Shared by both undo paths, because a fix applied to one of them
 * only is how a deleted rule stays deleted on the other.
 */
export function restorePriorRule(tx: AnyDb, prior: PriorRuleSnapshot): void {
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
  if (updated.length === 0) {
    tx.insert(schema.categoryRules)
      .values({ id: prior.id, ...columns })
      .run();
  }
}
