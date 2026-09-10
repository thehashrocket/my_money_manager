import { and, eq, gte, inArray, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";
import {
  createSnapshot,
  pruneSnapshots,
  type SnapshotResult,
} from "../snapshot";
import { unlinkSync } from "node:fs";
import { dbPath, snapshotDir } from "../paths";
import { readAccessUrl } from "./accessUrl";
import { asFeedAccountId, type FeedAccountId } from "./feedAccountId";
import { fetchAccounts } from "./client";
import { contentSignature } from "../contentSignature";
import { buildRuleMatcher } from "../rules";
import { mapTransaction, type MappedRow } from "./mapTransaction";
import {
  matchTransfers,
  type CrossAccountBucket,
  type SameAccountBucket,
} from "./matchTransfers";
import { findSameAccountReversals } from "./sameAccountReversals";
import {
  clearPairRejection,
  loadRejectedPairs,
  recordPairRejection,
  rejectionPredicate,
} from "@/lib/transferRejections";
import { formatCents, parseAmountToCents } from "@/lib/money";
import { hasAnyTransactionRows } from "@/lib/accounts/hasAnyTransactionRows";
import { importsTransactions } from "@/lib/accounts/importsTransactions";
import type { AccountType } from "@/lib/accounts/loadAccountBalances";
import { isAfterAnchor } from "@/lib/accounts/isAfterAnchor";
import { CARD_TYPES, isCreditCard } from "@/lib/accounts/isCreditCard";
import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import {
  isStartingBalanceCentsInBounds,
  startingBalanceDateSchema,
} from "@/lib/import/accountAnchorFields";
import { toLocalIso, todayIso } from "@/lib/now";
import type { SimpleFinAccount } from "./types";

type Db = typeof defaultDb;

/**
 * The handle `db.transaction()` hands its callback — NOT `Db`, and not `AnyDb`.
 *
 * `verifyStagedLinks` exists for exactly one property: that the re-read happens
 * INSIDE the write transaction. Typed as `AnyDb` that property was enforced by
 * a comment and one call site, so a refactor hoisting the call out of the
 * callback for readability would compile, pass every test (a same-tick relink
 * does not interleave under test), and silently reinstate the race the function
 * was written to close. Naming the transaction type makes that a build error.
 */
type SyncTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * `SyncTx`'s entire value is that `db` is NOT assignable to it — and that is a
 * property of drizzle's class hierarchy (`SQLiteTransaction`'s `protected`
 * members give it nominal-ish assignability), not of this file. A dependency
 * bump that drops those modifiers takes the guarantee away with tsc green and
 * every test passing, leaving the docblock above asserting something no longer
 * true. Same idiom, and the same lesson, as `_INTENT_IS_REQUIRED`: an
 * invariant defended only by runtime tests is one refactor from silent.
 */
type NotAssignable<A, B> = [A] extends [B] ? { ERROR: "A is assignable to B" } : true;
const _DB_IS_NOT_A_TX: NotAssignable<Db, SyncTx> = true;
const _ANYDB_IS_NOT_A_TX: NotAssignable<AnyDb, SyncTx> = true;
void _DB_IS_NOT_A_TX;
void _ANYDB_IS_NOT_A_TX;

/**
 * SimpleFIN hard-caps the window at 90 days. That cap is corroborated directly by
 * the feed, which returns the error string "Requested date range exceeds limit of
 * 90 days and was capped." when you ask for more.
 *
 * 45 is OUR conservative choice, not a documented provider limit — halving the
 * cap leaves headroom if the provider tightens it, and nothing here depends on
 * the exact number. Do not restate it elsewhere as a quoted SimpleFIN rule.
 *
 * This only bounds a FIRST sync — steady state asks for about a week. Anything
 * older than the window has to come from a CSV import; the feed cannot reach it.
 */
const MAX_LOOKBACK_DAYS = 45;
/** Re-ask for a few days already seen, so rows that post late are not missed. */
const OVERLAP_DAYS = 7;
const DAY_SECONDS = 86_400;
/** Pulling up to 45 days of rows is slower than a balance check, but bounded. */
const SYNC_TIMEOUT_MS = 60_000;
/** A balances-only request carries no transaction history, so it gets less rope. */
const BALANCE_TIMEOUT_MS = 30_000;

/**
 * What is known about an account before the ledger is re-read.
 *
 * Split from AccountSyncSummary because the balance figures cannot be computed
 * until after the write. Previously both lived on one type and the balance
 * fields were seeded with `computedBalanceCents: 0` and patched in place, which
 * made an un-finalised summary indistinguishable from a correctly-computed zero
 * balance — and left any account finaliseBalances skipped silently rendering a
 * fabricated 0 in the UI.
 */
export type AccountSyncCounts = {
  accountId: number;
  name: string;
  insertedCount: number;
  /** Already had this exact SimpleFIN id — a re-sync of the same rows. */
  duplicateByExternalId: number;
  /** Already had this row from a CSV import, matched on content. */
  duplicateByContent: number;
  /**
   * Pending rows the feed returned and sync refused to write. Should always be
   * 0 — see the skip in the row loop for why writing them would double-count.
   */
  skippedPending: number;
  /**
   * D8.1 — feed rows on or before a CARD's anchor, dropped by the accounting
   * cutover. Expected to be non-zero on most syncs and deliberately NOT
   * warned about: the fetch window is 45 days and the anchor is recent, so
   * nearly every run sees some. Counted so the drop is a fact the outcome
   * carries rather than an absence nobody can see, and so the acceptance test
   * can assert it. Always 0 for an asset — see the cutover for why.
   */
  skippedBeforeAnchor: number;
  reportedBalanceCents: number | null;
  availableBalanceCents: number | null;
  balanceDate: string | null;
};

export type AccountSyncSummary = AccountSyncCounts & {
  computedBalanceCents: number;
  /**
   * computed − reported. Non-zero means the ledger has drifted from the bank.
   *
   * NULL means one of TWO things: the bank reported no balance, or the link
   * re-check dropped this account mid-sync and its old feed's balance was
   * discarded with the rest of its record. The second was added when
   * `verifyStagedLinks` landed — without it, `finaliseBalances` subtracted the
   * OLD feed's balance from a ledger deliberately missing the withheld rows
   * and reported the difference as drift, i.e. rule 1's "a row is missing or
   * duplicated" signal, manufactured. This field has no reader yet, so this
   * docblock is its whole specification.
   */
  driftCents: number | null;
};

/**
 * A liability whose anchor the balance pass moved. Reported in EVERY outcome,
 * including `up-to-date` — see `refreshLiabilityBalances` for why that matters.
 */
export type LiabilityBalanceUpdate = {
  accountId: number;
  name: string;
  balanceCents: number;
  asOfIso: string;
  priorBalanceCents: number;
  priorAsOfIso: string;
};

export type SyncOutcome =
  | { status: "no-linked-accounts" }
  | {
      status: "up-to-date";
      accounts: AccountSyncSummary[];
      balanceUpdates: LiabilityBalanceUpdate[];
      warnings: string[];
    }
  | {
      status: "synced";
      batchId: number;
      /**
       * Rows actually written, which is NOT necessarily what was staged: a
       * relink that commits during the feed round trip drops that account's
       * rows inside the write transaction (`verifyStagedLinks`). It can
       * therefore be 0 while `status` is still `synced` — the batch exists,
       * it just holds nothing, and `warnings` says why. The `up-to-date`
       * early return above only covers "the feed sent nothing new", which is
       * a different fact and reads differently in the UI.
       */
      insertedCount: number;
      pairsLinked: number;
      ambiguous: CrossAccountBucket<TransferRow>[];
      snapshot: SnapshotResult;
      accounts: AccountSyncSummary[];
      balanceUpdates: LiabilityBalanceUpdate[];
      warnings: string[];
    };

type TransferRow = {
  id: number;
  accountId: number;
  date: string;
  amountCents: number;
  rawMemo: string;
  /** Carries a bank transaction number, so the CSV ±1 matcher already saw it. */
  adjudicatedByTxnNumber: boolean;
};

/**
 * The `(a, b) => rejected?` predicate for a set of candidate rows.
 *
 * ONE query for the whole run, not one per candidate: the matchers evaluate
 * this inside their inner loops (`findTransferPairs`' bucket scan,
 * `assignAvoidingRejections`' backtracking), and better-sqlite3 is
 * synchronous, so a per-pair round trip would block the event loop
 * quadratically. Scoped to the rows in hand — `transfer_pair_rejections`
 * accumulates forever by design.
 */
function rejectionPredicateFor(rows: TransferRow[], db: Db) {
  return rejectionPredicate<TransferRow>(
    loadRejectedPairs(db, rows.map((r) => r.id)),
  );
}

function isoDaysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * DAY_SECONDS * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Starts a week before the OLDEST of the per-account newest rows — not the
 * newest overall. Taking the oldest means an account that has lagged behind
 * still gets its gap re-fetched rather than being skipped past. The overlap
 * covers rows that post a few days late.
 *
 * The alternative, re-fetching the full 45-day window every time, is avoided for
 * bandwidth rather than for correctness: re-sent rows all carry an external_id
 * and would be caught by the cheap `seenExternalIds` set, never by content
 * dedup, which only ever applies to CSV rows.
 */
export function resolveStartDate(
  latestDates: (string | null)[],
  now: Date = new Date(),
): { startIso: string; startUnix: number } {
  const floorIso = isoDaysAgo(MAX_LOOKBACK_DAYS, now);
  const known = latestDates.filter((d): d is string => !!d);

  let startIso: string;
  if (known.length === 0 || known.length !== latestDates.length) {
    // A linked account with no history at all — take the whole window.
    startIso = floorIso;
  } else {
    const oldestLatest = known.sort()[0];
    const withOverlap = new Date(`${oldestLatest}T00:00:00Z`);
    withOverlap.setUTCDate(withOverlap.getUTCDate() - OVERLAP_DAYS);
    let candidate = withOverlap.toISOString().slice(0, 10);
    // A single future-dated row (a CSV typo, or a feed timestamp ahead of local
    // time) would otherwise push the window past today, so the feed returns
    // nothing and every later sync reports "up to date" while importing nothing.
    const todayIso = now.toISOString().slice(0, 10);
    if (candidate > todayIso) candidate = todayIso;
    startIso = candidate < floorIso ? floorIso : candidate;
  }

  return {
    startIso,
    startUnix: Math.floor(new Date(`${startIso}T00:00:00Z`).getTime() / 1000),
  };
}

type LinkedAccount = typeof schema.accounts.$inferSelect;

/**
 * Splits the linked accounts into the ones whose TRANSACTIONS we import and
 * the ones we only ever read a BALANCE for.
 *
 * E1 — D3=A ("the mortgage never gets a transaction row") was asserted in
 * prose across four decisions and enforced by no code. The linked-account
 * query has no type filter and the staging loop runs over every row it
 * returns, so linking the mortgage imported its transactions: interest,
 * escrow and principal rows into the categorize backlog and, once
 * categorized, into budget spend — double-counting the mortgage payment you
 * already budget for on the checking side. Worse, it was self-disabling:
 * once the loan had rows, the zero-row-scoped balance pass below skipped it
 * forever, leaving an amber staleness label as the only symptom.
 *
 * E2 — this must PARTITION, not exclude, and the difference is the whole
 * function. Dropping liability ids from `linked` would also drop them from
 * the `accountIds` sent to the feed, so there would be no balance to write.
 * They stay in the one fetch and are steered away from staging instead.
 *
 * D4.3 — THE SPLIT IS NO LONGER asset-vs-liability, AND THAT IS THE POINT.
 * It asks `importsTransactions`, which puts a feed-linked CARD on the import
 * side and leaves the mortgage where it was. Three things follow, and each was
 * a reason to change this function rather than special-case a caller:
 *
 *   1. A card that imports never reaches `refreshLiabilityBalances`, so its
 *      `has-rows` branch — "its balance was not refreshed from the feed,
 *      update it from the Accounts page" — cannot fire for it. That warning is
 *      true and would fire on EVERY sync forever once the card had one row,
 *      telling the user to do a thing this plan deliberately chose against. A
 *      permanent warning is one people learn to skip, which costs the ones
 *      that matter. Making it structurally unreachable beats suppressing it.
 *   2. The card gets a `counts` entry, so `finaliseBalances` computes its
 *      drift. Under the old split it had none, so the app's only
 *      ledger-vs-bank integrity check never looked at it.
 *   3. `resolveBalanceAction` has to agree, or the row renders a Refresh
 *      button wired to a pass that no longer considers the account (D9.2). It
 *      reads the same predicate, which is why the predicate is a module and
 *      not a conjunction inlined here.
 *
 * NO THIRD BUCKET, and the absence is deliberate. The reviewed design said
 * "three-way partition"; written out, the third case — a linked card that does
 * not import — is unreachable, because `importsTransactions` is exactly
 * "linked AND not a loan" for anything this function can see. An empty bucket
 * would be dead code that a reader has to disprove. One predicate, two
 * buckets, and the predicate carries the reasoning.
 */
