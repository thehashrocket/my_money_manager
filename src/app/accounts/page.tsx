import { connection } from "next/server";
import Link from "next/link";
import { db } from "@/db";
import { hasAnyTransactionRows } from "@/lib/accounts/hasAnyTransactionRows";
import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import { loadAccountBalancesForRequest } from "@/lib/accounts/loadAccountBalances";
import { paidDownCents } from "@/lib/accounts/paidDownCents";
import { summarizeBalances } from "@/lib/accounts/summarizeBalances";
import { listLeafCategories } from "@/lib/categories";
import { formatCents } from "@/lib/money";
import { currentMonth, todayIso } from "@/lib/now";
import { StateCard } from "@/components/ledger/state-card";
import { NetWorthRow, SubtotalRow } from "@/components/ledger/balance-list";
import { AccountRow, type AccountRowData } from "./_account-row";
import type { LeafCategory } from "@/lib/categories";

export default async function AccountsPage() {
  // Same reason as /import and the Spine: without this Next 16 prerenders the
  // route and freezes every balance at build time.
  await connection();

  const { year, month } = currentMonth();
  const today = todayIso();

  // DS67's dialog requires a category, so the picker's options come with the
  // page rather than through a second round trip.
  const categories = listLeafCategories(db);
  const balances = loadAccountBalancesForRequest();
  const rows: AccountRowData[] = balances.map((b) => ({
    ...b,
    hasAnyRows: hasAnyTransactionRows(b.id, db),
    paidDownCents: b.class === "liability" ? paidDownCents(b.id, year, month, db) : null,
  }));

  const assets = rows.filter((r) => r.class === "asset");
  // Cards first, then long-term. DS59's LONG-TERM sub-label needs the loans
  // grouped at the bottom of the same list, not in a separate panel — three
  // subtotals plus net worth is more scaffolding than content at three
  // accounts.
  const liabilities = rows
    .filter((r) => r.class === "liability")
    .sort((a, b) => Number(isLongTermLiability(a.type)) - Number(isLongTermLiability(b.type)));
  const firstLongTermIndex = liabilities.findIndex((r) => isLongTermLiability(r.type));

  const summary = summarizeBalances(rows);
  const debtPaidDown = liabilities.reduce((sum, r) => sum + (r.paidDownCents ?? 0), 0);

  if (rows.length === 0) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="mb-6 font-display text-xl font-semibold">Accounts</h1>
        <StateCard
          variant="empty"
          title="No accounts yet"
          primaryAction={
            <Link
              href="/import"
              className="inline-flex min-h-11 items-center text-base font-medium text-terracotta underline-offset-4 hover:underline"
            >
              Import a CSV to get started →
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6 [font-variant-numeric:tabular-nums]">
      {/* Newsreader, modest. Not a hero. */}
      <h1 className="font-display text-xl font-semibold">Accounts</h1>

      <section aria-labelledby="assets-heading">
        <h2
          id="assets-heading"
          className="mb-2 font-mono text-xs uppercase tracking-wide text-ink-3"
        >
          Assets
        </h2>
        <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          {assets.map((a) => (
            <AccountRow key={a.id} account={a} today={today} />
          ))}
          {/* D4=A — "Cash", not "Total". The rail and this page both answer
              "can I afford this," and net worth cannot. */}
          <SubtotalRow label="Cash" cents={summary.assetsCents} context="asset" className="sm:px-5" />
        </ul>
      </section>

      <section aria-labelledby="liabilities-heading">
        <h2
          id="liabilities-heading"
          className="mb-2 font-mono text-xs uppercase tracking-wide text-ink-3"
        >
          Liabilities
        </h2>
        <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          {liabilities.length === 0 ? (
            /* DS54 — the section STAYS when there are none. Hiding it leaves a
               page named Accounts with no path to the account type this whole
               feature exists to add, and nobody learns the Cash / Debt / Net
               worth structure until they trip over it. */
            <li className="bg-[var(--bg-inset)] px-4 py-4 text-center sm:px-5">
              <p className="text-base text-ink-2">No liabilities tracked yet</p>
              <Link
                href="/import"
                className="mt-1 inline-flex min-h-11 items-center text-base font-medium text-terracotta underline-offset-4 hover:underline"
              >
                Add a credit card or loan →
              </Link>
            </li>
          ) : (
            liabilities.map((a, i) => (
              <LiabilityListItem
                key={a.id}
                account={a}
                today={today}
                categories={categories}
                showLongTermHeading={i === firstLongTermIndex}
              />
            ))
          )}
          {liabilities.length > 0 ? (
            <SubtotalRow
              label="Debt"
              cents={summary.liabilitiesCents}
              context="liability"
              className="sm:px-5"
              note={
                debtPaidDown > 0 ? (
                  <p className="font-mono text-xs text-ledger">
                    paid down {formatCents(debtPaidDown)} this month
                  </p>
                ) : null
              }
            />
          ) : null}
        </ul>
      </section>

      <section aria-label="Net worth">
        <NetWorthRow cents={summary.netWorthCents} />
      </section>
    </main>
  );
}

/**
 * DS66 — DS59's muted mortgage is INVISIBLE to a screen reader, so LONG-TERM
 * has to be a real grouping label rather than lower-contrast ink alone.
 */
function LiabilityListItem({
  account,
  today,
  categories,
  showLongTermHeading,
}: {
  account: AccountRowData;
  today: string;
  categories: LeafCategory[];
  showLongTermHeading: boolean;
}) {
  return (
    <AccountRow
      account={account}
      today={today}
      categories={categories}
      heading={showLongTermHeading ? "Long-term" : undefined}
    />
  );
}
