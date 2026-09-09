import { eq } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import type { RuleRefusalReport } from "./applyRuleWrite";
import { guardPostCommitRead } from "./postCommitRead";

/**
 * A refusal, turned into the one sentence a surface renders.
 *
 * Built server-side, next to the database, because the fact a user most needs
 * is the NAME of the category the removed rule pointed at — "Rule not saved"
 * told them nothing they could act on, and a bare id less than that.
 *
 * Both toast sites used to compose this themselves from `ruleRefusal.message`
 * plus a boolean, independently and identically. Doing it once here is also
 * what lets the two of them agree about when a restore is on offer.
 */
export type RuleRefusalNotice = {
  reason: RuleRefusalReport["reason"];
  /** Ready to render verbatim. */
  message: string;
  /**
   * True when a rule was removed, so the surface knows to describe the toast's
   * Undo as restoring a rule rather than only un-filing rows.
   */
  removedRule: boolean;
};

export function describeRuleRefusal(
  db: AnyDb,
  refusal: RuleRefusalReport,
): RuleRefusalNotice {
  const { removedRule } = refusal;
  if (removedRule === null) {
    return {
      reason: refusal.reason,
      message: `Rule not saved — ${lowerFirst(refusal.message)}`,
      removedRule: false,
    };
  }

  const category = db
    .select({ name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.id, removedRule.categoryId))
    .get();
  const target = category?.name ?? `category ${removedRule.categoryId}`;
  return {
    reason: refusal.reason,
    message:
      `Removed the rule that was filing these to ${target} — ` +
      `${lowerFirst(refusal.message)} Undo restores it.`,
    removedRule: true,
  };
}

/**
 * {@link describeRuleRefusal} for a caller whose WRITE HAS ALREADY COMMITTED.
 *
 * Every current caller is one: all three of them resolve the refusal at the
 * very end of a Server Action, after the transaction that filed the rows (and
 * may have deleted the merchant's rule) has landed. So this is the shape they
 * all need, and it takes `refusal: RuleRefusalReport | null` rather than a
 * non-null report precisely so a call site cannot spell the null branch — and
 * therefore the guard — for itself.
 *
 * `describeRuleRefusal` READS THE DATABASE (it names the removed rule's
 * category), which after a commit makes it the exact hazard
 * {@link guardPostCommitRead} exists for: a `SQLITE_BUSY` there used to reject
 * the whole action, so the client showed "Categorize failed." / "Move failed."
 * for a write that had succeeded, and — because the snapshot is returned below
 * this call — the 10s Undo toast never appeared, discarding the only copy of a
 * deleted rule's `priorRule` (rule 6; there is no rules-management surface, so
 * that loss is permanent).
 *
 * `runBulkRetarget` carried this block inline with that reasoning attached.
 * The other two call sites did not, and had no way to notice: nothing about
 * `describeRuleRefusal`'s signature says it touches the database. Hence one
 * spelling, imported, rather than a comment asking each caller to remember.
 *
 * The degraded notice is the refusal's OWN sentence — the reason and message
 * `applyRuleWrite` already produced without any lookup — plus whether a rule
 * went. It loses the category's name, which is the part that needed the read;
 * it does not lose the fact that the rule was removed, which is what tells the
 * user the Undo is worth pressing.
 */
export function describeRuleRefusalPostCommit(
  db: AnyDb,
  scope: string,
  refusal: RuleRefusalReport | null,
): RuleRefusalNotice | null {
  if (refusal === null) return null;
  return guardPostCommitRead(scope, () => describeRuleRefusal(db, refusal), {
    reason: refusal.reason,
    message: refusal.message,
    removedRule: refusal.removedRule !== null,
  });
}

/**
 * The refusal messages are standalone sentences (they open with a quoted key,
 * or with "These rows"), and they read as a run-on when appended to a clause.
 * Only the leading letter is touched, so a quoted `"SAFEWAY"` is left alone.
 */
function lowerFirst(sentence: string): string {
  const [first] = sentence;
  if (first === undefined || first !== first.toUpperCase()) return sentence;
  if (!/[A-Za-z]/.test(first)) return sentence;
  return first.toLowerCase() + sentence.slice(1);
}
