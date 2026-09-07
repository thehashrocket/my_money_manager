/**
 * Renormalizes `transactions.normalized_merchant` and rewrites the trained
 * `category_rules` that key off it, so the ledger and the normalizer agree
 * again after src/lib/normalize.ts changes.
 *
 * Run **inside** the container (`pnpm db:backfill-merchants`), because the live
 * ledger lives in the `mm_data` named volume and both host copies are stale
 * traps. Bundled (not run as-is) by scripts/build-docker-artifacts.mjs into
 * scripts/backfill-merchants.mjs during the Docker builder stage, for the same
 * reason as scripts/snapshot-cli.src.mjs: the runner image has no src/ tree and
 * no devDependencies, so this can't stay a thin import of src/lib/normalize.ts.
 *
 * WHY THIS EXISTS. `normalized_merchant` is a derived column, but it is derived
 * ONCE at write time, by the three write paths (commitImport, syncSimpleFin,
 * manualTransaction). Change the normalizer and the stored column silently
 * belongs to the previous generation, which breaks more than it looks like:
 *
 *   - `buildRuleMatcher` matches `exact` rules with `===`, so every trained rule
 *     still holding an old-generation key stops firing on newly imported rows.
 *   - `/categorize` groups on the STORED column and `bulkCategorize` copies that
 *     value straight into a new rule, so rules trained during the gap are born
 *     unable to match anything, with the UI reporting success.
 *   - `detectSubscriptions` keeps the old key's history and consistent intervals
 *     forever (there is no staleness filter), so one real subscription shows up
 *     twice: a frozen phantom and a new detection months later.
 *
 * SAFETY. Dry run is the default and writes nothing. `--apply` takes a
 * `VACUUM INTO` snapshot first (CLAUDE.md rule 5) under BACKFILL_PREFIX — its
 * OWN pool, which nothing prunes, because both other pools are pruned by
 * ordinary use and this snapshot is the only rollback point this operation has
 * (see the note on BACKFILL_PREFIX in src/lib/snapshot.ts) — then does every
 * write in ONE transaction. Two things refuse rather than warn, each with its
 * own opt-in flag and its own exit code, so a script can tell them apart:
 *
 *   exit 2  a collision whose rules disagree about the CATEGORY, the only class
 *           of change that moves money between envelopes  --resolve-conflicts
 *   exit 3  a degraded snapshot, i.e. the rollback path may not exist
 *                                                  --allow-degraded-snapshot
 *   exit 1  post-write verification failed (see the end of runCli)
 *
 * `planBackfill` is exported and pure so the decisions that move money — which
 * rule survives a collision, which rows change — are unit-tested without a
 * database. See scripts/backfill-merchants.test.mjs.
 */
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { normalizeMerchant } from "../src/lib/normalize.ts";
import { createSnapshot, BACKFILL_PREFIX } from "../src/lib/snapshot.ts";
import { dbPath, snapshotDir } from "../src/lib/paths.ts";

/**
 * Pure planner. Takes the three tables as plain rows, returns every decision
 * without touching a database.
 *
 * @param {{txns: Array, rules: Array, dismissals: Array, normalize?: (s: string) => string}} input
 */
