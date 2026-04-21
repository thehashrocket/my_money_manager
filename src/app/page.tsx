import { connection } from "next/server";
import Link from "next/link";
import { db } from "@/db";
import { loadAccountBalances, type AccountBalance } from "@/lib/accounts/loadAccountBalances";
import { loadMonthView, type MonthViewSummary, type UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { loadMonthlyTrends, type TrendData } from "@/lib/trends/loadMonthlyTrends";
import { formatCents } from "@/lib/money";
import { BacklogBanner } from "@/app/_components/BacklogBanner";
import { TrendChart } from "@/components/ledger/trend-chart";

export default async function Home() {
  await connection();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const accounts = loadAccountBalances(db);
  const view = loadMonthView(db, year, month);
  const trends = loadMonthlyTrends(db);

  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  if (accounts.length === 0) {
    return <EmptyState />;
  }

  const totalCents = accounts.reduce((sum, a) => sum + a.balanceCents, 0);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6 [font-variant-numeric:tabular-nums]">
      {view.uncategorizedBacklog.count > 0 ? (
        <BacklogBanner backlog={view.uncategorizedBacklog} variant="budget" />
      ) : null}

      <h1 className="font-display text-xl font-semibold">{monthLabel}</h1>

      <section className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {accounts.map((account) => (
            <AccountTile key={account.id} account={account} />
          ))}
        </div>
        <div className="flex items-center justify-between px-1">
          <span className="font-mono text-sm text-ink-3 uppercase tracking-wide">
            Total
          </span>
          <span
            className={`font-mono text-lg font-semibold ${
              totalCents > 0
                ? "text-money-pos"
                : totalCents < 0
                  ? "text-money-neg"
                  : "text-money-zero"
            }`}
          >
            {formatCents(totalCents)}
          </span>
        </div>
      </section>

      <MonthlySummary summary={view.summary} />

      <SpendingTrends trends={trends} />

      {view.uncategorizedBacklog.count > 0 ? (
        <BacklogTile backlog={view.uncategorizedBacklog} />
      ) : null}

      <div className="flex gap-3 pt-2">
        <Link
          href="/budget"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
        >
          Open budget →
        </Link>
        <Link
          href="/transactions"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
        >
          View transactions →
        </Link>
      </div>
    </main>
  );
}

function AccountTile({ account }: { account: AccountBalance }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-soft">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-sm text-ink-2 uppercase tracking-wide">
          {account.name}
        </span>
        <span className="rounded-xs bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {account.type}
        </span>
      </div>
      <div
        className={`font-mono text-2xl font-semibold ${
          account.balanceCents > 0
            ? "text-money-pos"
            : account.balanceCents < 0
              ? "text-money-neg"
              : "text-money-zero"
        }`}
      >
        {formatCents(account.balanceCents)}
      </div>
    </div>
  );
}

function MonthlySummary({ summary }: { summary: MonthViewSummary }) {
  const cells: [string, number][] = [
    ["Allocated", summary.allocatedCents],
    ["Effective", summary.effectiveCents],
    ["Spent", summary.spentCents],
    ["Remaining", summary.remainingCents],
  ];
  return (
    <section>
      <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        This month
      </h2>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {cells.map(([label, cents]) => {
          const isRemaining = label === "Remaining";
          const tone = isRemaining
            ? cents < 0
              ? "text-destructive"
              : cents === 0
                ? "text-money-zero"
                : "text-money-pos"
            : "";
          return (
            <div
              key={label}
              className="rounded-md border border-border bg-card px-3 py-2"
            >
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className={`font-medium ${tone}`}>{formatCents(cents)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BacklogTile({ backlog }: { backlog: UncategorizedBacklog }) {
  const plural = backlog.count === 1 ? "" : "s";
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
      style={{
        background: "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
        borderColor: "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
      }}
    >
      <span style={{ color: "color-mix(in oklch, var(--accent-amber) 50%, var(--foreground))" }}>
        <strong className="text-foreground">{backlog.count}</strong>{" "}
        uncategorized transaction{plural} — {formatCents(backlog.totalCents)}
      </span>
      <Link
        href="/categorize"
        className="whitespace-nowrap font-medium underline-offset-4 hover:underline"
        style={{ color: "color-mix(in oklch, var(--accent-amber) 60%, var(--foreground))" }}
      >
        Categorize backlog →
      </Link>
    </div>
  );
}

function SpendingTrends({ trends }: { trends: TrendData }) {
  return (
    <section>
      <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        Spending — last 6 months
      </h2>
      <div className="rounded-lg border border-border bg-card p-4 shadow-soft">
        <TrendChart months={trends.months} categoryNames={trends.categoryNames} />
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-sm rounded-lg border border-border bg-muted/40 px-8 py-10 text-center">
        <div className="mb-3 font-mono text-3xl text-muted-foreground">∅</div>
        <p className="mb-4 text-sm text-muted-foreground">No accounts yet.</p>
        <Link
          href="/import"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Import a CSV to get started →
        </Link>
      </div>
    </main>
  );
}
