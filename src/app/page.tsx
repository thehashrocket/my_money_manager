import { connection } from "next/server";
import Link from "next/link";
import { db } from "@/db";
import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import { loadAccountBalances, type AccountBalance } from "@/lib/accounts/loadAccountBalances";
import { paidDownCents } from "@/lib/accounts/paidDownCents";
import { summarizeBalances } from "@/lib/accounts/summarizeBalances";
import { loadMonthView, type MonthViewSummary, type UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { loadMonthlyTrends, type TrendData } from "@/lib/trends/loadMonthlyTrends";
import { formatCents, moneyToneClass } from "@/lib/money";
import { currentMonth } from "@/lib/now";
import { BacklogBanner } from "@/app/_components/BacklogBanner";
import { TrendChart } from "@/components/ledger/trend-chart";
import { SummaryStrip, type SummaryStripCell } from "@/components/ledger/summary-strip";

export default async function Home() {
  await connection();
  const { year, month } = currentMonth();

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

  const summary = summarizeBalances(accounts);
  const assets = accounts.filter((a) => a.class === "asset");
  const liabilities = accounts
    .filter((a) => a.class === "liability")
    .sort((a, b) => Number(isLongTermLiability(a.type)) - Number(isLongTermLiability(b.type)));
  const debtPaidDownCents = liabilities.reduce(
    (sum, a) => sum + (paidDownCents(a.id, year, month, db) ?? 0),
    0,
  );

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6 [font-variant-numeric:tabular-nums]">
      {view.uncategorizedBacklog.count > 0 ? (
        <BacklogBanner backlog={view.uncategorizedBacklog} variant="budget" />
      ) : null}

      <h1 className="font-display text-xl font-semibold">{monthLabel}</h1>

      <BalanceSection
        assets={assets}
        liabilities={liabilities}
        summary={summary}
        debtPaidDownCents={debtPaidDownCents}
      />

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

/**
 * DS49 — the balance section is ruled row-lists, not a card mosaic.
 *
 * Codex's outside-voice pass triggered two hard rejections against this page:
 * "#1 generic SaaS card grid as first impression" and "#7 app UI made of
 * stacked cards instead of layout". `AccountTile` was a `grid-cols-1
 * sm:grid-cols-2` of bordered boxes whose entire content was a name and a
 * number — a `<div>` with a border tax — and adding liability tiles plus
 * proximity tiles on top of it is what makes the mosaic. Same idiom as
 * `/accounts` now, deliberately: two surfaces answering "where do I stand"
 * should not look like two different products.
 *
 * The SummaryStrip below is NOT touched (DS45's `variant="plain"` stays) —
 * only the balance section above it and the new list below it.
 */
function BalanceSection({
  assets,
  liabilities,
  summary,
  debtPaidDownCents,
}: {
  assets: AccountBalance[];
  liabilities: AccountBalance[];
  summary: { assetsCents: number; liabilitiesCents: number; netWorthCents: number };
  debtPaidDownCents: number;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-ink-3">Assets</h2>
        <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          {assets.map((a) => (
            <BalanceRow key={a.id} account={a} />
          ))}
          <SubtotalRow label="Cash" cents={summary.assetsCents} context="asset" />
        </ul>
      </div>

      {liabilities.length > 0 ? (
        <div>
          <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-ink-3">
            Liabilities
          </h2>
          <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            {liabilities.map((a) => (
              <BalanceRow key={a.id} account={a} />
            ))}
            <SubtotalRow
              label="Debt"
              cents={summary.liabilitiesCents}
              context="liability"
              note={
                debtPaidDownCents > 0 ? (
                  <p className="font-mono text-xs text-ledger">
                    paid down {formatCents(debtPaidDownCents)} this month
                  </p>
                ) : null
              }
            />
          </ul>
          <div className="mt-3 border-t-[3px] border-double border-[var(--rule-strong)] pt-3">
            <div className="flex items-baseline justify-between px-1">
              <span className="font-mono text-xs uppercase tracking-wide text-ink-2">
                Net worth
              </span>
              {/* DS51 — subtotal size, not larger. The ledger double rule
                  already carries the "bottom line" signal; type size on top of
                  it is shouting, and the thing it shouts is a six-figure
                  negative on a page you open when you are already anxious. */}
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
        </div>
      ) : null}
    </section>
  );
}

function BalanceRow({ account }: { account: AccountBalance }) {
  const isLiability = account.class === "liability";
  const longTerm = isLongTermLiability(account.type);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
      <span className={`font-display text-base ${longTerm ? "text-ink-3" : "text-ink-1"}`}>
        {account.name}
      </span>
      <span
        className={`font-mono text-lg ${
          longTerm
            ? "text-ink-3"
            : moneyToneClass(account.balanceCents, {
                context: isLiability ? "liability" : "asset",
              })
        }`}
        /* DS66 — parens are silent to a screen reader. */
        aria-label={isLiability ? `owed ${formatCents(Math.abs(account.balanceCents))}` : undefined}
      >
        {formatCents(account.balanceCents)}
      </span>
    </li>
  );
}

function SubtotalRow({
  label,
  cents,
  context,
  note,
}: {
  label: string;
  cents: number;
  context: "asset" | "liability";
  note?: React.ReactNode;
}) {
  return (
    <li className="bg-[var(--bg-inset)] px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="font-mono text-xs uppercase tracking-wide text-ink-2">{label}</span>
        <span
          className={`font-mono text-lg ${moneyToneClass(cents, { context })}`}
          aria-label={context === "liability" ? `owed ${formatCents(Math.abs(cents))}` : undefined}
        >
          {formatCents(cents)}
        </span>
      </div>
      {note ? <div className="mt-1">{note}</div> : null}
    </li>
  );
}

/**
 * T13/DS45: renders through the same `SummaryStrip` `/budget/[year]/[month]`
 * uses, `variant="plain"` — the dashboard hasn't had its own restyle
 * reviewed yet (§8), so this deliberately keeps today's bordered-card look
 * rather than importing DS39's ruled surface onto an unreviewed page.
 */
function MonthlySummary({ summary }: { summary: MonthViewSummary }) {
  const cells: SummaryStripCell[] = [
    { label: "Allocated", cents: summary.allocatedCents },
    { label: "Effective", cents: summary.effectiveCents },
    { label: "Spent", cents: summary.spentCents },
    {
      label: "Remaining",
      cents: summary.remainingCents,
      tone: summary.remainingCents < 0 ? "neg" : summary.remainingCents === 0 ? "zero" : "pos",
    },
  ];
  return (
    <section>
      <h2 className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        This month
      </h2>
      <SummaryStrip cells={cells} variant="plain" />
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