export function partitionLinkedAccounts(linked: readonly LinkedAccount[]): {
  importAccounts: LinkedAccount[];
  balanceOnlyAccounts: LinkedAccount[];
} {
  const importAccounts: LinkedAccount[] = [];
  const balanceOnlyAccounts: LinkedAccount[] = [];
  for (const a of linked) {
    if (importsTransactions(a)) importAccounts.push(a);
    else balanceOnlyAccounts.push(a);
  }
  return { importAccounts, balanceOnlyAccounts };
}

/**
 * Moves a zero-row liability's anchor to the balance the feed reports.
 *
 * D7=B + D15=A, narrowed twice. SCOPE IS ZERO-TRANSACTION-ROW ACCOUNTS ONLY —
 * in practice, the mortgage. Rule 1 requires the anchor to be the balance at
 * the CLOSE of `starting_balance_date`, and SimpleFIN's `balance-date` is a
 * nullable INSTANT. Collapsing `2026-09-06T14:32Z` to `2026-09-06` and
 * storing it asserts a close-of-day figure the feed never claimed, and the
 * strict `>` then drops every row later that same day out of the balance. For
 * an account with no rows at all the SUM is zero regardless, so the
 * imprecision is unobservable — which is exactly why credit cards, which do
 * carry rows, get manual reconcile only.
 *
 * "Zero rows" means `hasAnyTransactionRows`: EXISTS with no anchor filter
 * (E16). The cheap anchor-filtered count would call a freshly reconciled card
 * zero-row and make it eligible for this pass.
 *
 * PLACEMENT IS PART OF THE CONTRACT. This runs BEFORE `syncSimpleFin`'s
 * `up-to-date` early return and its result is carried in every outcome. That
 * return renders as "nothing new to import", so a balance pass hidden behind
 * it would mutate state while the UI claimed it had not.
 *
 * No import batch and no transaction rows: this is an anchor move, not an
 * import, and `undoSyncBatch` deletes rows only. The prior anchor goes onto
 * the account row itself (E19) — there is no batch to hang it on — which is
 * also the real mechanism `/accounts/error.tsx` reassures the user with.
 *
 * THE LINK IS RE-VERIFIED PER ACCOUNT, INSIDE A TRANSACTION, for the same
 * reason `verifyStagedLinks` does it for the row insert — and with more force,
 * not less. `balanceOnlyAccounts` is derived from the account list read BEFORE
 * `await fetchAccounts`, so `account.simplefinAccountId` is a precondition
 * carried across an await and `setAccountLink` can commit in that window from
 * a second `/sync` tab. What this function writes is an ANCHOR: under rule 1
 * that is the account's entire balance, not a batch of rows, and under rule 9
 * `prior_starting_balance_*` holds exactly ONE prior value — so a wrong-feed
 * write here is both larger and less recoverable than a misfiled row, which
 * `undoSyncBatch` can delete.
 *
 * The re-read also supplies `prior_starting_balance_*` and the no-op check.
 * Using the pre-await `account` for those would let a hand Reconcile that
 * landed during the fetch be silently overwritten AND have its own prior
 * clobbered with a value two writes stale.
 */
function refreshLiabilityBalances(
  balanceOnlyAccounts: readonly LinkedAccount[],
  byExternalId: ReadonlyMap<string, SimpleFinAccount>,
  db: Db,
  now: Date,
): { updates: LiabilityBalanceUpdate[]; warnings: string[] } {
  const updates: LiabilityBalanceUpdate[] = [];
  const warnings: string[] = [];

  for (const account of balanceOnlyAccounts) {
    // The feed this account was linked to when the account list was read,
    // BEFORE the network round trip. The re-check below compares against it.
    const stagedFeedId = asFeedAccountId(account.simplefinAccountId!);
    const remote = byExternalId.get(stagedFeedId);
    if (!remote) {
      // The staging loop has its own version of this warning; a balance-only
      // account is not in that loop, so without this a mortgage the feed
      // stopped returning would go completely silent.
      warnings.push(
        `SimpleFIN returned nothing for "${account.name}" — its balance was not updated.`,
      );
      continue;
    }

    const balanceDateUnix = remote["balance-date"];
    if (balanceDateUnix === null || balanceDateUnix === undefined) {
      // Without a date from the provider there is no defensible anchor date:
      // using today would assert a close-of-day balance for a figure that
      // might be weeks old, and silently reset DS57's staleness clock.
      warnings.push(
        `SimpleFIN sent a balance for "${account.name}" but no date for it, so it was left unchanged.`,
      );
      continue;
    }

    let balanceCents: number;
    try {
      balanceCents = parseAmountToCents(remote.balance);
    } catch {
      warnings.push(`SimpleFIN sent an unreadable balance for "${account.name}".`);
      continue;
    }

    const asOfDate = new Date(balanceDateUnix * 1000);
    const asOfIso = toLocalIso(asOfDate);

    // The same shared bounds every other anchor writer uses. Nothing writes
    // these columns with its own validation (CLAUDE.md rule 1).
    if (!isStartingBalanceCentsInBounds(balanceCents)) {
      warnings.push(`SimpleFIN's balance for "${account.name}" was out of range and ignored.`);
      continue;
    }
    if (!startingBalanceDateSchema.safeParse(asOfIso).success || asOfIso > todayIso(now)) {
      warnings.push(`SimpleFIN dated "${account.name}"'s balance invalidly, so it was ignored.`);
      continue;
    }

    // THE SIGN. Rule 9 stores a liability negative, and this is the only
    // anchor writer that does not route through `owedDollarsToSignedCents` —
    // it takes whatever the provider sends, on the app's only untrusted input,
    // with no human in the loop. A provider reporting a card as positive
    // amount-owed ("2148.00") would write +214800, which `summarizeBalances`
    // then adds to the Debt total as a positive and `moneyTone` paints green
    // as a credit balance: net worth wrong by twice the number, no error, and
    // a figure that looks entirely plausible.
    //
    // Split by type rather than refused outright, because "a liability is
    // always negative" is NOT an invariant — `summarizeBalances` deliberately
    // blesses a positive card balance as a real credit balance from an
    // overpayment. So:
    //
    //   loan/mortgage  a positive balance is meaningless. Refuse. (You cannot
    //                  overpay your way into the bank owing you a house.)
    //   credit card    a positive balance is legal but rare. Write it, and say
    //                  so, because it is far likelier to be a sign-convention
    //                  mismatch than a real overpayment.
    //
    // Refusing BOTH was the first draft and is wrong: a card with a genuine
    // credit balance and no rows resolves to Refresh, not Reconcile
    // (`resolveBalanceAction`), so a blanket refusal would leave it with no
    // working control at all — E4's failure, which `_account-row.tsx` already
    // documents getting caught by once.
    //
    // THE CARD ARM IS UNREACHABLE FROM BOTH CALLERS AS OF D4.3, and that is
    // recorded rather than acted on. Both callers pass `balanceOnlyAccounts`,
    // which is now `linked && !importsTransactions` — and for a LINKED account
    // that is exactly "is a loan". No card reaches this function any more, so
    // the paragraph above describes a state the app cannot currently produce
    // (and `resolveBalanceAction` no longer gives a linked card Refresh
    // either, D9.2 — the two moved together on purpose).
    //
    // Kept anyway, and the distinction matters: this is a rule 9 SIGN GUARD,
    // not a cache with no reader. `refreshLiabilityBalances` takes an
    // arbitrary account list, deleting the arm would make a future caller's
    // positive card balance write UNGUARDED, and the cost of keeping it is
    // five lines. What it must not do is rot into a claim that cards get feed
    // balances — hence this note. Tracked in TODOS.md.
    // The loan half of the guard REFUSES, so it has to run before the no-op
    // check — a refusal is about the figure itself, not about whether it moved.
    if (balanceCents > 0 && isLongTermLiability(account.type)) {
      warnings.push(
        `SimpleFIN reported a positive balance for "${account.name}", which a loan cannot have, so it was ignored.`,
      );
      continue;
    }

    // Everything above judged the FEED's figure and needs no ledger state.
    // Everything below reads or writes the account row, so it runs in one
    // transaction that re-verifies the link first. `applied` is what the
    // transaction actually did — never assumed from having reached here.
    const applied = db.transaction((tx) => {
      const current = tx
        .select({
          simplefinAccountId: schema.accounts.simplefinAccountId,
          startingBalanceCents: schema.accounts.startingBalanceCents,
          startingBalanceDate: schema.accounts.startingBalanceDate,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, account.id))
        .get();

      if (current === undefined) {
        return { kind: "deleted" as const };
      }
      if (current.simplefinAccountId !== stagedFeedId) {
        return { kind: "relinked" as const, unlinked: current.simplefinAccountId === null };
      }
      // Re-checked here, not before the transaction: a row imported during the
      // fetch window makes this account ineligible (D7/D15), and the pre-await
      // answer could say otherwise.
      if (hasAnyTransactionRows(account.id, tx)) {
        return { kind: "has-rows" as const };
      }
      if (
        balanceCents === current.startingBalanceCents &&
        asOfIso === current.startingBalanceDate
      ) {
        return { kind: "no-op" as const };
      }

      tx.update(schema.accounts)
        .set({
          startingBalanceCents: balanceCents,
          startingBalanceDate: asOfIso,
          priorStartingBalanceCents: current.startingBalanceCents,
          priorStartingBalanceDate: current.startingBalanceDate,
          balanceAsOf: asOfDate,
          balanceSource: "feed",
          updatedAt: now,
        })
        .where(eq(schema.accounts.id, account.id))
        .run();

      return {
        kind: "written" as const,
        priorBalanceCents: current.startingBalanceCents,
        priorAsOfIso: current.startingBalanceDate,
      };
    });

    if (applied.kind === "deleted") {
      warnings.push(
        `"${account.name}" was deleted while the sync was running, so its balance was not updated.`,
      );
      continue;
    }
    if (applied.kind === "relinked") {
      warnings.push(
        applied.unlinked
          ? `"${account.name}" was unlinked while the sync was running, so its balance was not updated.`
          : `"${account.name}" was re-linked to a different bank account while the sync was running, so its balance was not updated — sync again to refresh it against the current link.`,
      );
      continue;
    }
    if (applied.kind === "has-rows") {
      warnings.push(
        `"${account.name}" has transactions, so its balance was not refreshed from the feed. Update it from the Accounts page.`,
      );
      continue;
    }
    if (applied.kind === "no-op") {
      continue; // Nothing moved; do not manufacture a report.
    }

    // The card half only ANNOUNCES, and belongs after the write succeeded —
    // both because a no-op should stay silent (a stable overpaid card used to
    // render a red error under its Refresh button forever, since the action
    // treats "no update + a warning" as a failure) and because a refusal above
    // must not be accompanied by a remark about a balance nothing accepted.
    if (balanceCents > 0) {
      warnings.push(
        `SimpleFIN reports "${account.name}" as ${formatCents(balanceCents)} — a credit balance. If that is wrong, set it with Reconcile on the Accounts page.`,
      );
    }

    // Reported ONLY on the written branch. Pushing this unconditionally made
    // `describeBalanceUpdates` announce "Balance updated: X is now $Y" for an
    // account whose UPDATE matched zero rows — a fabricated durable fact, and
    // the `/sync` doctrine's "a no-op is never reported as a completed action"
    // violated on the one write rule 9 calls silent and expensive.
    updates.push({
      accountId: account.id,
      name: account.name,
      balanceCents,
      asOfIso,
      priorBalanceCents: applied.priorBalanceCents,
      priorAsOfIso: applied.priorAsOfIso,
    });
  }

  return { updates, warnings };
}

export type BalanceRefreshOutcome =
  | { status: "no-linked-accounts" }
  | { status: "ok"; updates: LiabilityBalanceUpdate[]; warnings: string[] };

/**
 * The balance pass ALONE — no import, no snapshot, no batch, no matcher.
 *
 * `/accounts`' per-row Refresh used to call `syncSimpleFin({})`, the whole
 * import: 45 days of transactions for every linked asset account, a
 * `VACUUM INTO` snapshot, an undoable batch, auto-categorization, the transfer
 * matcher, and snapshot pruning. It then reported one balance and discarded
 * the rest of `SyncOutcome` — including `snapshot.consistent`, which rule 5
 * says in so many words not to ignore, and `response.errors`, whose omission
 * is what `sync/actions.ts` documents as having "made a dead connection render
 * as a green 'Already up to date'". Clicking Refresh on the mortgage row
 * imported forty checking transactions and said "Mortgage is unchanged."
 *
 * Reporting was the symptom; scope was the defect. DS55 offers Refresh per row
 * precisely because eligibility is a per-account property (E4), so the control
 * has no business running a global import. This is the operation the button
 * always claimed to be.
 *
 * `balancesOnly` is the feed's own parameter and was already built, tested and
 * used by `link.ts` for the same reason — linking needs names and balances,
 * not history. Nothing new had to be added to the client for this.
 *
 * `accountId` narrows the pass to ONE account, and `/accounts`' per-row button
 * always passes it. Without it the "per-row" control still moved the anchor on
 * every feed-linked zero-row liability — and since each of those writes
 * overwrites that account's single `prior_starting_balance_*` slot (rule 9),
 * one click on the mortgage could spend the undo on a card the user never
 * touched. It also scopes `warnings`, so a row can never report a different
 * account's failure as its own.
 */
