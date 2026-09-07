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
 * `VACUUM INTO` snapshot first (CLAUDE.md rule 5) under the pre-migrate prefix,
 * so it never competes for the retention-of-10 pre-import pool, then does every
 * write in ONE transaction. A collision whose rules disagree about the CATEGORY
 * additionally requires `--resolve-conflicts`, because that is the only class of
 * change that moves money between envelopes.
 *
 * `planBackfill` is exported and pure so the decisions that move money — which
 * rule survives a collision, which rows change — are unit-tested without a
 * database. See scripts/backfill-merchants.test.mjs.
 */
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { normalizeMerchant } from "../src/lib/normalize.ts";
import { createSnapshot, PRE_MIGRATE_PREFIX } from "../src/lib/snapshot.ts";
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
  // preference. The survivor is chosen by the SAME order buildRuleMatcher uses
  // at runtime (src/lib/rules.ts compareRules: priority DESC, then updated_at
  // DESC), with id DESC only as a final tie-break. Picking differently — the
  // plan originally said "lowest id" — resolves to the OLDEST rule and silently
  // reverts the user's most recent training.
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

  const db = new Database(dbPath());
  db.pragma("foreign_keys = ON");

  const txns = db
    .prepare(
      "SELECT id, raw_memo, normalized_merchant FROM transactions WHERE raw_memo IS NOT NULL",
    )
    .all();
  const rules = db
    .prepare(
      "SELECT id, category_id, match_type, match_value, priority, updated_at FROM category_rules",
    )
    .all();
  const dismissals = db
    .prepare("SELECT id, normalized_merchant, dismissed_at FROM subscription_dismissals")
    .all();
  const categories = new Map(
    db.prepare("SELECT id, name FROM categories").all().map((c) => [c.id, c.name]),
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
        say(
          `      id=${e.rule.id} priority=${e.rule.priority} category=${categories.get(e.rule.category_id)}` +
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

  const snapshot = createSnapshot(dbPath(), snapshotDir(), new Date(), PRE_MIGRATE_PREFIX);
  say("");
  say(`snapshot: ${snapshot.snapshotPath} (consistent: ${snapshot.consistent})`);
  if (!snapshot.consistent) {
    say(
      `WARNING: snapshot degraded to a plain copy (${snapshot.degradedReason ?? "unknown"}).\n` +
        "It may not be restorable. Stop the container and re-run for a clean rollback point.",
    );
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

  const nullKeys = db
    .prepare(
      "SELECT COUNT(*) AS c FROM transactions WHERE raw_memo IS NOT NULL AND normalized_merchant IS NULL",
    )
    .get().c;
  const integrity = db.pragma("integrity_check", { simple: true });
  const fkViolations = db.pragma("foreign_key_check");

  say("");
  say(
    `APPLIED: ${plan.changedRows.length} rows, ${plan.changedRules.length} rules rewritten, ${plan.losingRuleIds.size} rules deleted`,
  );
  say(
    `integrity_check: ${integrity} | foreign_key_check: ${fkViolations.length} violations | null keys: ${nullKeys}`,
  );
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
