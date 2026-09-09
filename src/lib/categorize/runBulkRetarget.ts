import { db as defaultDb } from "@/db";
import { bulkRetarget, type BulkRetargetSnapshot } from "./bulkRetarget";
import { describeRuleRefusal, type RuleRefusalNotice } from "./refusalNotice";
import {
  undoBulkRetarget,
  type UndoBulkRetargetResult,
} from "./undoBulkRetarget";
import { validateBulkRetargetInput } from "./validateBulkRetargetInput";
import { validateBulkRetargetSnapshot } from "./validateBulkRetargetSnapshot";

/** The concrete handle both `bulkRetarget` and `undoBulkRetarget` take. */
type Db = typeof defaultDb;

/**
 * Every retarget outcome, as STATE rather than as a thrown error.
 *
 * Next.js replaces the message of an error thrown out of a Server Action with
 * a generic "…omitted in production builds" string plus a digest, and this app
 * ships a production build (`Dockerfile` → `next start`). So the refusals in
 * `bulkRetargetErrors.ts` — whose whole job is to say *"reload to see the
 * current counts"* — were dev-only text, and the commonest of them
 * (`NoRowsToRetargetError`) is by its own docstring reachable from ordinary
 * use: a second tab, or an earlier Undo, empties the source between render and
 * click.
 *
 * This is the shape CLAUDE.md already mandates for exactly this class ("Every
 * `/sync` server action returns its outcome as state rather than throwing…
 * Several failures are reachable from ordinary use"), and that
 * `commitAllocationAction` and `setCategoryKindAction` already use.
 */
export type BulkRetargetRunResult =
  | {
      status: "ok";
      snapshot: BulkRetargetSnapshot;
      updatedCount: number;
      categoryName: string;
      fromCategoryName: string;
      /**
       * Outside `snapshot` for the reason its sibling documents: a refusal is
       * a REASON, not state to reverse, and it is resolved to a finished
       * sentence server-side because naming a removed rule's category needs a
       * lookup.
       */
      ruleRefusal: RuleRefusalNotice | null;
    }
  | { status: "error"; message: string };

export type UndoBulkRetargetRunResult =
  | ({ status: "ok" } & UndoBulkRetargetResult)
  | { status: "error"; message: string };

/**
 * The whole `bulkRetargetAction` pipeline except `revalidatePath`.
 *
 * It lives here, taking an explicit `db`, so that a test can drive the REAL
 * path rather than a hand-written mirror of it. The mirror was not a
 * theoretical problem: `actions.test.ts` re-declared the option object itself
 * and called the library, so deleting `{ allowRuleRemoval: true }` from the
 * action left all 1,755 tests green — while its own docstring claimed to pin
 * "the opt-in is passed by the action rather than merely supported by the
 * library". A test that advertises coverage it does not have is worse than no
 * test, and the regression it missed is rule 6's worst case: a contradicted
 * rule survives and keeps auto-filing every future import, with no
 * rules-management surface to repair it from.
 *
 * `revalidatePath` stays in the action because it closes over the singleton DB
 * and cannot run under `:memory:` — it is now the only untested line there.
 */
export function runBulkRetarget(
  db: Db,
  raw: unknown,
): BulkRetargetRunResult {
  const parsed = validateBulkRetargetInput(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    return { status: "error", message: `Invalid retarget input — ${issues}` };
  }

  let result: ReturnType<typeof bulkRetarget>;
  try {
    /* Same opt-in as `/categorize`'s and the row form's, for the same reason:
       naming a merchant and moving its history is the most deliberate
       per-merchant retrain the app offers, so a refusal here may remove the
       rule the user has just contradicted. An argument, never a form field
       (`applyRuleWrite`). */
    result = bulkRetarget(db, parsed.data, { allowRuleRemoval: true });
  } catch (err) {
    /* The refusals (`NoRowsToRetargetError`, `SameCategoryRetargetError`) and
       the four `assertAssignableCategory` errors all land here. Every one of
       them is thrown BEFORE the UPDATE and inside the transaction, so nothing
       was written — reporting the message is safe, and is the entire point of
       having written it. */
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Move failed.",
    };
  }

  const snapshot: BulkRetargetSnapshot = {
    normalizedMerchant: result.normalizedMerchant,
    fromCategoryId: result.fromCategoryId,
    categoryId: result.categoryId,
    txnIds: result.txnIds,
    ruleTouched: result.ruleTouched,
    priorRule: result.priorRule,
    insertedRuleId: result.insertedRuleId,
    earliestDate: result.earliestDate,
  };

  /* PAST THIS POINT THE WRITE HAS COMMITTED, so nothing below may turn into a
     failure result. `describeRuleRefusal` performs its own DB read (it looks up
     the removed rule's category name), and `SQLITE_BUSY` is a live class in
     this app — WAL mode, `VACUUM INTO` snapshots and `db:export` all hold
     readers. A throw here used to reject the whole action: the client showed
     "Move failed." for a move that had succeeded, and because the snapshot
     never reached the browser there was no Undo toast — discarding the only
     copy of a deleted rule's `priorRule`. A refusal we cannot fully describe
     degrades to the refusal's own sentence; the move is still reported as what
     it is. */
  let ruleRefusal: RuleRefusalNotice | null = null;
  if (result.ruleRefusal !== null) {
    try {
      ruleRefusal = describeRuleRefusal(db, result.ruleRefusal);
    } catch {
      ruleRefusal = {
        reason: result.ruleRefusal.reason,
        message: result.ruleRefusal.message,
        removedRule: result.ruleRefusal.removedRule !== null,
      };
    }
  }

  return {
    status: "ok",
    snapshot,
    updatedCount: result.updatedCount,
    categoryName: result.categoryName,
    fromCategoryName: result.fromCategoryName,
    ruleRefusal,
  };
}

/**
 * The `undoBulkRetargetAction` pipeline except `revalidatePath`.
 *
 * Takes `unknown`: the value arrives from the browser, and typing the
 * parameter as the already-validated snapshot meant a later refactor could
 * delete the validation call and still compile.
 */
export function runUndoBulkRetarget(
  db: Db,
  snapshot: unknown,
): UndoBulkRetargetRunResult {
  const parsed = validateBulkRetargetSnapshot(snapshot);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(snapshot)"}: ${i.message}`)
      .join("; ");
    return { status: "error", message: `Invalid undo snapshot — ${issues}` };
  }

  try {
    return { status: "ok", ...undoBulkRetarget(db, parsed.data) };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Undo failed.",
    };
  }
}