export async function refreshLiabilityBalancesOnly(
  opts: { now?: Date; signal?: AbortSignal; accountId?: number } = {},
  db: Db = defaultDb,
): Promise<BalanceRefreshOutcome> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  const linked = db
    .select()
    .from(schema.accounts)
    .where(isNotNull(schema.accounts.simplefinAccountId))
    .all();

  if (linked.length === 0) return { status: "no-linked-accounts" };

  const { balanceOnlyAccounts } = partitionLinkedAccounts(linked);
  const scoped =
    opts.accountId === undefined
      ? balanceOnlyAccounts
      : balanceOnlyAccounts.filter((a) => a.id === opts.accountId);
  if (scoped.length === 0) {
    return { status: "ok", updates: [], warnings };
  }

  const creds = readAccessUrl();
  const response = await fetchAccounts(creds, {
    // No history is wanted, so ask for none: `balancesOnly` makes the window
    // irrelevant, and `now` keeps the request honest if a provider ignores it.
    startDate: Math.floor(now.getTime() / 1000),
    accountIds: scoped.map((a) => a.simplefinAccountId!),
    balancesOnly: true,
    signal: opts.signal ?? AbortSignal.timeout(BALANCE_TIMEOUT_MS),
  });

  // A bank connection can fail while the HTTP request succeeds — SimpleFIN
  // reports that in `errors[]` on a 200. Dropping these is exactly what turned
  // a dead connection into a green success message on `/sync`.
  for (const err of response.errors ?? []) warnings.push(err);

  const byExternalId = new Map<string, SimpleFinAccount>();
  for (const a of response.accounts ?? []) byExternalId.set(a.id, a);

  const pass = refreshLiabilityBalances(scoped, byExternalId, db, now);
  warnings.push(...pass.warnings);
  return { status: "ok", updates: pass.updates, warnings };
}

/**
 * Fetch, dedup, insert, link transfers. Writes straight to the DB (no preview
 * step) but takes a pre-write snapshot first per CLAUDE.md rule 5, and every
 * batch is reversible via undoSync().
 *
 * Deliberately does NOT request `pending=1`: Star One exposes no pending rows
 * anyway, and pending rows mutate when they post, which this insert-or-skip
 * model has no update path for. Pending activity is still visible as the gap
 * between reported balance and available balance.
 */
