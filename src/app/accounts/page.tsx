import { connection } from "next/server";
import Link from "next/link";
import { db } from "@/db";
import { hasAnyTransactionRows } from "@/lib/accounts/hasAnyTransactionRows";
import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import { loadAccountBalances } from "@/lib/accounts/loadAccountBalances";
import { paidDownCents } from "@/lib/accounts/paidDownCents";
import { summarizeBalances } from "@/lib/accounts/summarizeBalances";
import { formatCents, moneyToneClass } from "@/lib/money";
import { currentMonth, todayIso } from "@/lib/now";
import { StateCard } from "@/components/ledger/state-card";
import { AccountRow, SubtotalRow, type AccountRowData } from "./_account-row";

export default async function AccountsPage() {
  // Same reason as /import and the Spine: without this Next 16 prerenders the
  // route and freezes every balance at build time.
  await connection();

  const { year, month } = currentMonth();
  const today = todayIso();

  const balances = loadAccountBalances(db);
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
              className="text-base font-medium text-terracotta underline-offset-4 hover:underline"
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
          <SubtotalRow label="Cash" cents={summary.assetsCents} context="asset" />
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
                className="mt-1 inline-block text-base font-medium text-terracotta underline-offset-4 hover:underline"
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
                showLongTermHeading={i === firstLongTermIndex}
              />
            ))
          )}
          {liabilities.length > 0 ? (
            <SubtotalRow
              label="Debt"
              cents={summary.liabilitiesCents}
              context="liability"
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

      {/* The ledger double rule carries the "this is the bottom line" signal;
          DS51 keeps the type at subtotal size because size on top of that is
          shouting, and the thing it would shout is a six-figure negative on a
          page you open when you are already anxious about debt. */}
      <section aria-label="Net worth">
        <div className="border-t-[3px] border-double border-[var(--rule-strong)] pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 px-1">
            <span className="font-mono text-xs uppercase tracking-wide text-ink-2">
              Net worth
            </span>
            <span
              className={`font-mono text-lg ${moneyToneClass(summary.netWorthCents)}`}
              aria-label={
                summary.netWorthCents < 0
                  ? `negative ${formatCents(Math.abs(summary.netWorthCents))}`
                  : undefined
              }
            >
              {formatCents(summary.netWorthCents)}
            </span>
          </div>
        </div>
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
  showLongTermHeading,
}: {
  account: AccountRowData;
  today: string;
  showLongTermHeading: boolean;
}) {
  if (!showLongTermHeading) {
    return <AccountRow account={account} today={today} />;
  }
  return (
    <>
      <li className="px-4 pt-3 sm:px-5">
        <h3 className="font-mono text-xs uppercase tracking-wide text-ink-3">Long-term</h3>
      </li>
      <AccountRow account={account} today={today} />
    </>
  );
}
