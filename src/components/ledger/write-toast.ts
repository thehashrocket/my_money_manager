"use client";

import { toast } from "sonner";

/**
 * The Undo window, and the reason the toast has to outlive the default one.
 *
 * Every caller's Undo is the only way back — for the rows, and for a rule a
 * refusal removed (rule 6) — so the toast carrying it stays up long enough to
 * read the notice AND press the button.
 */
const UNDO_WINDOW_MS = 10_000;

/**
 * ONE toast for a committed write, never a success plus a warning.
 *
 * WHY IT IS ONE FUNCTION. `<Toaster>` runs Sonner's default collapsed stack
 * (`expand` unset — `layout.tsx`), where `[data-front="false"] > *` is
 * `opacity: 0`: whichever toast is not the newest has its contents, INCLUDING
 * its action button, drawn invisible until the stack is hovered. Two toasts
 * therefore force a choice between the notice being readable and the Undo
 * being reachable, and on every surface that calls this the Undo is the only
 * way back inside ten seconds. Merging them puts the notice and its remedy on
 * the same front toast. That is CLAUDE.md rule 6, and it was hand-copied into
 * three client files — `/transactions`' row form and its retarget form, and
 * `/categorize`'s merchant row — which were still byte-identical when they
 * were merged here. Three copies of a rule is how this repo's defects start,
 * and the moment the copies still agree is the only comfortable moment to
 * collapse them. This is the TOAST twin of `action-status.tsx`, which made the
 * same move for the inline status line after four spellings of it had drifted.
 *
 * WHAT THE NOTES ARE. Whatever a write that SUCCEEDED still has to say: a rule
 * refusal (rule 6, `describeRuleRefusal`) and a `revalidatePath` that threw
 * after the commit (`guardRefresh`). Either one demotes this from
 * `toast.success` to `toast.warning` — a warning is not a success, which is
 * `/sync`'s doctrine and the same call `statusRole` makes for the inline case.
 * The Undo rides on it either way. `null` and `undefined` are both dropped
 * because the two sources spell "nothing to say" differently: a refusal is
 * `ruleRefusal?.message` (`undefined` when there was none) while a warning
 * arrives as `string | null` from some of the action states.
 *
 * `onUndo` is REQUIRED rather than optional, so this cannot quietly become the
 * helper for a toast with no way back. `/subscriptions` files rules with no
 * undo at all and deliberately does not call this — see the note on its own
 * toast block.
 */
export function notifyWrite(
  headline: string,
  notes: readonly (string | null | undefined)[],
  { onUndo }: { onUndo: () => void | Promise<void> },
): void {
  const said = notes.filter((n): n is string => n !== undefined && n !== null);
  const notify = said.length === 0 ? toast.success : toast.warning;
  notify([headline, ...said].join(" "), {
    duration: UNDO_WINDOW_MS,
    action: { label: "Undo", onClick: onUndo },
  });
}

/**
 * The matching toast for an UNDO that committed.
 *
 * Plain `toast()` rather than `toast.success` — reversing a write is not an
 * achievement to celebrate, and the three surfaces agreed on that before this
 * function existed. The warning half is not cosmetic symmetry: an undo is a
 * committed write too (it is what puts back the rule the refusal removed), so
 * its own failed refresh gets said out loud instead of being swallowed by a
 * neutral "reverted" that reads as everything being settled.
 */
export function notifyUndo(message: string, warning: string | undefined): void {
  if (warning === undefined) toast(message);
  else toast.warning(`${message} ${warning}`);
}