export async function syncSimpleFin(
  opts: { now?: Date; signal?: AbortSignal } = {},
  db: Db = defaultDb,
): Promise<SyncOutcome> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];

  const linked = db
    .select()
    .from(schema.accounts)
    .where(isNotNull(schema.accounts.simplefinAccountId))
    .all();

  if (linked.length === 0) return { status: "no-linked-accounts" };

  const { importAccounts, balanceOnlyAccounts } = partitionLinkedAccounts(linked);

  // REGRESSION R1 — `importAccounts`, never `linked`. resolveStartDate widens
  // to the full 45-day floor when ANY account it is given has no history
  // (`known.length !== latestDates.length`), and a balance-only liability has
  // no history permanently by D3=A. Passing `linked` here would therefore pin
  // EVERY sync to the 45-day window forever, re-running content dedup over six
  // weeks of already-imported rows on every single run.
  //
  // D8.1 makes R1 FIRE for real, temporarily, and that is accepted rather than
  // fixed. A newly importing card joins `importAccounts` with zero rows, so
  // `known.length !== latestDates.length` is true and every sync widens to 45
  // days until its first row lands — and at the measured ~1.7 charges a month,
  // with the cutover discarding everything on or before the anchor, that can
  // be weeks. It is one wide content-dedup pass over ~272 checking rows on a
  // synchronous local driver, it is self-healing on the first imported row,
  // and the alternative (seeding a fake `MAX(date)` for the card) would move
  // the window based on a date no row carries. Named here so the next reader
  // recognises it as the documented case rather than a new bug.
  const latestDates = importAccounts.map((a) => {
    const row = db
      .select({ max: sql<string | null>`MAX(${schema.transactions.date})` })
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, a.id))
      .get();
    return row?.max ?? null;
  });

  const { startIso, startUnix } = resolveStartDate(latestDates, now);

  const creds = readAccessUrl();
  const response = await fetchAccounts(creds, {
    startDate: startUnix,
    // E2 — ALL linked ids, including the balance-only ones. This is why the
    // fix had to partition rather than exclude: drop the liabilities here and
    // there is no balance for the pass below to write.
    accountIds: linked.map((a) => a.simplefinAccountId!),
    // A user-supplied signal wins; otherwise fall back to a deadline so a
    // stalled bridge cannot hang the sync indefinitely.
    signal: opts.signal ?? AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });

  for (const err of response.errors ?? []) warnings.push(err);

  const byExternalId = new Map<string, SimpleFinAccount>();
  for (const a of response.accounts ?? []) byExternalId.set(a.id, a);

  // ---- dedup, per account ----
  // `feedId` rides along rather than being re-derived in the write loop:
  // it is the SAME non-null binding the dedup predicates keyed off, so the
  // value that decided a row was new is the value stored as its provenance.
  type Staged = {
    account: (typeof linked)[number];
    feedId: FeedAccountId;
    rows: MappedRow[];
    /** Pending-skip and dead-connection notes, flushed only if this account survives the link re-check. */
    accountWarnings: string[];
    /**
     * D8.4 — every external id the feed sent for a CARD that this sync did
     * NOT intentionally decide to exclude (pending, pre-anchor). Empty for
     * every non-card account; see the completeness check below for why the
     * scope is narrower than "every account".
     */
    expectedCardExternalIds: string[];
  };
  const staged: Staged[] = [];
  const counts: AccountSyncCounts[] = [];

  for (const account of importAccounts) {
    // Non-null by construction: `importAccounts` comes from the linked-account
    // query. Named once because the id pass, the content pass and the insert
    // below all key off it, and `accounts.$inferSelect` types the column as
    // nullable.
    // Minted once, here. Everything downstream — the dedup predicates, the
    // provenance column, the link re-check — takes the branded type, so the
    // transaction id or a bare name cannot reach any of them.
    const feedId = asFeedAccountId(account.simplefinAccountId!);
    const remote = byExternalId.get(feedId);
    // Buffered, not pushed. Every warning in this loop is a statement about an
    // import that has not happened yet — `verifyStagedLinks` can still withhold
    // this account entirely, and a retracted import must not leave behind a
    // sentence promising rows will arrive. Flushed for survivors only, below.
    const accountWarnings: string[] = [];
    if (!remote) {
      accountWarnings.push(
        `SimpleFIN returned nothing for "${account.name}" — the connection may need re-authorising.`,
      );
    }

    // Scoped by FEED, not by the local account — this is the whole cross-account
    // double-count fix. Keyed on `account_id`, this query could not see rows the
    // same feed had already produced under a DIFFERENT local account, so
    // re-pointing a link made every one of those rows look new and sync
    // re-imported the lot, silently. Keyed on the feed, provenance answers the
    // question directly: "has this feed already given us this id, anywhere?"
    //
    // Deliberately NOT bounded by date, and it must keep matching the partial
    // unique index exactly. The index is unbounded too, so any narrower window
    // here leaves a gap where a row escapes the in-memory check and hits the
    // constraint instead — aborting the whole batch with a raw SqliteError. A
    // feed row's date comes from `posted`, but postedToIsoDate falls back to
    // `transacted_at`, so a derived date can legitimately precede startIso.
    const seenExternalIds = new Set(
      db
        .select({ externalId: schema.transactions.externalId })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.simplefinSourceAccountId, feedId),
            isNotNull(schema.transactions.externalId),
          ),
        )
        .all()
        .map((r) => r.externalId)
        .filter((v): v is string => !!v),
    );
    // D8.4 — a FROZEN copy, taken before the loop mutates `seenExternalIds`
    // to also catch WITHIN-RESPONSE duplicates (below). An id in this frozen
    // set was in the DB, under this feed's own provenance, before this sync
    // ran — the one fact D8.4's "findable" claim actually depends on. An id
    // that only entered `seenExternalIds` because an EARLIER transaction in
    // THIS SAME response used it is not covered by that fact: if that earlier
    // occurrence was itself dropped by content-dedup (a real, if rare, case —
    // nothing validates that a feed response carries no repeated id), it was
    // never written under this feed's tag either, and `checkCardCompleteness`
    // would report a permanent false "missing" alarm for an id that was
    // always correctly, quietly deduped.
    const idsKnownBeforeThisRun = new Set(seenExternalIds);

    // Content dedup only has to cover what the feed can actually send, which the
    // 45-day cap bounds — so this uses the lookback floor rather than startIso.
    // Bounding it at startIso let a feed row dated before the window content-match
    // nothing and insert a duplicate of an older CSV row.
    const contentFloorIso = isoDaysAgo(MAX_LOOKBACK_DAYS, now);
    const existingByContent = db
      .select({
        date: schema.transactions.date,
        amountCents: schema.transactions.amountCents,
        rawMemo: schema.transactions.rawMemo,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, account.id),
          // A row is a content-dedup candidate when THIS feed cannot already
          // have claimed it by id. Three cases qualify, and only the first is
          // what `external_id IS NULL` alone would have caught:
          //
          //  1. CSV rows (external_id NULL) — the original case: the feed
          //     re-sends days already imported from a file.
          //  2. Rows from a DIFFERENT feed. Re-running `simplefin:claim` mints
          //     fresh account ids for the same real bank account, so the same
          //     transaction can arrive under a new feed id and the id pass above
          //     will not recognize it. Before provenance existed, relink cleared
          //     external_id and these rows fell into case 1 by accident; keeping
          //     the tag is what makes the case have to be named.
          //  3. Rows with an external_id but NO provenance tag. Case 2 does not
          //     cover these and cannot: `ne()` is SQL `<>`, and `NULL <> 'ACT-1'`
          //     evaluates to NULL rather than true, so an untagged row falls out
          //     of the OR entirely. That is the worst state available — the id
          //     pass can't match it (`= feedId` skips NULL), and the partial
          //     unique index can't stop the insert either, because SQLite treats
          //     index NULLs as DISTINCT. The row would re-import on every sync,
          //     silently double-counting real money.
          //
          //     Migration 0020's backfill leaves exactly this state behind for a
          //     sync row whose account is currently UNLINKED, and its "never
          //     been through a relink" argument does not cover it: `setAccountLink`
          //     only began clearing external_id in v0.8.3 (ca53e68), five hours
          //     after sync shipped in v0.8.0 (28aa181), so a relink in that window
          //     left the tag intact. Measured 0 such rows on the live ledger
          //     before applying 0020, but an unlink on /sync is one click and the
          //     migration had not run yet — so this is defended in code rather
          //     than argued away.
          or(
            isNull(schema.transactions.externalId),
            isNull(schema.transactions.simplefinSourceAccountId),
            ne(schema.transactions.simplefinSourceAccountId, feedId),
          ),
          gte(schema.transactions.date, contentFloorIso),
        ),
      )
      .all();

    // A repeated signature is a real repeat (two identical coffees), so this
    // counts rather than sets.
    const contentBudget = new Map<string, number>();
    for (const r of existingByContent) {
      const sig = contentSignature(r);
      contentBudget.set(sig, (contentBudget.get(sig) ?? 0) + 1);
    }

    let duplicateByExternalId = 0;
    let duplicateByContent = 0;
    let skippedPending = 0;
    let skippedBeforeAnchor = 0;
    const toInsert: MappedRow[] = [];

    // D8.1 — THE ACCOUNTING CUTOVER, and it is the one critical gap in this
    // whole change.
    //
    // Phase A files the checking-side card payments as ordinary spend, in the
    // months they happened. Phase B imports the CARD's own rows. Those are two
    // different accounting bases over the SAME dollars, and the feed's window
    // reaches back 45 days — straight into months Phase A has already
    // accounted for. Without a boundary, June through August get billed twice,
    // in the budget, with no error anywhere.
    //
    // The boundary is the card's own anchor, and it is not an arbitrary pick.
    // Rule 1's balance sum is `starting_balance + SUM(WHERE date > anchor)`,
    // so a row on or before the anchor contributes NOTHING to the balance —
    // while still landing in an envelope, because no spend query filters on
    // the anchor. That is the inconsistent state `createCardActivity` already
    // refuses a hand-typed charge for (D12), reached in bulk. Using the same
    // boundary means the imported rows and the balance agree by construction,
    // and no historical month ever changes.
    //
    // CARDS ONLY. For an asset, pre-anchor rows are legitimate history: the
    // checking account's eight months of CSV rows all predate nothing and are
    // supposed to be visible and categorized. Applying this there would delete
    // the ledger's past. `isCreditCard`, not `importsTransactions`, because
    // the question is "does this account's history overlap a Phase A filing",
    // which is about the account being a CARD — an asset that happens to be
    // feed-linked must not be caught by it.
    const isCard = isCreditCard(account.type);
    const cutoverAnchor = isCard ? account.startingBalanceDate : null;
    // D8.4 — every external id this sync did NOT intentionally decide to
    // exclude, whatever happens to it next (freshly inserted, or already
    // present from an earlier sync/CSV import via either dedup pass). See the
    // completeness check after the write commits for why this exists and why
    // it is scoped to cards.
    const expectedCardExternalIds: string[] = [];

    for (const txn of remote?.transactions ?? []) {
      const row = mapTransaction(txn);

      // Enforce the invariant the design already depends on rather than
      // assuming it. Sync never asks for pending rows, and Star One returns
      // none today — but that is an observation about one institution at one
      // time, not a guarantee. If one ever arrives, writing it is the worst
      // outcome available: dedup keys on external_id, SimpleFIN may change that
      // id when the row posts, and there is no update path — so the pre-auth
      // amount would be frozen forever AND the posted row inserted alongside it.
      // Skipping costs nothing: the row simply arrives on the next sync once it
      // has posted, which is exactly the behaviour we want.
      if (row.isPending) {
        skippedPending++;
        continue;
      }

      // BEFORE both dedup passes, deliberately. A row the cutover drops must
      // not enter `seenExternalIds` and must not spend a `contentBudget` slot:
      // the budget is a multiset count of rows this account already holds, and
      // letting a row we are refusing to write consume one would silently
      // drop a LATER, in-window row that is a genuine second occurrence.
      if (cutoverAnchor !== null && !isAfterAnchor({ date: row.date, anchor: cutoverAnchor })) {
        skippedBeforeAnchor++;
        continue;
      }

      if (seenExternalIds.has(row.externalId)) {
        duplicateByExternalId++;
        // FINDABLE only if this id was in the DB, under this feed's own
        // provenance, BEFORE this sync ran (`idsKnownBeforeThisRun`) — NOT
        // merely because `seenExternalIds` (a live set, mutated below) saw it
        // earlier in THIS SAME response. A red-team pass caught the gap: two
        // occurrences of the same id in one feed response, where the FIRST
        // is dropped by content-dedup (lands under different provenance,
        // correctly) and the SECOND then reads as "already known" purely
        // because the first one's `.add()` put it there — pushing an id into
        // `expectedCardExternalIds` that was never written under this feed's
        // tag by either occurrence, and that D8.4 would then report as
        // permanently, falsely missing.
        if (isCard && idsKnownBeforeThisRun.has(row.externalId)) {
          expectedCardExternalIds.push(row.externalId);
        }
        continue;
      }
      seenExternalIds.add(row.externalId);

      const sig = contentSignature(row);
      const budget = contentBudget.get(sig) ?? 0;
      if (budget > 0) {
        contentBudget.set(sig, budget - 1);
        duplicateByContent++;
        // NOT added to `expectedCardExternalIds`. This row's date/amount/memo
        // matched a DIFFERENTLY-provenanced existing row on purpose — a
        // manual entry, a CSV row, or one tagged under a re-minted feed id
        // (rule 3) — and that match is what makes writing this one
        // unnecessary. The existing row does not and never will carry THIS
        // feed's external id, so a check that expected to find one here
        // would be checking for a fact that was never going to be true, on
        // every single ordinary case of this dedup path succeeding.
        continue;
      }
      toInsert.push(row);
      if (isCard) expectedCardExternalIds.push(row.externalId);
    }

    if (skippedPending > 0) {
      accountWarnings.push(
        `Skipped ${skippedPending} pending transaction${
          skippedPending === 1 ? "" : "s"
        } on "${account.name}" — they will import once the bank posts them.`,
      );
    }

    staged.push({ account, feedId, rows: toInsert, accountWarnings, expectedCardExternalIds });

    const reported = remote?.balance ? parseAmountToCents(remote.balance) : null;
    const available = remote?.["available-balance"]
      ? parseAmountToCents(remote["available-balance"]!)
      : null;
    counts.push({
      accountId: account.id,
      name: account.name,
      insertedCount: toInsert.length,
      duplicateByExternalId,
      duplicateByContent,
      skippedPending,
      skippedBeforeAnchor,
      reportedBalanceCents: reported,
      availableBalanceCents: available,
      balanceDate: remote?.["balance-date"]
        ? new Date(remote["balance-date"]! * 1000).toISOString()
        : null,
    });
  }

  // Before the early return, deliberately (D7/D15). `up-to-date` renders as
  // "nothing new to import"; a balance pass behind it would move an anchor
  // while the UI said nothing had changed.
  const balancePass = refreshLiabilityBalances(balanceOnlyAccounts, byExternalId, db, now);
  warnings.push(...balancePass.warnings);

  const totalToInsert = staged.reduce((n, s) => n + s.rows.length, 0);

  if (totalToInsert === 0) {
    // PRE-EXISTING GAP, caught by adversarial review while widening who
    // reaches this branch. `accountWarnings` (e.g. "SimpleFIN returned
    // nothing for X — the connection may need re-authorising") was staged
    // per account during the loop above and, until now, was only ever
    // flushed on the WRITE-commit path (`verifyStagedLinks`, below) — never
    // here. A dead connection for an account with nothing new to insert
    // reported a clean "up to date" with no warning at all. This predates
    // cards entering `importAccounts`: an asset's broken connection had the
    // identical silent gap before this plan touched the file. It matters
    // more now because a linked card's connection can break too.
    for (const entry of staged) warnings.push(...entry.accountWarnings);

    const finalised = finaliseBalances(counts, db);
    warnings.push(...missingAccountWarnings(finalised.missingAccounts));
    // D8.4 — run here too, and this is the branch it matters most in. An
    // ordinary quiet resync is EXACTLY the case a count-based check breaks on
    // (every row the feed sent already existed, so `insertedCount` is
    // legitimately 0), and it is precisely the case this function exists to
    // cover. No account was ever dropped on this path — nothing was written,
    // so `verifyStagedLinks` never ran — hence the empty set.
    warnings.push(...safeCheckCardCompleteness(staged, new Set(), db));
    return {
      status: "up-to-date",
      accounts: finalised.summaries,
      balanceUpdates: balancePass.updates,
      warnings,
    };
  }

  // ---- write ----
  const snapshot = createSnapshot(dbPath(), snapshotDir());
  let snapshotWarning: string | null = null;
  if (!snapshot.consistent) {
    snapshotWarning = `The pre-sync snapshot fell back to a plain file copy${
      snapshot.degradedReason ? ` (${snapshot.degradedReason})` : ""
    } — it may be missing the most recent writes. Undo for this batch still works.`;
    warnings.push(snapshotWarning);
  }

  let written: {
    batchId: number;
    insertedCount: number;
    linkWarnings: string[];
    droppedAccountIds: number[];
    cutoverDroppedByAccountId: Map<number, Set<string>>;
  };
  try {
    written = db.transaction((tx) => {
    // The links were read before the network round trip; re-check them here,
    // inside the transaction that actually writes. See `verifyStagedLinks`.
    const { verified: linkChecked, warnings: linkWarnings, droppedAccountIds } =
      verifyStagedLinks(staged, tx);

    // The link is not the only precondition carried across the `await`.
    // `seenExternalIds` was read BEFORE the fetch, so a second sync (two /sync
    // tabs, the same reachability bar the link guard is written for) can commit
    // rows for the same feed in the window — and those rows are protected by
    // the partial unique index on (simplefin_source_account_id, external_id),
    // so the collision does not double-count. It does something else bad: it
    // aborts the ENTIRE transaction, including good rows for accounts that were
    // fine, and surfaces the driver's raw "UNIQUE constraint failed" text. The
    // comment on `existingByContent` predicts exactly that outcome.
    //
    // So the id pass is re-run here, against the same handle that inserts.
    // Rows another writer already landed are DROPPED, which is the correct
    // reading of them — they are duplicates, and dedup is what this pass is
    // for. One query for the batch, not one per row.
    //
    // Deliberately NOT the content pass: content dedup has no unique index
    // behind it, so a concurrent CSV import racing this one produces a genuine
    // duplicate row rather than an abort. That is a real residual and it is
    // recorded in TODOS rather than fixed by widening this query, because the
    // content budget is a multiset count (rule 3) and re-deriving it inside the
    // transaction is a different and larger change.
    const verified = linkChecked
      .map((entry) => {
        if (entry.rows.length === 0) return entry;
        const landed = new Set(
          tx
            .select({ externalId: schema.transactions.externalId })
            .from(schema.transactions)
            .where(
              and(
                eq(schema.transactions.simplefinSourceAccountId, entry.feedId),
                inArray(
                  schema.transactions.externalId,
                  entry.rows.map((r) => r.externalId),
                ),
              ),
            )
            .all()
            .map((r) => r.externalId),
        );
        if (landed.size === 0) return entry;
        return { ...entry, rows: entry.rows.filter((r) => !landed.has(r.externalId)) };
      })
      .filter((entry) => entry.rows.length > 0 || entry.accountWarnings.length > 0);

    const raced = linkChecked.reduce((n, e) => n + e.rows.length, 0)
      - verified.reduce((n, e) => n + e.rows.length, 0);
    if (raced > 0) {
      linkWarnings.push(
        `${raced} transaction${raced === 1 ? "" : "s"} had already been imported by another sync running at the same time, so ${raced === 1 ? "it was" : "they were"} skipped.`,
      );
    }

    // D8.1 — THE CUTOVER ANCHOR IS ALSO A PRECONDITION CARRIED ACROSS THE
    // `AWAIT` (rule 11), the same class of race the two re-checks above exist
    // for. See `recheckCutoverAnchor`'s own docstring for why.
    const {
      checked: cutoverChecked,
      droppedByAccountId: cutoverDroppedByAccountId,
      warnings: cutoverWarnings,
    } = recheckCutoverAnchor(verified, tx);
    linkWarnings.push(...cutoverWarnings);

    const verifiedTotal = cutoverChecked.reduce((n, s) => n + s.rows.length, 0);

    // Same contract as the CSV path: read the trained rules once for the batch
    // and resolve every row against them. Keyed on `normalized_merchant`, never
    // on MX's `payee` — see CLAUDE.md's SimpleFIN section.
    const matchRule = buildRuleMatcher(tx);

    const [batch] = tx
      .insert(schema.importBatches)
      .values({
        source: "simplefin",
        snapshotPath: snapshot.snapshotPath,
        snapshotWarning,
        transactionCount: 0,
      })
      .returning({ id: schema.importBatches.id })
      .all();

    for (const { account, feedId, rows } of cutoverChecked) {
      for (const row of rows) {
        const match = matchRule(row.normalizedMerchant, row.amountCents);

        const [inserted] = tx
          .insert(schema.transactions)
          .values({
            accountId: account.id,
            date: row.date,
            rawDescription: row.rawDescription,
            rawMemo: row.rawMemo,
            normalizedMerchant: row.normalizedMerchant,
            payee: row.payee,
            amountCents: row.amountCents,
            bankTransactionNumber: null,
            cardLastFour: row.cardLastFour,
            importSource: "simplefin",
            importBatchId: batch.id,
            importRowHash: row.importRowHash,
            externalId: row.externalId,
            // Provenance: WHICH feed produced this row. Deliberately captured
            // at write time rather than joined through `accounts` on read —
            // the account's link can move, the row's origin cannot.
            //
            // `feedId`, not `account.simplefinAccountId`: same value, but the
            // column is typed nullable and this is the one write path that
            // could ever mint the untagged-with-an-external_id row case 3 above
            // exists to survive. Using the non-null binding makes tsc reject any
            // future refactor that lets a null reach here.
            simplefinSourceAccountId: feedId,
            // Always false: pending rows are skipped above, so anything that
            // reaches here has posted.
            isPending: false,
            categoryId: match?.categoryId ?? null,
          })
          .returning({ id: schema.transactions.id })
          .all();

        // Same audit trail as the CSV path (importBatch.ts) — lets a
        // too-broad rule's auto-categorization be undone per batch.
        if (match) {
          tx.insert(schema.importBatchCategorizations)
            .values({
              importBatchId: batch.id,
              transactionId: inserted.id,
              categoryId: match.categoryId,
              ruleId: match.ruleId,
            })
            .run();
        }
      }
    }

    // `verifiedTotal`, not `totalToInsert`: the batch must count what was
    // actually written, or `undoSyncBatch` and `/import/success/[batchId]`
    // both report rows that do not exist.
    tx.update(schema.importBatches)
      .set({ transactionCount: verifiedTotal })
      .where(eq(schema.importBatches.id, batch.id))
      .run();

    if (verifiedTotal === 0) {
      // Rolls back the batch row above. The warnings are rebuilt by the
      // catch, because this transaction's work is about to be discarded.
      throw new NothingVerifiedError();
    }

    // C2: the drop warnings are the ONLY record that rows were withheld, and
    // until now they lived exclusively in one `useActionState` value — close
    // the tab and 40 unimported bank rows left no trace anywhere. Rule 5 already
    // settled this question for the snapshot warning ("not a redirect query
    // param — it has to survive a later visit to the batch's success page"),
    // and `snapshot_warning` is documented as a general per-batch channel that
    // `anchorStartingBalance` already shares. A withheld import is at least as
    // consequential as a degraded snapshot.
    if (linkWarnings.length > 0) {
      tx.update(schema.importBatches)
        .set({
          snapshotWarning: [snapshotWarning, ...linkWarnings].filter(Boolean).join(" "),
        })
        .where(eq(schema.importBatches.id, batch.id))
        .run();
    }

    return {
      batchId: batch.id,
      insertedCount: verifiedTotal,
      linkWarnings,
      droppedAccountIds,
      cutoverDroppedByAccountId,
    };
  });

  } catch (err) {
    if (!(err instanceof NothingVerifiedError)) throw err;
    // Every staged account moved. Nothing was written, so there is no batch to
    // hang a warning on and nothing for the retention pool to protect: drop the
    // snapshot we took rather than let it evict a real one, re-run the check
    // outside the (rolled-back) transaction purely to rebuild its sentences,
    // and report the same shape a quiet sync uses. `ok()` promotes any
    // warning-carrying outcome out of plain-success rendering.
    try {
      unlinkSync(snapshot.snapshotPath);
    } catch {
      // Best effort. A stray snapshot is harmless; failing the sync over one
      // would be the tail wagging the dog.
    }
    const { warnings: linkWarnings, droppedAccountIds: linkDropped } = verifyStagedLinksReadOnly(
      staged,
      db,
    );
    for (const w of linkWarnings) console.error(`sync: ${w}`);
    warnings.push(...linkWarnings);
    const dropped = new Set(linkDropped);

    // D8.1 — the SAME re-check the write path runs, against the live handle
    // this time. `NothingVerifiedError` means every staged account's rows
    // were withheld somewhere — the link check above is ONE way that
    // happens, but not the only one: a cutover-only or raced-id-only drop on
    // every staged account reaches this branch too. So an account already
    // covered by a link-drop warning above is EXCLUDED here rather than
    // re-checked: `staged` still carries its original, unfiltered
    // pre-transaction `rows`, and re-running the cutover check over them
    // would double-warn the same rows under the wrong cause ("landed on or
    // before its balance date" for rows that were never going to be written
    // for an entirely different reason). A DUPLICATE-by-external-id row
    // (already stored from an earlier sync) never entered `entry.rows` at
    // all, so it is untouched by either drop and D8.4 below still needs an
    // accurate `expectedCardExternalIds` to check it against — which is why
    // this filters `staged` rather than reusing `verified`/`linkChecked`
    // from the write path (those don't exist here; nothing was written).
    const stagedForCutover = staged.filter((entry) => !dropped.has(entry.account.id));
    const { droppedByAccountId: cutoverDropped, warnings: cutoverWarnings } =
      recheckCutoverAnchor(stagedForCutover, db);
    for (const w of cutoverWarnings) console.error(`sync: ${w}`);
    warnings.push(...cutoverWarnings);
    applyCutoverPruning(staged, counts, cutoverDropped);
    warnings.push(...safeCheckCardCompleteness(staged, dropped, db));

    const finalised = finaliseBalances(
      counts.map((c) => ({
        ...c,
        insertedCount: 0,
        duplicateByExternalId: 0,
        duplicateByContent: 0,
        reportedBalanceCents: null,
        availableBalanceCents: null,
        balanceDate: null,
      })),
      db,
    );
    warnings.push(...missingAccountWarnings(finalised.missingAccounts));
    return {
      status: "up-to-date",
      accounts: finalised.summaries,
      balanceUpdates: balancePass.updates,
      warnings,
    };
  }

  const { batchId, insertedCount } = written;
  // Durable-ish trace beside the persisted copy: the batch row survives a
  // closed tab, this survives a lost batch.
  for (const w of written.linkWarnings) console.error(`sync: ${w}`);
  warnings.push(...written.linkWarnings);

  // The PER-ACCOUNT summary has to agree with the aggregate. `counts` is built
  // in the staging loop above, before the link re-check runs, so a dropped
  // account would otherwise report the rows it ALMOST got — `insertedCount: 1`
  // sitting beside an `outcome.insertedCount` and a `transaction_count` of 0.
  // That is the same lie `verifiedTotal` exists to prevent, one layer up, and
  // `AccountSyncSummary` is a public field even though only the aggregate is
  // rendered today.
  //
  // EVERY field, not just `insertedCount`. The rest of the record was computed
  // against a feed this account no longer holds, and each one is its own wrong
  // statement: `duplicateBy*` counted matches against the OLD feed's ids and
  // content budget, and `reportedBalanceCents`/`availableBalanceCents`/
  // `balanceDate` are the old feed's balance — which `finaliseBalances` would
  // then subtract from a ledger deliberately missing the withheld rows and
  // report as `driftCents`, i.e. rule 1's "a row is missing or duplicated"
  // signal, manufactured. Nulling the reported balance is what makes
  // `driftCents` come back null instead of fabricated.
  const dropped = new Set(written.droppedAccountIds);
  for (const c of counts) {
    if (!dropped.has(c.accountId)) continue;
    c.insertedCount = 0;
    c.duplicateByExternalId = 0;
    c.duplicateByContent = 0;
    // `skippedPending` and `skippedBeforeAnchor` are deliberately NOT zeroed.
    // Both count rows the feed sent that this app refuses to write, decided
    // before any dedup pass touches the ledger — facts about the PAYLOAD, not
    // about a join against the old feed. They were true when counted and stay
    // true, and `skippedPending`'s warning is withheld with the rest of this
    // account's staging notes, so the two agree. `skippedBeforeAnchor` has no
    // warning to withhold (D8.1 — the drop is routine, so announcing it every
    // run would be the noise D4.3 exists to remove).
    c.reportedBalanceCents = null;
    c.availableBalanceCents = null;
    c.balanceDate = null;
  }

  // A row the in-transaction cutover re-check dropped (a Reconcile racing
  // this sync's fetch) must not appear "missing" to D8.4 — it was correctly
  // excluded, just later than the staging loop's own pre-fetch check could
  // know. `insertedCount`/`skippedBeforeAnchor` were set in the STAGING loop,
  // before this re-check could know some rows would be dropped — without
  // adjusting them, the outcome would claim more rows landed than actually
  // did, the same class of fabricated-fact bug rule 1's "no-op reported as an
  // update" doctrine exists to prevent, just on a count instead of a balance.
  applyCutoverPruning(staged, counts, written.cutoverDroppedByAccountId);

  warnings.push(...safeCheckCardCompleteness(staged, dropped, db));

  // Prune only now that the write has committed, so a failed sync never evicts
  // an older snapshot to make room for a useless one.
  const pruned = pruneSnapshots(snapshotDir());
  if (pruned.failedPaths.length > 0) {
    warnings.push(
      `Could not delete ${pruned.failedPaths.length} old snapshot${
        pruned.failedPaths.length === 1 ? "" : "s"
      } — check the data/ directory's permissions.`,
    );
  }

  const { pairsLinked, ambiguous } = linkTransfersByBucket(startIso, db, batchId);
  const finalised = finaliseBalances(counts, db);
  warnings.push(...missingAccountWarnings(finalised.missingAccounts));

  return {
    status: "synced",
    batchId,
    insertedCount,
    pairsLinked,
    ambiguous,
    snapshot,
    accounts: finalised.summaries,
    balanceUpdates: balancePass.updates,
    warnings,
  };
}