export function planBackfill({ txns, rules, dismissals, normalize = normalizeMerchant }) {
  const newKeyById = new Map();
  /** old key -> Map(new key -> row count). Drives the rule rewrite below. */
  const oldToNew = new Map();

  for (const t of txns) {
    const next = normalize(t.raw_memo);
    newKeyById.set(t.id, next);
    if (!oldToNew.has(t.normalized_merchant)) oldToNew.set(t.normalized_merchant, new Map());
    const counts = oldToNew.get(t.normalized_merchant);
    counts.set(next, (counts.get(next) ?? 0) + 1);
  }

  const changedRows = txns
    .filter((t) => newKeyById.get(t.id) !== t.normalized_merchant)
    .map((t) => ({ id: t.id, next: newKeyById.get(t.id) }));

  // -- rule rewrite -------------------------------------------------------
  const exactRules = rules.filter((r) => r.match_type === "exact");
  const rewritten = [];
  const ambiguous = [];
  for (const rule of exactRules) {
    const counts = oldToNew.get(rule.match_value);
    let next;
    if (!counts) {
      // No row currently carries this key — the merchant hasn't been seen since
      // the rule was trained. Renormalizing the rule's own value is the only
      // evidence available, and it is exact whenever the key is a fixed point.
      next = normalize(rule.match_value);
    } else if (counts.size === 1) {
      next = [...counts.keys()][0];
    } else {
      // An old key that now splits into several. Follow the largest group and
      // report it; the smaller ones lose their rule and fall back to manual
      // categorization rather than being silently mis-filed.
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      next = ranked[0][0];
      ambiguous.push({ rule, ranked });
    }
    rewritten.push({ rule, next });
  }

  // -- collisions ---------------------------------------------------------
  //
  // `category_rules_match_type_value_unique` is on (match_type, match_value), so
  // two rules landing on the same new key is a hard constraint violation, not a
  // preference. The survivor is chosen by what buildRuleMatcher actually does at
  // runtime, which is a sort AND a skip filter (src/lib/rules.ts) — replicating
  // only the sort was a bug:
  //
  //   - SKIP: a rule whose category is archived never fires (rule 8 makes
  //     archiving inert, not deleting). Ranking one of those first would delete
  //     the live rule that WAS firing and keep one that never will, leaving the
  //     merchant with no effective rule at all — worse than either prior state.
  //     So archived-category rules sort last, mirroring the `continue`.
  //   - SORT: priority DESC, then updated_at DESC, with id DESC as a final
  //     tie-break. Picking differently — the plan originally said "lowest id" —
  //     resolves to the OLDEST rule and silently reverts the user's most recent
  //     training.
  //
  // `conflicting` deliberately still counts an archived rule's category. Its
  // merge does not move money today, so this over-asks for --resolve-conflicts
  // in that case; over-asking is the right direction for the one flag that
  // exists to gate money movement, and the printed lines mark which rules are
  // archived so the choice is reviewable.
  const isArchived = (rule) =>
    rule.category_archived_at !== null && rule.category_archived_at !== undefined;

  const byNewValue = new Map();
  for (const entry of rewritten) {
    if (!byNewValue.has(entry.next)) byNewValue.set(entry.next, []);
    byNewValue.get(entry.next).push(entry);
  }

  const collisions = [];
  for (const [value, entries] of byNewValue) {
    if (entries.length < 2) continue;
    const ranked = [...entries].sort(
      (a, b) =>
        Number(isArchived(a.rule)) - Number(isArchived(b.rule)) ||
        b.rule.priority - a.rule.priority ||
        b.rule.updated_at - a.rule.updated_at ||
        b.rule.id - a.rule.id,
    );
    collisions.push({
      value,
      ranked,
      conflicting: new Set(entries.map((e) => e.rule.category_id)).size > 1,
    });
  }

  const losingRuleIds = new Set(
    collisions.flatMap(({ ranked }) => ranked.slice(1).map((e) => e.rule.id)),
  );
  const changedRules = rewritten.filter(
    (r) => r.next !== r.rule.match_value && !losingRuleIds.has(r.rule.id),
  );

  // -- non-exact rules ----------------------------------------------------
  //
  // A `contains` or `regex` rule CANNOT be rewritten: its match_value is a
  // substring or a pattern, not a key, so there is nothing to join through
  // (CLAUDE.md rule 10). Excluding them from the rewrite is correct. Excluding
  // them from the REPORT was the gap this closes.
  //
  // This script is the only thing that ever holds the old and new keys side by
  // side, so it is the only thing that can compute "this rule reached 57 rows
  // before and 0 after." Rule 10 names that as the one permanently unrepairable
  // damage class, and `AMAZON PRIME` / `GOOGLE ONE` were each one normalizer
  // edit away from it.
  //
  // Reported, never refused: the backfill is not what kills such a rule — the
  // normalizer change already did, at the moment it landed. Refusing here would
  // only withhold the repair for the rows. Naming it is the whole of what this
  // script can honestly do about it.
  const matchesRule = (rule, merchant) => {
    switch (rule.match_type) {
      case "exact":
        return rule.match_value === merchant;
      case "contains":
        return merchant.includes(rule.match_value);
      case "regex":
        if (rule.match_value.length > 200) return false;
        try {
          return new RegExp(rule.match_value).test(merchant);
        } catch {
          return false;
        }
      default:
        return false;
    }
  };

  const nonExactRules = rules.filter((r) => r.match_type !== "exact");
  const reachChanges = [];
  for (const rule of nonExactRules) {
    let before = 0;
    let after = 0;
    for (const t of txns) {
      if (matchesRule(rule, t.normalized_merchant)) before++;
      if (matchesRule(rule, newKeyById.get(t.id))) after++;
    }
    if (after !== before) reachChanges.push({ rule, before, after });
  }

  // -- dismissals ---------------------------------------------------------
  //
  // The second table keying off a normalized merchant. It has its own unique
  // index and no foreign key to transactions, so a stale value here is both
  // resurrected as an active subscription AND unreachable from the UI (the page
  // only renders a dismissal that also appears in the detected set, so
  // restoreSubscriptionAction can never be offered for it). Oldest dismissal
  // wins a merge, so the earliest deliberate act is the one preserved.
  const dismissalPlan = [];
  const seen = new Map();
  for (const d of [...dismissals].sort((a, b) => a.dismissed_at - b.dismissed_at)) {
    const counts = oldToNew.get(d.normalized_merchant);
    const next = counts
      ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : normalize(d.normalized_merchant);
    if (seen.has(next)) {
      dismissalPlan.push({ id: d.id, from: d.normalized_merchant, next, action: "delete" });
    } else {
      seen.set(next, d.id);
      dismissalPlan.push({
        id: d.id,
        from: d.normalized_merchant,
        next,
        action: next === d.normalized_merchant ? "keep" : "update",
      });
    }
  }

  const distinctNew = [...new Set(newKeyById.values())];
  return {
    newKeyById,
    changedRows,
    exactRuleCount: exactRules.length,
    nonExactRuleCount: nonExactRules.length,
    reachChanges,
    changedRules,
    ambiguous,
    collisions,
    losingRuleIds,
    dismissalPlan,
    groupsBefore: new Set(txns.map((t) => t.normalized_merchant)).size,
    groupsAfter: distinctNew.length,
    drifting: distinctNew.filter((k) => normalize(k) !== k),
  };
}

