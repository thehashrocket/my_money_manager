import { connection } from "next/server";
import Link from "next/link";
import { db } from "@/db";
import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import {
  loadAccountBalancesForRequest,
  type AccountBalance,
} from "@/lib/accounts/loadAccountBalances";
import { paidDownCents } from "@/lib/accounts/paidDownCents";
import { summarizeBalances } from "@/lib/accounts/summarizeBalances";
import { loadMonthView, type MonthViewSummary, type UncategorizedBacklog } from "@/lib/budget/loadMonthView";
import { monthPhase } from "@/lib/budget/monthOfIso";
import { rankByProximity, type ProximityRow } from "@/lib/budget/rankByProximity";
import { TONE_CLASS } from "@/lib/budget/resolveRowDisplay";
import { NetWorthRow, SubtotalRow } from "@/components/ledger/balance-list";
import { loadMonthlyTrends, type TrendData } from "@/lib/trends/loadMonthlyTrends";
import { formatCents, moneyToneClass } from "@/lib/money";
import { currentMonth } from "@/lib/now";
import { BacklogBanner } from "@/app/_components/BacklogBanner";
import { TrendChart } from "@/components/ledger/trend-chart";
import { SummaryStrip, type SummaryStripCell } from "@/components/ledger/summary-strip";

export default async function Home() {
  await connection();
  const { year, month } = currentMonth();

  const accounts = loadAccountBalancesForRequest();
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

  const phase = monthPhase(year, month);
  const allLeaves = view.sections.flatMap((section) => section.categories);

  const summary = summarizeBalances(accounts);
  const assets = accounts.filter((a) => a.class === "asset");
  const liabilities = accounts
    .filter((a) => a.class === "liability")
    .sort((a, b) => Number(isLongTermLiability(a.type)) - Number(isLongTermLiability(b.type)));
  const closestToLimit = rankByProximity(allLeaves, phase, 5);
  const debtPaidDownCents = liabilities.reduce(
    (sum, a) => sum + (paidDownCents(a.id, year, month, db) ?? 0),
    0,
  );

  return (
    <main className="mx-auto max-w-3xl p-5 space-y-7 [font-variant-numeric:tabular-nums]">
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

      {/* DS49 — between "This month" and the trend chart. The chart is the one
          section read monthly rather than daily, so it is demoted one slot. */}
      {/* Ranked once. `rankByProximity` returns `rows.slice(0, limit)` off an
          identically-ordered array, so the mobile list is exactly the first
          three of the desktop five — calling it twice re-walked every leaf and
          re-sorted to reach a result already in hand. */}
      <ClosestToLimit
        desktop={closestToLimit}
        mobile={closestToLimit.slice(0, 3)}
        year={year}
        month={month}
      />

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
  const firstLongTermIndex = liabilities.findIndex((a) => isLongTermLiability(a.type));
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
            {liabilities.map((a, i) => (
              /* DS66 — the muting on a long-term row is lower-contrast ink,
                 which is invisible to a screen reader. LONG-TERM has to be a
                 real grouping heading, never muting alone. The dashboard
                 sorted long-term-last as if a heading were coming, then
                 omitted it, so the only signal here was colour.

                 Inside the row's own <li>, not a sibling one, so the parent's
                 `divide-y` draws a single rule above the group instead of one
                 above the label and another between the label and its row. */
              <BalanceRow
                key={a.id}
                account={a}
                heading={i === firstLongTermIndex ? "Long-term" : undefined}
              />
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
        </div>
      ) : null}

      {/* Outside the liabilities conditional, deliberately. Nested inside it,
          a user with only checking and savings saw ASSETS + Cash and nothing
          below — no bottom line at all — while /accounts showed one for the
          same ledger. DS49: two surfaces answering "where do I stand" should
          not look like two different products. */}
      <NetWorthRow cents={summary.netWorthCents} />
    </section>
  );
}

function BalanceRow({ account, heading }: { account: AccountBalance; heading?: string }) {
  const isLiability = account.class === "liability";
  const longTerm = isLongTermLiability(account.type);
  return (
    <li className="px-4 py-3">
      {heading ? (
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-ink-3">{heading}</h3>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
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
          aria-label={
            isLiability ? `owed ${formatCents(Math.abs(account.balanceCents))}` : undefined
          }
        >
          {formatCents(account.balanceCents)}
        </span>
      </div>
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
    <main className="flex min-h-[60vh] items-center justify-center p-5">
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

/**
 * DS53 — "Closest to limit": a ruled list, not tiles, ranked by severity.
 *
 * Item 1 of what the user asked for ("visual indicators of how close a
 * budgeted category is to its max") was already built on /budget; the gap was
 * the dashboard, which showed four aggregate numbers and a chart and nothing
 * per-envelope. This reads the SAME `loadMonthView` object page.tsx already
 * loads for the summary strip — no new query — and every row goes through
 * `resolveRowDisplay`, exactly as `_month-editor.tsx` does, so the tone/bar/
 * badge rules cannot drift between the two surfaces.
 *
 * The heading states what the area IS rather than what it contains, and the
 * whole section is OMITTED (not rendered empty) when no leaf has either an
 * allocation or spend this month.
 *
 * 5 rows on desktop, 3 on mobile — both computed server-side and swapped with
 * Tailwind's `hidden sm:block` pair, the same approach /budget's MobileCards
 * uses rather than JS breakpoint detection.
 */
function ClosestToLimit({
  desktop,
  mobile,
  year,
  month,
}: {
  desktop: ProximityRow[];
  mobile: ProximityRow[];
  year: number;
  month: number;
}) {
  if (desktop.length === 0) return null;
  return (
    <section aria-labelledby="closest-heading">
      <h2
        id="closest-heading"
        className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground"
      >
        Closest to limit
      </h2>
      <ul className="hidden divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg border border-border bg-card shadow-soft sm:block">
        {desktop.map((row) => (
          <ProximityListRow key={row.categoryId} row={row} year={year} month={month} />
        ))}
      </ul>
      <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg border border-border bg-card shadow-soft sm:hidden">
        {mobile.map((row) => (
          <ProximityListRow key={row.categoryId} row={row} year={year} month={month} />
        ))}
      </ul>
    </section>
  );
}

function ProximityListRow({
  row,
  year,
  month,
}: {
  row: ProximityRow;
  year: number;
  month: number;
}) {
  const overflow = row.display.badges.find((b) => b.type === "overflow");
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Link
          href={`/budget/${year}/${month}`}
          className="font-display text-base text-ink-1 underline-offset-4 hover:underline"
        >
          {row.name}
        </Link>
        <span className={`font-mono text-sm ${TONE_CLASS[row.display.tone]}`}>
          {/* DS14 — `formatCents` cannot express "no budget_periods row" as
              distinct from "a row allocating $0", which is what
              `amountPlaceholder` is for. "($600.00) left" against a budget
              that was never set reads as a number the user chose. */}
          {row.display.amountPlaceholder
            ? "no budget set"
            : `${formatCents(row.effectiveCents - row.spentCents)} left`}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {/* aria-hidden: the figures beside it are the accessible value. */}
        <div
          aria-hidden
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]"
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${row.display.barPct}%`,
              background: `var(--accent-${row.display.barTone})`,
            }}
          />
        </div>
        {/* DS8'/DS40 — the bar stays amber past 100%; this 2px redbrown tick
            is the one red signal, so the bar itself never doubles it. */}
        {overflow ? (
          <span
            aria-hidden
            className="h-1.5 w-0.5 shrink-0 rounded-full bg-redbrown"
          />
        ) : null}
      </div>
      <p className="mt-1 font-mono text-xs text-ink-3">
        {row.display.amountPlaceholder
          ? `${formatCents(row.spentCents)} spent`
          : `${formatCents(row.spentCents)} of ${formatCents(row.effectiveCents)}`}
        {overflow && !row.display.amountPlaceholder ? (
          <span className="text-redbrown">
            {" · "}
            {formatCents(overflow.amountCents)} over
          </span>
        ) : null}
      </p>
    </li>
  );
}
