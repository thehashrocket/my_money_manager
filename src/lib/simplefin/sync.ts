import { and, eq, gte, inArray, isNull, isNotNull, ne, or, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import {
  createSnapshot,
  pruneSnapshots,
  type SnapshotResult,
} from "../snapshot";
import { dbPath, snapshotDir } from "../paths";
import { readAccessUrl } from "./accessUrl";
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
import { accountClass } from "@/lib/accounts/accountClass";
import { hasAnyTransactionRows } from "@/lib/accounts/hasAnyTransactionRows";
import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import {
  isStartingBalanceCentsInBounds,
  startingBalanceDateSchema,
} from "@/lib/import/accountAnchorFields";
import { toLocalIso, todayIso } from "@/lib/now";
import type { SimpleFinAccount } from "./types";

type Db = typeof defaultDb;

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
  reportedBalanceCents: number | null;
  availableBalanceCents: number | null;
  balanceDate: string | null;
};

export type AccountSyncSummary = AccountSyncCounts & {
  computedBalanceCents: number;
  /**
   * computed − reported. Non-zero means the ledger has drifted from the bank.
   * NULL means only one thing now: the bank reported no balance.
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
 */
export function partitionLinkedAccounts(linked: readonly LinkedAccount[]): {
  importAccounts: LinkedAccount[];
  balanceOnlyAccounts: LinkedAccount[];
} {
  const importAccounts: LinkedAccount[] = [];
  const balanceOnlyAccounts: LinkedAccount[] = [];
  for (const a of linked) {
    if (accountClass(a.type) === "asset") importAccounts.push(a);
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
    const remote = byExternalId.get(account.simplefinAccountId!);
    if (!remote) {
      // The staging loop has its own version of this warning; a balance-only
      // account is not in that loop, so without this a mortgage the feed
      // stopped returning would go completely silent.
      warnings.push(
        `SimpleFIN returned nothing for "${account.name}" — its balance was not updated.`,
      );
      continue;
    }

    if (hasAnyTransactionRows(account.id, db)) {
      warnings.push(
        `"${account.name}" has transactions, so its balance was not refreshed from the feed. Update it from the Accounts page.`,
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
    // The loan half of the guard REFUSES, so it has to run before the no-op
    // check — a refusal is about the figure itself, not about whether it moved.
    if (balanceCents > 0 && isLongTermLiability(account.type)) {
      warnings.push(
        `SimpleFIN reported a positive balance for "${account.name}", which a loan cannot have, so it was ignored.`,
      );
      continue;
    }

    if (
      balanceCents === account.startingBalanceCents &&
      asOfIso === account.startingBalanceDate
    ) {
      continue; // Nothing moved; do not manufacture a report.
    }

    // The card half only ANNOUNCES, so it belongs after the no-op check.
    // Warning before it re-emitted on every single sync for an account that
    // was perfectly healthy and hadn't changed — and since the action treats
    // "no update + a warning" as a failure, a stable overpaid card rendered a
    // red error under its Refresh button forever.
    if (balanceCents > 0) {
      warnings.push(
        `SimpleFIN reports "${account.name}" as ${formatCents(balanceCents)} — a credit balance. If that is wrong, set it with Reconcile on the Accounts page.`,
      );
    }

    db.update(schema.accounts)
      .set({
        startingBalanceCents: balanceCents,
        startingBalanceDate: asOfIso,
        priorStartingBalanceCents: account.startingBalanceCents,
        priorStartingBalanceDate: account.startingBalanceDate,
        balanceAsOf: asOfDate,
        balanceSource: "feed",
        updatedAt: now,
      })
      .where(eq(schema.accounts.id, account.id))
      .run();

    updates.push({
      accountId: account.id,
      name: account.name,
      balanceCents,
      asOfIso,
      priorBalanceCents: account.startingBalanceCents,
      priorAsOfIso: account.startingBalanceDate,
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
  type Staged = { account: (typeof linked)[number]; rows: MappedRow[] };
  const staged: Staged[] = [];
  const counts: AccountSyncCounts[] = [];

  for (const account of importAccounts) {
    // Non-null by construction: `importAccounts` comes from the linked-account
    // query. Named once because three separate predicates below key off it, and
    // `accounts.$inferSelect` types the column as nullable.
    const feedId = account.simplefinAccountId!;
    const remote = byExternalId.get(feedId);
    if (!remote) {
      warnings.push(
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
          // have claimed it by id. Two cases qualify, and the second is why this
          // is not simply `external_id IS NULL`:
          //
          //  1. CSV rows (external_id NULL) — the original case: the feed
          //     re-sends days already imported from a file.
          //  2. Rows from a DIFFERENT feed. Re-running `simplefin:claim` mints
          //     fresh account ids for the same real bank account, so the same
          //     transaction can arrive under a new feed id and the id pass above
          //     will not recognize it. Before provenance existed, relink cleared
          //     external_id and these rows fell into case 1 by accident; keeping
          //     the tag is what makes the case have to be named.
          or(
            isNull(schema.transactions.externalId),
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
    const toInsert: MappedRow[] = [];

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

      if (seenExternalIds.has(row.externalId)) {
        duplicateByExternalId++;
        continue;
      }
      seenExternalIds.add(row.externalId);

      const sig = contentSignature(row);
      const budget = contentBudget.get(sig) ?? 0;
      if (budget > 0) {
        contentBudget.set(sig, budget - 1);
        duplicateByContent++;
        continue;
      }
      toInsert.push(row);
    }

    if (skippedPending > 0) {
      warnings.push(
        `Skipped ${skippedPending} pending transaction${
          skippedPending === 1 ? "" : "s"
        } on "${account.name}" — they will import once the bank posts them.`,
      );
    }

    staged.push({ account, rows: toInsert });

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
    const finalised = finaliseBalances(counts, db);
    warnings.push(...missingAccountWarnings(finalised.missingAccounts));
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

  const batchId = db.transaction((tx) => {
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

    for (const { account, rows } of staged) {
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
            simplefinSourceAccountId: account.simplefinAccountId,
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

    tx.update(schema.importBatches)
      .set({ transactionCount: totalToInsert })
      .where(eq(schema.importBatches.id, batch.id))
      .run();

    return batch.id;
  });

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
    insertedCount: totalToInsert,
    pairsLinked,
    ambiguous,
    snapshot,
    accounts: finalised.summaries,
    balanceUpdates: balancePass.updates,
    warnings,
  };
}

function missingAccountWarnings(names: string[]): string[] {
  return names.map(
    (n) =>
      `"${n}" disappeared from the ledger while the sync was running, so its balance could not be checked.`,
  );
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

/** Manually pair two rows the bucket matcher could not decide between. */
export function linkTransferPairManually(
  aId: number,
  bId: number,
  db: Db = defaultDb,
  opts: { allowSameAccountReversal?: boolean } = {},
): void {
  // The read, every guard and the write share ONE transaction. They used to be
  // a bare SELECT followed by `db.transaction(...)`, which was correct only
  // because better-sqlite3 is synchronous and nothing between them yielded —
  // an unstated invariant one `await` away from a check-then-act race whose
  // failure mode is a dangling one-way `transfer_pair_id` (one row silently
  // out of spending while its partner still counts). `undoSyncBatch` already
  // re-checks its own staleness condition inside its transaction for exactly
  // this reason (CLAUDE.md rule 5); this now matches. Throwing rolls back, and
  // nothing has been written at that point anyway.
  db.transaction((tx) => {
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
    clearPairRejection(tx, a.id, b.id);
    tx.update(schema.transactions)
      .set({ transferPairId: b.id })
      .where(eq(schema.transactions.id, a.id))
      .run();
    tx.update(schema.transactions)
      .set({ transferPairId: a.id })
      .where(eq(schema.transactions.id, b.id))
      .run();
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