/**
 * Thrown inside the write transaction when the link re-check withheld EVERY
 * staged account, purely to roll it back. Never escapes `syncSimpleFin`.
 *
 * Committing in that case minted an empty `import_batches` row, and an empty
 * batch is not inert: `findLastSyncBatch` returns the NEWEST sync batch, so it
 * became the undo target and the previous real sync's undo silently became
 * unreachable — the user's rollback for the last import that actually wrote
 * anything, gone, with nothing saying so. It also spent a slot in the
 * retention-of-10 snapshot pool on a snapshot of a ledger the sync did not
 * change, which is the exact harm rule 5's prune-after-commit ordering exists
 * to prevent, reached through a door that ordering does not cover.
 */
class NothingVerifiedError extends Error {}

/**
 * D8.1 — re-verifies the cutover anchor INSIDE the write, the same
 * precondition-across-an-`await` class rule 11 names for the link and the id
 * pass beside it. `cutoverAnchor` in the staging loop is read from `linked`,
 * which is read BEFORE `fetchAccounts`' round trip — so a hand Reconcile
 * landing in another tab during the fetch, which moves `starting_balance_date`
 * forward, can leave a staged row legitimately after the OLD anchor but
 * on-or-before the NEW one. Inserting it anyway reproduces the exact
 * inconsistent state D8.1 and `createCardActivity`'s D12 refusal both exist to
 * make unrepresentable: it lands in an envelope as spend while contributing
 * nothing to the balance sum.
 *
 * Takes `AnyDb` rather than `SyncTx`, unlike `verifyStagedLinks` — it is
 * genuinely dual-use (called from inside the write transaction AND, on the
 * `NothingVerifiedError` rollback path, against the live handle after the
 * transaction is gone), the same reason `hasAnyTransactionRows` takes `AnyDb`.
 * Read-only, so nothing about correctness depends on which handle it runs
 * against — only WHETHER the drop it finds gets to actually prevent a write,
 * which the caller decides by using the result before or after its own insert.
 *
 * Cards only, matching the staging loop's own scope — an asset has no cutover
 * to re-check. `droppedByAccountId` lets the caller prune `expectedCardExternalIds`
 * (D8.4, built pre-fetch): an id dropped here was never going to land under
 * this feed's provenance, and D8.4 must not report it as unexplainedly missing.
 *
 * Callers must pass only accounts that SURVIVED their own link re-check.
 * `NothingVerifiedError`'s rollback path used to pass the raw pre-transaction
 * `staged` array here, unfiltered — so a card that was ALSO unlinked or
 * re-linked mid-run got its rows counted as cutover-dropped too, producing a
 * second warning with the wrong cause ("landed on or before its balance
 * date") for rows that were never going to be written for an entirely
 * different reason (rule 11's own "a warning naming the wrong remedy is
 * close to no guard at all"). `NothingVerifiedError` means nothing SURVIVED
 * — that is sufficient reason for the exception, not proof every account was
 * individually link-dropped — so the caller filters first.
 *
 * Returns one warning PER ACCOUNT that lost rows, not one aggregate count:
 * every sibling warning in this file names the account, and this is the one
 * place that money is dropped with no manual way back — `createCardActivity`
 * (D8.3) already refuses to let the user re-type a replacement on an
 * importing card, so the remedy has to be spelled out rather than implied.
 */
function recheckCutoverAnchor<
  T extends {
    account: { id: number; type: AccountType; name: string };
    rows: readonly MappedRow[];
  },
>(staged: readonly T[], db: AnyDb): { checked: T[]; droppedByAccountId: Map<number, Set<string>>; warnings: string[] } {
  const droppedByAccountId = new Map<number, Set<string>>();
  const checked = staged.map((entry) => {
    if (!isCreditCard(entry.account.type) || entry.rows.length === 0) return entry;
    const current = db
      .select({ startingBalanceDate: schema.accounts.startingBalanceDate })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, entry.account.id))
      .get();
    // Deleted or unlinked: the link re-check (whichever variant the caller
    // also runs) already accounts for that account. Nothing further to do.
    if (!current) return entry;
    const stillEligible = entry.rows.filter((r) =>
      isAfterAnchor({ date: r.date, anchor: current.startingBalanceDate }),
    );
    if (stillEligible.length === entry.rows.length) return entry;
    droppedByAccountId.set(
      entry.account.id,
      new Set(entry.rows.filter((r) => !stillEligible.includes(r)).map((r) => r.externalId)),
    );
    return { ...entry, rows: stillEligible };
  });

  const warnings = staged.flatMap((entry) => {
    const droppedIds = droppedByAccountId.get(entry.account.id);
    if (!droppedIds || droppedIds.size === 0) return [];
    const n = droppedIds.size;
    return [
      `${n} transaction${n === 1 ? "" : "s"} on "${entry.account.name}" landed on or ` +
        `before its balance date while this sync was running, so ${n === 1 ? "it wasn't" : "they weren't"} ` +
        `imported — use "Undo" on /accounts to put the balance back, then sync again.`,
    ];
  });
  return { checked, droppedByAccountId, warnings };
}

/**
 * `verifyStagedLinks` against the live handle, for the rolled-back path only.
 *
 * The transaction that produced the warnings was discarded, so its strings went
 * with it. Re-deriving them outside is sound here precisely because nothing was
 * written: there is no ordering guarantee left to protect, only copy to rebuild.
 */
function verifyStagedLinksReadOnly<
  T extends {
    account: { id: number; name: string };
    feedId: FeedAccountId;
    rows: readonly MappedRow[];
    accountWarnings: readonly string[];
  },
>(staged: readonly T[], db: Db): { warnings: string[]; droppedAccountIds: number[] } {
  const warnings: string[] = [];
  const droppedAccountIds: number[] = [];
  for (const entry of staged) {
    const current = db
      .select({ simplefinAccountId: schema.accounts.simplefinAccountId })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, entry.account.id))
      .get();
    if (current === undefined) {
      warnings.push(`"${entry.account.name}" was deleted while the sync was running.`);
      droppedAccountIds.push(entry.account.id);
    } else if (current.simplefinAccountId === null) {
      warnings.push(
        `"${entry.account.name}" was unlinked while the sync was running, so its transactions were not imported — link it again to import them.`,
      );
      droppedAccountIds.push(entry.account.id);
    } else if (current.simplefinAccountId !== entry.feedId) {
      warnings.push(
        `"${entry.account.name}" was re-linked to a different bank account while the sync was running, so its transactions were not imported — sync again to import them against the current link.`,
      );
      droppedAccountIds.push(entry.account.id);
    }
  }
  return { warnings, droppedAccountIds };
}

