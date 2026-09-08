import { eq } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import type { RuleRefusalReport } from "./applyRuleWrite";

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