// --------------------------------------------------------------------- CLI

function runCli(argv) {
  const args = new Set(argv);
  const APPLY = args.has("--apply");
  const RESOLVE_CONFLICTS = args.has("--resolve-conflicts");
  const ALLOW_DEGRADED_SNAPSHOT = args.has("--allow-degraded-snapshot");

  const db = new Database(dbPath());
  db.pragma("foreign_keys = ON");

  const txns = db
    .prepare(
      "SELECT id, raw_memo, normalized_merchant FROM transactions WHERE raw_memo IS NOT NULL",
    )
    .all();
  // `category_archived_at` joins in because the collision ranking has to
  // replicate buildRuleMatcher's skip filter, not just its sort — see the
  // collisions block in planBackfill.
  const rules = db
    .prepare(
      `SELECT r.id, r.category_id, r.match_type, r.match_value, r.priority, r.updated_at,
              c.archived_at AS category_archived_at
         FROM category_rules r
         JOIN categories c ON c.id = r.category_id`,
    )
    .all();
  const dismissals = db
    .prepare("SELECT id, normalized_merchant, dismissed_at FROM subscription_dismissals")
    .all();
  // Whole row, not just the name: the KEPT/deleted lines below have to be able
  // to say that a category is archived. Showing a bare, plausible category name
  // for an inert rule is what made the archived-rule case unreviewable.
  const categories = new Map(
    db.prepare("SELECT id, name, archived_at FROM categories").all().map((c) => [c.id, c]),
  );

  const plan = planBackfill({ txns, rules, dismissals });
  const say = (line = "") => console.log(line);

  say(`rows:            ${txns.length} (${plan.changedRows.length} keys change)`);
  say(`merchant groups: ${plan.groupsBefore} -> ${plan.groupsAfter}`);
  say(
    `idempotence:     ${plan.groupsAfter - plan.drifting.length}/${plan.groupsAfter} keys are fixed points` +
      (plan.drifting.length
        ? ` (drifting: ${plan.drifting.map((k) => JSON.stringify(k)).join(", ")})`
        : ""),
  );
  say(
    `exact rules:     ${plan.exactRuleCount} total, ${plan.changedRules.length} rewritten, ${plan.ambiguous.length} ambiguous`,
  );
  say(
    `other rules:     ${plan.nonExactRuleCount} contains/regex (never rewritten), ` +
      `${plan.reachChanges.length} change reach`,
  );

  if (plan.reachChanges.length > 0) {
    say("");
    say("CONTAINS/REGEX RULE REACH (cannot be rewritten -- a substring is not a key):");
    for (const { rule, before, after } of plan.reachChanges) {
      const dead = after === 0 && before > 0;
      say(
        `  id=${rule.id} ${rule.match_type} ${JSON.stringify(rule.match_value)} ` +
          `-> category=${categories.get(rule.category_id)?.name}  ${before} rows -> ${after}` +
          (dead ? "   <-- DEAD, and no backfill can repair it" : ""),
      );
    }
    if (plan.reachChanges.some((r) => r.after === 0 && r.before > 0)) {
      say(
        "  A dead rule is caused by the normalizer change, not by this script, and it is\n" +
          "  permanent: retrain it against one of the new keys above, or edit its value.",
      );
    }
  }

  if (plan.ambiguous.length > 0) {
    say("");
    say("AMBIGUOUS RULES (old key now splits; largest group wins):");
    for (const { rule, ranked } of plan.ambiguous) {
      say(
        `  id=${rule.id} ${JSON.stringify(rule.match_value)} -> ` +
          ranked.map(([k, n]) => `${JSON.stringify(k)} x${n}`).join(", "),
      );
    }
  }

  if (plan.collisions.length > 0) {
    say("");
    say(`COLLISIONS: ${plan.collisions.length}`);
    for (const { value, ranked, conflicting } of plan.collisions) {
      say(`  ${JSON.stringify(value)}${conflicting ? "   <-- CATEGORY CONFLICT" : ""}`);
      for (const [i, e] of ranked.entries()) {
        const cat = categories.get(e.rule.category_id);
        say(
          `      id=${e.rule.id} priority=${e.rule.priority} category=${cat?.name}` +
            (cat?.archived_at != null ? " (ARCHIVED — never fires)" : "") +
            (i === 0 ? "   <= KEPT" : "   -- deleted"),
        );
      }
    }
  }

  const dismissalUpdates = plan.dismissalPlan.filter((d) => d.action === "update");
  const dismissalDeletes = plan.dismissalPlan.filter((d) => d.action === "delete");
  say("");
  say(
    `dismissals:      ${dismissals.length} total, ${dismissalUpdates.length} rewritten, ${dismissalDeletes.length} deduped`,
  );

  const conflicting = plan.collisions.filter((c) => c.conflicting);
  if (conflicting.length > 0 && !RESOLVE_CONFLICTS) {
    say("");
    say(
      `REFUSING: ${conflicting.length} collision(s) merge rules that disagree about the category.\n` +
        "That is the only change here that moves money between envelopes, so it needs\n" +
        "an explicit second flag. Review the KEPT lines above, then re-run with:\n" +
        "    pnpm db:backfill-merchants --apply --resolve-conflicts",
    );
    db.close();
    process.exit(2);
  }

  if (!APPLY) {
    say("");
    say("DRY RUN — nothing written. Re-run with --apply to commit.");
    db.close();
    return;
  }

  const snapshot = createSnapshot(dbPath(), snapshotDir(), new Date(), BACKFILL_PREFIX);
  say("");
  say(`snapshot: ${snapshot.snapshotPath} (consistent: ${snapshot.consistent})`);
  // A degraded snapshot REFUSES rather than warns, unlike commitImport, and the
  // difference is not inconsistency. commitImport persists its warning onto
  // import_batches.snapshot_warning where /import/success renders it, AND the
  // batch has a logical undo — so a degraded snapshot there costs a safety net
  // that is already doubled. This operation has neither: no undo, no per-batch
  // record, and it rewrites every row's key and DELETEs rules in one pass. The
  // snapshot IS the rollback path, so proceeding after being told it may not
  // exist is the one thing worth stopping for.
  //
  // Rule 5's measured failure mode is why the warning alone was not enough: with
  // a reader pinned, the fallback plain copy produced a file that would not open
  // at all (SQLITE_CORRUPT), and this script always runs with a reader pinned by
  // construction — you reach it through `docker compose exec` into the running
  // app container.
  //
  // The snapshot file is deliberately NOT deleted on this path. `consistent:
  // false` means VACUUM INTO failed and a plain copy was taken, which is often
  // still restorable; deleting it would throw away a possibly-good rollback
  // point to tidy up an error path.
  if (!snapshot.consistent) {
    say(
      `WARNING: snapshot degraded to a plain copy (${snapshot.degradedReason ?? "unknown"}).`,
    );
    if (!ALLOW_DEGRADED_SNAPSHOT) {
      say(
        "\nREFUSING: this rewrites every merchant key and deletes rules, with no undo\n" +
          "other than that snapshot — and it may not be restorable. Stop the app container\n" +
          "so nothing holds a read on the ledger, then re-run; that is usually all it takes\n" +
          "for VACUUM INTO to succeed. To proceed anyway, accepting that there may be no\n" +
          "way back, add --allow-degraded-snapshot.",
      );
      db.close();
      process.exit(3);
    }
    say("Proceeding anyway: --allow-degraded-snapshot was passed.");
  }

  const updateTxn = db.prepare("UPDATE transactions SET normalized_merchant = ? WHERE id = ?");
  const deleteRule = db.prepare("DELETE FROM category_rules WHERE id = ?");
  const updateRule = db.prepare("UPDATE category_rules SET match_value = ? WHERE id = ?");
  const updateDismissal = db.prepare(
    "UPDATE subscription_dismissals SET normalized_merchant = ? WHERE id = ?",
  );
  const deleteDismissal = db.prepare("DELETE FROM subscription_dismissals WHERE id = ?");

  db.transaction(() => {
    for (const r of plan.changedRows) updateTxn.run(r.next, r.id);
    for (const id of plan.losingRuleIds) deleteRule.run(id);

    // Two passes through a temporary value. The unique index is checked per
    // statement, so rewriting A->B while B still exists (or two rules swapping
    // values) aborts the transaction mid-flight even though the final state is
    // perfectly valid. The temp value carries a leading space, which no
    // normalized key can have — normalizeMerchant trims.
    for (const { rule } of plan.changedRules) updateRule.run(` backfill-${rule.id}`, rule.id);
    for (const { rule, next } of plan.changedRules) updateRule.run(next, rule.id);

    for (const d of dismissalDeletes) deleteDismissal.run(d.id);
    for (const d of dismissalUpdates) updateDismissal.run(` backfill-${d.id}`, d.id);
    for (const d of dismissalUpdates) updateDismissal.run(d.next, d.id);
  })();

  // ---- post-write verification -------------------------------------------
  //
  // Every check here gates the EXIT CODE. Printing a violation on the line
  // below one that already said `APPLIED` and then exiting 0 is how a damaged
  // ledger passes for a clean run — to `pnpm`, to a shell `&&`, and to whoever
  // is skimming the output.
  //
  // The two checks this block used to run could not fail. `normalized_merchant
  // IS NULL` is excluded by a NOT NULL constraint (src/db/schema.ts), so it
  // reported a property of the schema rather than of this run; `raw_memo IS NOT
  // NULL` was a no-op for the same reason. The empty-string case IS reachable
  // (a blank Memo cell normalizes to ""), so that is what gets counted now.
  const emptyKeys = db
    .prepare("SELECT COUNT(*) AS c FROM transactions WHERE normalized_merchant = ''")
    .get().c;

  // The check that actually verifies the backfill did its job: afterwards, no
  // stored key should still move under the normalizer. Catches a row the write
  // loop missed and a rule fallback that landed on a non-fixed-point key.
  const unconverged = db
    .prepare("SELECT id, raw_memo, normalized_merchant FROM transactions")
    .all()
    .filter((t) => normalizeMerchant(t.raw_memo) !== t.normalized_merchant);

  const integrity = db.pragma("integrity_check", { simple: true });
  const fkViolations = db.pragma("foreign_key_check");

  say("");
  say(
    `APPLIED: ${plan.changedRows.length} rows, ${plan.changedRules.length} rules rewritten, ${plan.losingRuleIds.size} rules deleted`,
  );
  say(
    `integrity_check: ${integrity} | foreign_key_check: ${fkViolations.length} violations | ` +
      `empty keys: ${emptyKeys} | unconverged rows: ${unconverged.length}`,
  );

  const failures = [];
  if (integrity !== "ok") {
    failures.push(`integrity_check returned ${JSON.stringify(integrity)}`);
  }
  if (fkViolations.length > 0) {
    failures.push(`${fkViolations.length} foreign key violation(s)`);
    for (const v of fkViolations) say(`  FK VIOLATION: ${JSON.stringify(v)}`);
  }
  if (emptyKeys > 0) {
    failures.push(`${emptyKeys} row(s) carry an empty merchant key`);
  }
  if (unconverged.length > 0) {
    failures.push(`${unconverged.length} row(s) still move under the normalizer`);
    for (const t of unconverged.slice(0, 10)) {
      say(
        `  UNCONVERGED: id=${t.id} stored=${JSON.stringify(t.normalized_merchant)} ` +
          `-> ${JSON.stringify(normalizeMerchant(t.raw_memo))}`,
      );
    }
  }

  db.close();

  if (failures.length > 0) {
    say("");
    say(
      `VERIFICATION FAILED: ${failures.join("; ")}.\n` +
        "The transaction committed, so this is a state to inspect, not a rollback that\n" +
        `already happened. The pre-backfill snapshot is at:\n    ${snapshot.snapshotPath}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