function missingAccountWarnings(names: string[]): string[] {
  return names.map(
    (n) =>
      `"${n}" disappeared from the ledger while the sync was running, so its balance could not be checked.`,
  );
}

/**
 * D8.4 — CARD COMPLETENESS, independent of the drift check above.
 *
 * `classifyBalanceFreshness` only reports real drift once the bank's
 * balance-date is strictly AFTER the ledger's newest row, and a card that was
 * just synced will very often share today's date with the balance the feed
 * just reported — that monitor is silent on exactly the days it matters most.
 * This answers a narrower, date-independent question instead: did every row
 * the feed sent for this card, that we did not INTEND to exclude, actually
 * land in the ledger UNDER THIS FEED'S OWN PROVENANCE? A COUNT comparison was
 * tried and rejected — dedup legitimately drops rows the ledger already has
 * on an ORDINARY resync, so a count diverges on every normal run and would
 * warn constantly. A SET comparison is resync-stable: a row already stored
 * under `(simplefinSourceAccountId, externalId)` — by this sync or an earlier
 * one — is present in both sets and never counts as missing. It also NAMES
 * which id is missing, which a count cannot.
 *
 * WHAT THIS ACTUALLY CATCHES, stated precisely after a review pass traced
 * every path that can add to `expectedCardExternalIds`: an id only ever
 * enters that set when it is (a) already stored under this feed's tag before
 * this run started, (b) about to be written by THIS run's own insert loop
 * and not subsequently pruned by the link/id-race/cutover re-checks (each of
 * which removes its drops from the set — see `applyCutoverPruning` and the
 * `dropped.has(...)` guard below), or (c) landed by a concurrent sync this
 * same run's raced-id check found already stored. Every one of those is, by
 * construction, provably in the database by the time this check runs — so
 * under CORRECT code this function can never actually find a gap. Its real
 * value is as a REGRESSION GUARD on the insert pipeline: if a future change
 * to the staging/pruning logic silently drops a row this run genuinely
 * intended to write, without also removing its id from
 * `expectedCardExternalIds`, this is what notices. It is not, and cannot be,
 * a monitor for a BAD content-dedup match — the one case that would be a
 * genuine silent loss on a card.
 *
 * "UNDER THIS FEED'S OWN PROVENANCE" IS LOAD-BEARING, and it decides what
 * `expectedCardExternalIds` may contain. A row the CONTENT-dedup pass matches
 * (a hand-entered charge via `createCardActivity`, or a row tagged under a
 * re-minted feed id, rule 3) genuinely lands — that IS correct dedup — but it
 * lands as a DIFFERENTLY-provenanced row that will never carry this feed's
 * external id. The staging loop therefore never adds such an id to
 * `expectedCardExternalIds` in the first place (see the `duplicateByContent`
 * branch there): asking this check to find an id that was never going to
 * exist under this feed's tag would report a permanent false positive on
 * every ordinary case of that dedup path succeeding, which a CSV-import
 * example in an earlier draft of this comment described but a mortgage-only
 * `isCreditCard` scope cannot actually produce — cards refuse CSV rows
 * entirely (E6/E18) — so a manual charge or a re-minted feed id are the real
 * cases this guards.
 *
 * THE ACCEPTED RESIDUAL this leaves: a false content-dedup match (this
 * card's row matches a differently-provenanced existing row on date/amount/
 * memo that is NOT actually the same transaction) silently drops a real
 * charge, and nothing here — or anywhere else — can see it, by the same
 * reasoning the previous paragraph gives. This is not a new risk class:
 * rule 3 already accepts the equivalent gap for the content-dedup pass
 * generally ("a concurrent CSV import racing this one produces a genuine
 * duplicate row rather than an abort... recorded residual in TODOS.md, not a
 * closed one") for the identical reason — content dedup is a multiset count,
 * and building a monitor for it is a different and larger change than this
 * one. Tracked in TODOS.md rather than silently left for a reader to
 * discover by tracing every path into `expectedCardExternalIds` by hand.
 *
 * CALLED FROM THREE PLACES, deliberately. The up-to-date early return
 * (nothing to insert) is where a count-based check would have been most
 * wrong — every row already existing IS the ordinary case, not a failure —
 * so this has to run there too, not only after a write commits. `dropped` is
 * empty on that path by construction: nothing was written, so
 * `verifyStagedLinks` never ran. The `NothingVerifiedError` rollback path
 * (every staged account's rows dropped by the link or cutover re-check) is
 * the third: a `duplicateByExternalId` row can still be worth checking there
 * even though nothing new was inserted, because that id was already stored
 * from an earlier sync — `dropped` there comes from `verifyStagedLinksReadOnly`.
 *
 * Scoped to cards for the reason `resolveStartDate`'s R1 gives elsewhere in
 * this file: this is new defensive machinery for the account type this plan
 * just gave a second write path, not a general-purpose monitor — extending it
 * to every account is a larger, separate change.
 *
 * A throw from the DB read below (e.g. the `inArray(...)` bind-parameter
 * limit) must not be allowed to escape this function's caller: by every call
 * site, the write this is checking has either already committed or was never
 * going to happen, so a diagnostic failure here is not a write failure.
 * `safeCheckCardCompleteness`, below, is the only way this should be called.
 */

/**
 * Reconciles `staged`/`counts` with what `recheckCutoverAnchor` actually
 * dropped, so `expectedCardExternalIds` (D8.4) and the reported counts stop
 * describing the pre-race world. Shared by BOTH callers of
 * `recheckCutoverAnchor` — the in-transaction success path and the
 * `NothingVerifiedError` rollback path — because they were hand-duplicated
 * once already and had already drifted (only the success-path copy adjusted
 * `insertedCount`). Decrementing `insertedCount` on the rollback path is
 * harmless even though that path's `counts.map()` overwrites it to `0`
 * moments later — this function does not need to know which caller it's in,
 * which is the whole point of making it one function instead of two.
 */
function applyCutoverPruning(
  staged: readonly { account: { id: number }; expectedCardExternalIds: string[] }[],
  counts: readonly { accountId: number; skippedBeforeAnchor: number; insertedCount: number }[],
  droppedByAccountId: ReadonlyMap<number, ReadonlySet<string>>,
): void {
  for (const [accountId, droppedIds] of droppedByAccountId) {
    const entry = staged.find((s) => s.account.id === accountId);
    if (entry) {
      entry.expectedCardExternalIds = entry.expectedCardExternalIds.filter(
        (id) => !droppedIds.has(id),
      );
    }
    const c = counts.find((c) => c.accountId === accountId);
    if (c) {
      c.skippedBeforeAnchor += droppedIds.size;
      c.insertedCount -= droppedIds.size;
    }
  }
}

function checkCardCompleteness(
  staged: readonly {
    account: { id: number; name: string };
    feedId: FeedAccountId;
    expectedCardExternalIds: readonly string[];
  }[],
  dropped: ReadonlySet<number>,
  db: AnyDb,
): string[] {
  const warnings: string[] = [];
  for (const entry of staged) {
    if (dropped.has(entry.account.id)) continue; // already warned about, elsewhere
    if (entry.expectedCardExternalIds.length === 0) continue;

    // Deduped once, here — an adversarial review pass caught that the SAME
    // id can legitimately enter `expectedCardExternalIds` more than once (the
    // feed sending a repeated id within one response, both occurrences
    // already-known before this run). Undeduped, one real gap was reported as
    // N — the id repeated in the warning, naming the same transaction twice.
    const expectedIds = [...new Set(entry.expectedCardExternalIds)];

    const storedIds = new Set(
      db
        .select({ externalId: schema.transactions.externalId })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.simplefinSourceAccountId, entry.feedId),
            inArray(schema.transactions.externalId, expectedIds),
          ),
        )
        .all()
        .map((r) => r.externalId),
    );
    const missing = expectedIds.filter((id) => !storedIds.has(id));
    if (missing.length > 0) {
      warnings.push(
        `${missing.length} transaction${missing.length === 1 ? "" : "s"} your bank sent for "${
          entry.account.name
        }" ${missing.length === 1 ? "doesn't" : "don't"} appear in the ledger (e.g. id ${
          missing[0]
        }) — reload /sync and try again, or check the bridge connection.`,
      );
    }
  }
  return warnings;
}

/**
 * `checkCardCompleteness`, best-effort. Every call site runs it after the
 * write it is checking has either already committed (the success path) or
 * was never going to happen (the up-to-date and `NothingVerifiedError`
 * paths) — so a throw here is not a write failure, and letting it escape
 * would report a durable, already-landed import as `fail(...)` to the user
 * (`syncNowAction`'s catch cannot tell the two apart). That is exactly the
 * failure class CLAUDE.md's sync doctrine says was "got wrong twice" for
 * `revalidatePath`, reproduced here for a diagnostic instead. Same "best
 * effort" contract as the `unlinkSync` cleanup a few lines above in this
 * file: log for whoever reads the server console, degrade to no warning
 * rather than no result.
 */
function safeCheckCardCompleteness(
  staged: Parameters<typeof checkCardCompleteness>[0],
  dropped: ReadonlySet<number>,
  db: AnyDb,
): string[] {
  try {
    return checkCardCompleteness(staged, dropped, db);
  } catch (err) {
    console.error("sync: card completeness check failed", err);
    return [];
  }
}

/**
 * Re-checks, INSIDE the write transaction, that every staged account is still
 * linked to the feed its rows were staged against.
 *
 * The account list is read before the SimpleFIN round trip and the insert
 * happens after it, so `account.id` and `feedId` are a PRECONDITION carried
 * across an `await` — and `setAccountLink` can commit in that window. Both
 * controls live on the same `/sync` page, so it takes two tabs and no crafted
 * input:
 *
 *   t0  syncSimpleFin reads accounts      account 1 -> feed A
 *   t1  await fetchAccounts(...)  ────┐
 *   t2                                │   setAccountLink(1, feed B) commits
 *   t3  insert with account.id=1, ◄───┘   ...rows from feed A, on an account
 *       feedId=feed A                     that is now feed B's
 *
 * The vulnerable window is t0 -> t3, NOT the fetch alone: it also spans the
 * per-account staging loop and `createSnapshot`'s `VACUUM INTO`. Nor is it
 * bounded by `SYNC_TIMEOUT_MS` — that only bounds the fetch, and only when the
 * caller passes no signal of its own (`opts.signal ?? AbortSignal.timeout`).
 *
 * The result is not a duplicate but something the dedup passes cannot see at
 * all: feed A's rows filed under an account the user has repointed, carrying
 * feed A provenance. That is the misfiling class migration `0020` exists to
 * prevent, reintroduced as a race rather than as a schema mistake.
 *
 * Same idiom as `undoSyncBatch`, which re-checks its own "still the newest
 * batch" precondition inside its transaction rather than trusting the page's
 * initial check (CLAUDE.md rule 5) — that reasoning applies here with more
 * force, because this write is the one that moves money onto an account.
 *
 * DROPS the affected account's rows rather than failing the whole sync. Every
 * other account's rows were staged against a link that did not move, so they
 * are correct and refusing them would punish accounts that did nothing.
 * Nothing is WRITTEN for a dropped account, so no dedup pass records the
 * withheld rows and none of this is destructive — but "the next sync re-stages
 * them" is true of only one of the three cases, so the three warnings carry
 * three different remedies rather than one reassurance:
 *
 *   repointed  the next sync stages the NEW feed's rows. The withheld ones
 *              come back only if that feed serves them too — which it does for
 *              a re-minted feed id (same bank account, fresh id from
 *              `simplefin:claim`) and does not for a genuine move to a
 *              different bank account. "Sync again" is the right advice; it is
 *              not a guarantee.
 *   unlinked   the account is excluded from the next run's `linked` query
 *              entirely, so syncing again imports nothing for it and says
 *              nothing about it. The remedy is to LINK IT AGAIN.
 *   deleted    unrecoverable, and the warning offers no remedy because there
 *              is none.
 *
 * Three branches, not one, for exactly that reason — an earlier draft folded
 * them together and told an unlinking user to "sync again to import them",
 * which is a no-op that leaves the rows silently never arriving. The warning
 * is what makes the drop non-silent, so a warning naming the wrong remedy is
 * close to no guard at all. `/sync` never renders a warning-carrying sync as a
 * plain success, and the warnings are persisted onto the batch (see below).
 */
function verifyStagedLinks<
  T extends {
    account: { id: number; name: string };
    feedId: FeedAccountId;
    rows: readonly MappedRow[];
    accountWarnings: readonly string[];
  },
