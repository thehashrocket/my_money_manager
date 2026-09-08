import type { RuleUndoAction } from "./undoBulkCategorize";

/**
 * The clause an undo toast appends to "Reverted N rows."
 *
 * Both undo surfaces threw `ruleAction` away and reported only the row count,
 * which made three different outcomes byte-identical at the one moment the user
 * is checking whether their rule came back: a restore that worked, a delete
 * that found nothing, and an action that never touched a rule. This project has
 * already treated that exact shape as a real bug once — `undoSyncAction`
 * discarding its `UndoResult` made a no-op undo look like a success.
 *
 * Zero imports beyond a type, so both client rows can use it.
 */
export function describeRuleUndo(action: RuleUndoAction): string {
  switch (action) {
    case "restored":
      return " Rule restored.";
    case "deleted":
      return " Rule removed.";
    case "already-gone":
      return " The rule it had added was already gone — left as it is.";
    case "none":
      return "";
  }
}