>(
  staged: readonly T[],
  tx: SyncTx,
): { verified: T[]; warnings: string[]; droppedAccountIds: number[] } {
  const verified: T[] = [];
  const warnings: string[] = [];
  const droppedAccountIds: number[] = [];

  for (const entry of staged) {
    const current = tx
      .select({ simplefinAccountId: schema.accounts.simplefinAccountId })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, entry.account.id))
      .get();

    if (current === undefined) {
      warnings.push(
        entry.rows.length === 0
          ? `"${entry.account.name}" was deleted while the sync was running.`
          : `"${entry.account.name}" was deleted while the sync was running, so its transactions were not imported. Nothing was written for it.`,
      );
      droppedAccountIds.push(entry.account.id);
      continue;
    }
    // Split from the repoint case deliberately. Both are "not the account
    // these rows were staged for", but the REMEDIES are opposites and the
    // warning is the entire mechanism that makes the drop non-silent. An
    // unlinked account is excluded from the next run's `linked` query, so
    // "sync again" imports nothing for it, says nothing about it, and the
    // rows quietly never arrive — the docstring's "the next sync re-stages
    // them" is true of a repoint and false of an unlink.
    if (current.simplefinAccountId === null) {
      warnings.push(
        entry.rows.length === 0
          ? `"${entry.account.name}" was unlinked while the sync was running. It had nothing new to import.`
          : `"${entry.account.name}" was unlinked while the sync was running, so its transactions were not imported. Nothing was written for it — link it again to import them.`,
      );
      droppedAccountIds.push(entry.account.id);
      continue;
    }
    // Reached only for a link that moved to ANOTHER feed — the NULL case
    // `continue`s above. Written as `!==` rather than a positive test so the
    // ordering is not load-bearing: remove the branch above and this still
    // catches an unlink, just with the wrong remedy in its copy.
    if (current.simplefinAccountId !== entry.feedId) {
      warnings.push(
        entry.rows.length === 0
          ? `"${entry.account.name}" was re-linked to a different bank account while the sync was running. It had nothing new to import.`
          : `"${entry.account.name}" was re-linked to a different bank account while the sync was running, so its transactions were not imported. Nothing was written for it — sync again to import them against the current link.`,
      );
      droppedAccountIds.push(entry.account.id);
      continue;
    }

    verified.push(entry);
    // This account is being written, so its staging notes are true statements
    // about a real import and can go out.
    warnings.push(...entry.accountWarnings);
  }

  return { verified, warnings, droppedAccountIds };
}

/**
 * Re-reads the ledger and returns finalised summaries. Returns rather than
 * mutating, so it is impossible to hand a caller a summary whose balance was
 * never computed.
 *
 * Balance is `starting_balance_cents + SUM(amount_cents WHERE date >
 * starting_balance_date AND NOT is_pending)` per CLAUDE.md rule 1 — strictly
 * greater than, so a row dated exactly on the starting balance date is
 * already counted in it. Pending rows are excluded so a CSV-imported pending
 * row can't inflate the computed balance past SimpleFIN's posted-only
 * `reportedBalanceCents`, which would otherwise fire a phantom drift warning.
 */
function finaliseBalances(
  counts: AccountSyncCounts[],
  db: Db,
): { summaries: AccountSyncSummary[]; missingAccounts: string[] } {
  const summaries: AccountSyncSummary[] = [];
  const missingAccounts: string[] = [];

  for (const c of counts) {
    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, c.accountId))
      .get();

    if (!account) {
      // Was silently skipped before, leaving a fabricated 0 balance on display.
      missingAccounts.push(c.name);
      continue;
    }

    const row = db
      .select({
        delta: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, c.accountId),
          sql`${schema.transactions.date} > ${account.startingBalanceDate}`,
          eq(schema.transactions.isPending, false),
        ),
      )
      .get();

    const computedBalanceCents = account.startingBalanceCents + (row?.delta ?? 0);
    summaries.push({
      ...c,
      computedBalanceCents,
      driftCents:
        c.reportedBalanceCents === null
          ? null
          : computedBalanceCents - c.reportedBalanceCents,
    });
  }

  return { summaries, missingAccounts };
}

/**
 * D11 — a manually-entered row is NEVER a candidate for the automatic
 * transfer matcher, in either query.
 *
 * The concrete failure it allows: you enter a $250 charge on the Visa dated
 * 09-15, and a $250 reimbursement lands in checking on 09-15. The bucket
 * `(2026-09-15, 25000)` then holds one negative and one positive across two
 * accounts — balanced 1-and-1, which the counting argument auto-links WITHOUT
 * ASKING. Neither leg carries a `bank_transaction_number`, so the
 * cross-source guard never fires either. Both rows silently drop out of every
 * spend sum.
 *
 * This sits beside `isAtmWithdrawal` in matchTransfers.ts for the same
 * reason: a row class that collides on amounts and is never a legitimate
 * auto-pair leg. It costs nothing — the only manual row that should ever be
 * paired is the payment mirror, which is linked explicitly at creation and so
 * already has a non-NULL `transfer_pair_id`.
 *
 * The CSV ±1 matcher is safe by accident here (it requires a
 * `bank_transaction_number`, which manual rows do not have). That is noted,
 * not depended on.
 */
const NOT_MANUAL = sql`${schema.transactions.importSource} != 'manual'`;

/**
 * D-CARD — a row on a CREDIT CARD is never a candidate for the automatic
 * transfer matcher either. This is D11's argument, one account type over.
 *
 * IT WAS ALREADY TRUE, BY ACCIDENT, AND THIS CHANGE IS WHAT ENDS THAT.
 * `matchTransfers` has no account-type awareness at all — deliberately; it
 * imports nothing from `@/lib/accounts`. Card rows stayed out of it purely
 * because every row a card could hold was `import_source='manual'`: CSV import
 * refuses a liability `accountId` (E6/E18) and sync staged none of a card's
 * transactions (E1). `NOT_MANUAL` was therefore doing two jobs, and nothing
 * said so. D4.3 stages `simplefin` rows onto a card, and the second job stops
 * getting done — silently, with no test failing.
 *
 * What that costs, concretely: a $80.77 Citi PURCHASE on 08-11 and an
 * unrelated $80.77 deposit into checking the same day form a balanced 1-and-1
 * bucket across two accounts. The counting argument auto-links it without
 * asking, because the argument is sound about BUCKETS and says nothing about
 * whether these two rows have anything to do with each other. Both drop out
 * of every spend sum, and the purchase leaves its envelope. There is no error.
 *
 * A real card PAYMENT does not need this matcher and would not be caught by it
 * anyway: measured offsets between the card leg and the checking leg were 1,
 * 3, 1 and 1 days across all four, and the bucket key is `(date, |amount|)`.
 * Zero of four would ever have auto-paired. D8.2 links them by hand instead.
 *
 * NOT applied to `findSameAccountReversalCandidates`. A disputed charge and
 * its provisional credit on ONE card is exactly that queue's subject, and that
 * queue never auto-links — every candidate goes to a human. Excluding cards
 * there would delete the feature for the account type that needs it most.
 *
 * `NOT IN` over a subquery is safe from rule 3's three-valued trap here:
 * `accounts.id` is a primary key and `transactions.account_id` is NOT NULL, so
 * neither side can produce the NULL that would collapse the predicate.
 */
const NOT_ON_A_CARD = sql`${schema.transactions.accountId} NOT IN (
  SELECT ${schema.accounts.id} FROM ${schema.accounts}
  WHERE ${inArray(schema.accounts.type, [...CARD_TYPES])}
)`;

/**
 * Links unpaired rows on or after `sinceIso` across ALL accounts — not just the
 * rows this batch inserted — so a SimpleFIN row can still pair with a CSV row
 * imported earlier.
 */
export function linkTransfersByBucket(
  sinceIso: string,
  db: Db = defaultDb,
  batchId?: number,
): { pairsLinked: number; ambiguous: CrossAccountBucket<TransferRow>[] } {
  const unlinked: TransferRow[] = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNull(schema.transactions.transferPairId),
        NOT_MANUAL,
        // D-CARD — see NOT_ON_A_CARD. This exclusion used to be a side
        // effect of the line above; staging a card's feed rows ends that.
        NOT_ON_A_CARD,
      ),
    )
    .all()
    .map((r) => ({
      ...r,
      adjudicatedByTxnNumber: r.bankTransactionNumber !== null,
    }));

  // A manually-unlinked row ("Not a transfer") must never be silently
  // re-linked to the SAME partner it was rejected against — see
  // unlinkTransferPair's docstring. Passed into matchTransfers itself (not a
  // post-filter): see assignAvoidingRejections for why a post-filter would
  // still lose an otherwise-valid pairing for the OTHER members of the same
  // balanced bucket.
  const { pairs: allPairs, ambiguous } = matchTransfers(
    unlinked,
    rejectionPredicateFor(unlinked, db),
  );

  // Only persist a pair that involves at least one row from THIS batch.
  // matchTransfers sees every unlinked row in the window, so it can legitimately
  // pair two rows that both predate this sync — but undoSyncBatch deletes only
  // this batch's rows and relies on ON DELETE SET NULL to unlink survivors, so
  // such a pair would outlive the undo with no way to clear it.
  const batchRowIds = batchId
    ? new Set(
        db
          .select({ id: schema.transactions.id })
          .from(schema.transactions)
          .where(eq(schema.transactions.importBatchId, batchId))
          .all()
          .map((r) => r.id),
      )
    : null;
  const pairs = batchRowIds
    ? allPairs.filter((p) => batchRowIds.has(p.a.id) || batchRowIds.has(p.b.id))
    : allPairs;

  // One transaction, not two auto-commits per pair. Both for atomicity (a
  // failure mid-loop must not leave half-linked rows) and because each bare
  // .run() is a separate WAL commit with its own fsync on a synchronous driver
  // that blocks the event loop.
  if (pairs.length > 0) {
    db.transaction((tx) => {
      for (const { a, b } of pairs) {
        tx.update(schema.transactions)
          .set({ transferPairId: b.id })
          .where(eq(schema.transactions.id, a.id))
          .run();
        tx.update(schema.transactions)
          .set({ transferPairId: a.id })
          .where(eq(schema.transactions.id, b.id))
          .run();
      }
    });
  }

  return { pairsLinked: pairs.length, ambiguous };
}

/**
 * Manually pair two rows the bucket matcher could not decide between.
 *
 * Returns what the caller has to be able to SAY, not just whether it worked:
 * `clearedRejection` reports that this link erased a "not a pair" the user had
 * recorded earlier. Every refusal is still a throw, so the return value carries
 * no success/failure information — only this one fact, which no caller can
 * recover afterwards because the row is gone by then.
 */
export function linkTransferPairManually(
  aId: number,
  bId: number,
  db: Db = defaultDb,
  opts: { allowSameAccountReversal?: boolean } = {},
): { clearedRejection: boolean } {
  // The read, every guard and the write share ONE transaction. They used to be
  // a bare SELECT followed by `db.transaction(...)`, which was correct only
  // because better-sqlite3 is synchronous and nothing between them yielded —
  // an unstated invariant one `await` away from a check-then-act race whose
  // failure mode is a dangling one-way `transfer_pair_id` (one row silently
  // out of spending while its partner still counts). `undoSyncBatch` already
  // re-checks its own staleness condition inside its transaction for exactly
  // this reason (CLAUDE.md rule 5); this now matches. Throwing rolls back, and
  // nothing has been written at that point anyway.
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, [aId, bId]))
      .all();

    if (rows.length !== 2) throw new Error("Both transactions must exist.");
    const [a, b] = rows;
    // Same-account is refused by default, and the opt-in is a PARAMETER rather
    // than something derivable from the two rows. That is deliberate: the shape
    // "same account, same day, equal magnitude, opposite signs" is ~13% coincidence
    // on real data (see `sameAccountReversals.ts`), so it cannot be the thing that
    // authorizes the link — a genuine $3.99 subscription charge sitting opposite an
    // unrelated $3.99 refund satisfies it perfectly. Only the same-account review
    // queue passes the flag, and it is a server action argument, never a form
    // field, so a crafted or stale request cannot set it.
    //
    // The same-day requirement is the second half of the narrowing: without it
    // this would accept any two opposite-sign rows of equal size anywhere in one
    // account's history, which is not a shape any reviewer is ever shown.
    if (a.accountId === b.accountId) {
      if (!opts.allowSameAccountReversal) {
        throw new Error("A transfer pair must span two different accounts.");
      }
      if (a.date !== b.date) {
        throw new Error("A same-account reversal must be same-day.");
      }
      // The queue never offers a hand-entered row (`findSameAccountReversalCandidates`
      // filters NOT_MANUAL), so re-asserting it here costs nothing and closes the
      // gap between "what the UI shows" and "what the action accepts" — the opt-in
      // is carried by which action ran, which is not by itself proof the ids came
      // from the queue. It matters specifically for manual rows: pairing one hides
      // it from every spend surface, and the row menu's undo (`unmarkCardPayment`)
      // refuses a pair it did not create, so there would be no ordinary way back.
      if (a.importSource === "manual" || b.importSource === "manual") {
        throw new Error(
          "A hand-entered transaction cannot be paired as a reversal — edit or delete the row instead.",
        );
      }
    }
    if (Math.sign(a.amountCents) === Math.sign(b.amountCents)) {
      throw new Error("A transfer pair must have opposite signs.");
    }
    if (Math.abs(a.amountCents) !== Math.abs(b.amountCents)) {
      throw new Error("A transfer pair must have equal absolute amounts.");
    }
    // Re-pairing a row that already has a partner would overwrite this side of
    // the link while the old partner keeps pointing back, leaving a dangling
    // one-way reference. Reachable from a stale /sync tab resolving a bucket that
    // another tab already resolved.
    if (a.transferPairId !== null || b.transferPairId !== null) {
      throw new Error(
        "One of these transactions is already paired — reload the page to see the current state.",
      );
    }

    // Deliberately linking a pair the user had previously rejected ("Link as
    // transfer anyway") forgets THAT rejection and only that one. Under the old
    // single-column store this needed a conditional — clearing blindly would
    // also erase a rejection recorded against a THIRD row, so linking A to C
    // could make A forget it had rejected B. With one row per pair the hazard is
    // structural rather than guarded: there is nothing to clobber.
    const clearedRejection = clearPairRejection(tx, a.id, b.id);
    tx.update(schema.transactions)
      .set({ transferPairId: b.id })
      .where(eq(schema.transactions.id, a.id))
      .run();
    tx.update(schema.transactions)
      .set({ transferPairId: a.id })
      .where(eq(schema.transactions.id, b.id))
      .run();
    return { clearedRejection };
  });
}

/**
 * Records "these two are NOT a pair" WITHOUT linking them first.
 *
 * `unlinkTransferPair` also writes this marker, but only for a pair that is
 * already linked (`if (row.transferPairId === null) return;`). That left the
 * review queues with no way to say no: the only route to a durable rejection
 * was to create the very link you were rejecting and then undo it, and between
 * those two clicks both rows leave every spending surface. On a credit card it
 * was worse still — the linked positive leg briefly counted as debt paid down.
 * Found by adversarial review during /ship 2026-09-08.
 *
 * Pair-scoped, exactly like the rejection `unlinkTransferPair` writes:
 * rejecting one combination in a multi-candidate bucket says nothing about the
 * others, and `findSameAccountReversals` only drops a bucket once EVERY
 * combination in it is rejected.
 *
 * That last sentence is only satisfiable because rejections live in their own
 * table. While they were a single column per row, P*N combinations competed
 * for P+N slots, so a bucket with two or more candidates on BOTH sides could
 * never reach the all-rejected state at all — it re-surfaced forever while the
 * UI insisted the pairing would not be suggested again. See the
 * `transferPairRejections` schema comment.
 *
 * Idempotent: re-rejecting an already-rejected pair succeeds without writing,
 * because a stale tab resubmitting is ordinary use here — but it says so in
 * the return value rather than reporting the two outcomes identically.
 */
export type RejectOutcome = "recorded" | "already-rejected";

export function rejectTransferPairManually(
  aId: number,
  bId: number,
  db: Db = defaultDb,
): RejectOutcome {
  // Read, guards and write in one transaction — see `linkTransferPairManually`.
  return db.transaction((tx) => {
    const rows = tx
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, [aId, bId]))
      .all();

    if (aId === bId) throw new Error("A pair must be two different transactions.");
    if (rows.length !== 2) throw new Error("Both transactions must exist.");
    const [a, b] = rows;

    // Rejecting an already-linked pair is `unlinkTransferPair`'s job — it has to
    // clear the link as well, and doing half of that here would leave the rows
    // paired while claiming they were rejected.
    if (a.transferPairId !== null || b.transferPairId !== null) {
      throw new Error(
        "One of these transactions is already paired — use “Not a transfer” on the linked pair instead.",
      );
    }

    // The SAME shape gate `linkTransferPairManually` applies, and for a stronger
    // reason. A rejection is the DURABLE half of this pair of operations: a link
    // can be undone from the "Linked pairs" list, while a rejection has no UI at
    // all and suppresses the automatic matchers forever. It was originally the
    // less-validated of the two, which is backwards. A pair that no queue could
    // ever have offered is a stale or crafted post, not an answer to a question
    // the app asked.
    if (Math.sign(a.amountCents) === Math.sign(b.amountCents)) {
      throw new Error("A rejected pair must have opposite signs.");
    }
    if (Math.abs(a.amountCents) !== Math.abs(b.amountCents)) {
      throw new Error("A rejected pair must be the same amount.");
    }
    if (a.accountId === b.accountId && a.date !== b.date) {
      throw new Error("A same-account reversal must be same-day.");
    }

    return recordPairRejection(tx, a.id, b.id) ? "recorded" : "already-rejected";
  });
}

export type UnlinkOutcome = "unlinked" | "already-unpaired";

/**
 * Clears BOTH sides of a transfer pair.
 *
 * Every other writer of `transfer_pair_id` only ever assigns a partner. Without
 * this there is no path in the app that sets it back to NULL, so a wrong link —
 * whether auto-linked by the counting argument or picked by hand in the review
 * UI — could only be undone by restoring a snapshot or undoing the whole batch,
 * and the latter only works until the next sync becomes the newest batch. Since
 * a paired row is excluded from every spending surface (budget, trends, goals,
 * categorize, subscriptions), a wrong link silently removes real money from the
 * budget with no way back.
 *
 * Both legs are cleared in one transaction: leaving one side pointing at a row
 * that no longer points back is exactly the dangling state that
 * `linkTransferPairManually` refuses to create.
 *
 * Returns which of the two things happened, so a no-op cannot be reported as a
 * completed correction — see the `already-unpaired` branch.
 *
 * Also records the pair in `transfer_pair_rejections`.
 * `transferPairId IS NULL` alone doesn't distinguish "never
 * evaluated" from "user explicitly rejected this specific match" —
 * without a separate marker, every automatic matcher (`linkTransferPairs`,
 * `linkTransfersByBucket`) would treat a just-unlinked row as an ordinary
 * unpaired candidate again, and an unrelated future import landing on the
 * same date could silently re-link the exact pair the user just rejected,
 * with no notification. Deliberately PAIR-scoped, not transaction-scoped —
 * see the schema comment on `transferPairRejections` for why a
 * transaction-scoped flag was tried first and reverted. Found by Red Team,
 * then corrected per Codex structured review, both during `/ship`
 * 2026-09-04.
 */
export function unlinkTransferPair(id: number, db: Db = defaultDb): UnlinkOutcome {
  // Read, guard and write in one transaction — see `linkTransferPairManually`.
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, id))
      .get();

    if (!row) throw new Error(`No such transaction: ${id}`);
    // Idempotent: a double-submit or a stale tab should be a no-op, not an error.
    // It is NOT reported as an ordinary success, though: the rejection below is
    // the entire point of this button, and the no-op path writes none of it. A
    // caller that renders "Unpaired — both rows count towards spending again."
    // here is asserting a durable correction that was never recorded. Reachable:
    // `undoSyncBatch` deletes a batch's rows and ON DELETE SET NULL clears the
    // survivor's `transferPairId` with no rejection, so a stale /sync tab still
    // listing that pair lands exactly here.
    if (row.transferPairId === null) return "already-unpaired";

    const partnerId = row.transferPairId;
    recordPairRejection(tx, id, partnerId);
    tx.update(schema.transactions)
      .set({ transferPairId: null })
      .where(eq(schema.transactions.id, id))
      .run();
    tx.update(schema.transactions)
      .set({ transferPairId: null })
      .where(eq(schema.transactions.id, partnerId))
      .run();
    return "unlinked";
  });
}

export type LinkedTransferPair = { a: TransferRow; b: TransferRow };

/**
 * Linked pairs on or after `sinceIso`, so the sync screen can show what was
 * auto-linked and offer to undo it. Emits each pair once (keyed on the lower
 * id) and skips half-links, which should not exist but must not crash the page
 * if they somehow do.
 */
export function findLinkedTransferPairs(
  sinceIso: string,
  db: Db = defaultDb,
): LinkedTransferPair[] {
  const rows = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
      transferPairId: schema.transactions.transferPairId,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNotNull(schema.transactions.transferPairId),
        // NOT_MANUAL, which `linkTransfersByBucket` and
        // `findAmbiguousTransfers` already carry and this query was missed
        // out of. Without it a card-payment pair created by
        // `markAsCardPayment` showed up in `/sync`'s linked-transfer list
        // beside a "Not a transfer" button wired to `unlinkTransferPair` —
        // and `unmarkCardPayment`'s docstring spells out what that does to a
        // synthetic mirror: an orphan row in the categorize backlog, the card
        // balance still inflated by the payment, no valid category, and a
        // rejection marker blocking automatic re-pairing. None of it
        // announced.
        //
        // These pairs do not belong on that surface anyway: it exists to show
        // what THIS SYNC auto-linked and offer to undo it. A payment the user
        // marked by hand was never auto-linked, and its correct inverse is
        // `unmarkCardPayment` from the row menu (E12).
        NOT_MANUAL,
      ),
    )
    .all();

  const byId = new Map(
    rows.map((r) => [
      r.id,
      { ...r, adjudicatedByTxnNumber: r.bankTransactionNumber !== null },
    ]),
  );
  const pairs: LinkedTransferPair[] = [];
  // Iterate the mapped values, not the raw rows, so both legs carry
  // adjudicatedByTxnNumber.
  for (const row of byId.values()) {
    const partner = byId.get(row.transferPairId!);
    if (!partner || partner.transferPairId !== row.id) continue;
    if (row.id > partner.id) continue;
    const positive = row.amountCents >= 0 ? row : partner;
    const negative = row.amountCents >= 0 ? partner : row;
    pairs.push({ a: positive, b: negative });
  }
  return pairs.sort((x, y) => y.a.date.localeCompare(x.a.date));
}

/**
 * Re-derives the undecidable buckets from whatever is currently unpaired.
 * Deliberately stateless — there is no "needs review" flag to keep in sync with
 * reality, so resolving a pair anywhere simply makes it stop showing up here.
 */
export function findAmbiguousTransfers(
  sinceIso: string,
  db: Db = defaultDb,
): CrossAccountBucket<TransferRow>[] {
  // The select itself does NOT filter on rejections: this is
  // a human-review surface, not an auto-link path, so a previously-rejected
  // row is allowed to resurface here against a DIFFERENT candidate — the
  // human decides, they aren't silently re-linked. Excluding the ROW would
  // repeat the mistake `linkTransferPairManually` is the fix for (see the
  // schema comment on `transferPairRejections`): it's the only UI entry
  // point to `linkTransferPairManually`, so hiding a row here would leave no
  // way to ever manually pair it again. The rejection predicate IS still passed to
  // matchTransfers below, purely so this page shows the same buckets
  // linkTransfersByBucket actually computed at sync time — a bucket that
  // fails rejection-avoidance during sync becomes ambiguous there, and
  // should show as ambiguous here too, not silently omitted OR silently
  // shown as already resolved.
  const unlinked: TransferRow[] = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNull(schema.transactions.transferPairId),
        NOT_MANUAL,
        // D-CARD — see NOT_ON_A_CARD. This exclusion used to be a side
        // effect of the line above; staging a card's feed rows ends that.
        NOT_ON_A_CARD,
      ),
    )
    .all()
    .map((r) => ({
      ...r,
      adjudicatedByTxnNumber: r.bankTransactionNumber !== null,
    }));

  return matchTransfers(unlinked, rejectionPredicateFor(unlinked, db)).ambiguous;
}

/**
 * Same-account reversal candidates for the review queue — the DB half of
 * `findSameAccountReversals`, which owns the reasoning (read that file first).
 *
 * Deliberately a SECOND query rather than a widening of `findAmbiguousTransfers`
 * above: that one hands its rows to `matchTransfers`, whose counting argument
 * is defined across accounts, and feeding same-account rows into it would
 * change which CROSS-account buckets it considers balanced. The two classes
 * share a review surface, not a matcher.
 *
 * `NOT_MANUAL` is applied for the same reason it is there: a hand-entered card
 * charge is not bank activity and has no reversal to find.
 */
export function findSameAccountReversalCandidates(
  sinceIso: string,
  db: Db = defaultDb,
): SameAccountBucket<TransferRow>[] {
  const unlinked: TransferRow[] = db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
      rawMemo: schema.transactions.rawMemo,
      bankTransactionNumber: schema.transactions.bankTransactionNumber,
    })
    .from(schema.transactions)
    .where(
      and(
        gte(schema.transactions.date, sinceIso),
        isNull(schema.transactions.transferPairId),
        NOT_MANUAL,
        // NO `NOT_ON_A_CARD` HERE, and its absence is the decision, not an
        // oversight. A disputed charge and its provisional credit landing on
        // ONE card is the archetypal case for this queue, and this queue never
        // auto-links — every candidate goes to a human, which is the whole
        // reason the exclusion the two cross-account queries need does not
        // apply. Adding it would delete the feature for the account type that
        // produces the most reversals.
      ),
    )
    .all()
    // `adjudicatedByTxnNumber` is carried only to satisfy `TransferRow`.
    // `findSameAccountReversals` never reads it — the cross-source guard it
    // feeds lives in `matchTransfers`, and it does not apply here: the CSV ±1
    // matcher declines a same-account pair on the ACCOUNT rule, so "already
    // examined and declined" carries no information about this shape.
    .map((r) => ({
      ...r,
      adjudicatedByTxnNumber: r.bankTransactionNumber !== null,
    }));

  return findSameAccountReversals(unlinked, rejectionPredicateFor(unlinked, db));
}

export type { TransferRow };
