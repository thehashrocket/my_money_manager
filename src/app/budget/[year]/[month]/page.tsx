import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import {
  loadMonthView,
  type LeafRow,
  type MonthView,
  type MonthViewSummary,
  type SectionGroup,
} from "@/lib/budget/loadMonthView";
import { formatCents } from "@/lib/money";
import { BacklogBanner } from "@/app/_components/BacklogBanner";
import { AllocateFormTrigger } from "./_allocate-form";

/**
 * Route params arrive as strings from the URL; Zod coerces + bounds them.
 * Anything the schema rejects (non-numeric, month > 12, year < 2000) routes
 * through `notFound()` — Next's 404 UI, not a server-rendered error banner,
 * per review decision 9 / T5A.
 */
const paramsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

type RouteParams = { year: string; month: string };

export default async function BudgetMonthPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const { year, month } = parsed.data;
  const view = loadMonthView(db, year, month);

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6 [font-variant-numeric:tabular-nums]">
      {view.uncategorizedBacklog.count > 0 ? (
        <BacklogBanner backlog={view.uncategorizedBacklog} variant="budget" />
      ) : null}

      <header className="space-y-2">
        <MonthNav year={year} month={month} />
        <Hero summary={view.summary} />
        <SummaryStrip summary={view.summary} />
      </header>

      <BudgetTable view={view} />
      <MobileCards view={view} />
    </main>
  );
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shiftMonth(year: number, month: number, delta: -1 | 1) {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function MonthNav({ year, month }: { year: number; month: number }) {
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  return (
    <nav className="flex items-center justify-between text-sm">
      <Link
        href={`/budget/${prev.year}/${prev.month}`}
        className="text-primary underline-offset-4 hover:underline"
      >
        ← {monthLabel(prev.year, prev.month)}
      </Link>
      <h1 className="text-lg font-semibold">{monthLabel(year, month)}</h1>
      <Link
        href={`/budget/${next.year}/${next.month}`}
        className="text-primary underline-offset-4 hover:underline"
      >
        {monthLabel(next.year, next.month)} →
      </Link>
    </nav>
  );
}

function Hero({ summary }: { summary: MonthViewSummary }) {
  const remaining = summary.remainingCents;
  const tone =
    remaining < 0
      ? "text-destructive"
      : remaining === 0
        ? "text-muted-foreground"
        : "text-emerald-800 dark:text-emerald-400";
  return (
    <div className="py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Total Remaining
      </div>
      <div className={`text-5xl font-semibold ${tone}`}>
        {formatCents(remaining)}
      </div>
    </div>
  );
}

function SummaryStrip({ summary }: { summary: MonthViewSummary }) {
  const cells: [string, number][] = [
    ["Allocated", summary.allocatedCents],
    ["Effective", summary.effectiveCents],
    ["Spent", summary.spentCents],
    ["Remaining", summary.remainingCents],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm">
      {cells.map(([label, cents]) => (
        <div
          key={label}
          className="rounded-md border border-border bg-card px-3 py-2"
        >
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="font-medium">{formatCents(cents)}</div>
        </div>
      ))}
    </div>
  );
}

function BudgetTable({ view }: { view: MonthView }) {
  if (view.sections.length === 0) {
    return (
      <div className="hidden sm:block rounded-md border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        No categories yet. Seed the five defaults via the pending migration, or
        add some from the (future) /categories route.
      </div>
    );
  }

  return (
    <div className="hidden sm:block overflow-hidden rounded-md border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-muted text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Category</th>
            <th className="px-3 py-2 text-right font-medium">Allocated</th>
            <th className="px-3 py-2 text-right font-medium">Rollover</th>
            <th className="px-3 py-2 text-right font-medium">Effective</th>
            <th className="px-3 py-2 text-right font-medium">Spent</th>
            <th className="px-3 py-2 text-right font-medium">Remaining</th>
            <th className="px-3 py-2 text-right font-medium">Allocate</th>
          </tr>
        </thead>
        <tbody>
          {view.sections.map((section) => (
            <SectionRows
              key={section.parentId ?? "ungrouped"}
              section={section}
              year={view.year}
              month={view.month}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({
  section,
  year,
  month,
}: {
  section: SectionGroup;
  year: number;
  month: number;
}) {
  const label = section.parentName ?? "Ungrouped";
  return (
    <>
      <tr className="bg-muted/40">
        <td
          colSpan={7}
          className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {label}
        </td>
      </tr>
      {section.categories.map((leaf) => (
        <LeafRowView
          key={leaf.categoryId}
          leaf={leaf}
          year={year}
          month={month}
        />
      ))}
    </>
  );
}

function LeafRowView({
  leaf,
  year,
  month,
}: {
  leaf: LeafRow;
  year: number;
  month: number;
}) {
  const allocated = leaf.allocation?.allocatedCents ?? 0;
  const rollover = leaf.allocation?.rolloverCents ?? 0;
  const effective = leaf.allocation?.effectiveCents ?? 0;
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2">
        <Link
          href={`/transactions?categoryId=${leaf.categoryId}&year=${year}&month=${month}`}
          className="text-primary underline-offset-4 hover:underline"
        >
          {leaf.name}
        </Link>
        {leaf.carryoverPolicy === "rollover" ? (
          <span className="ml-2 rounded-sm bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Rollover
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right">{formatCents(allocated)}</td>
      <td className="px-3 py-2 text-right text-muted-foreground">
        {rollover === 0 ? "—" : formatCents(rollover)}
      </td>
      <td className="px-3 py-2 text-right">{formatCents(effective)}</td>
      <td className="px-3 py-2 text-right">
        {formatCents(leaf.spentCents)}
        {leaf.pendingCents > 0 ? (
          <span
            title={`Includes ${formatCents(leaf.pendingCents)} pending`}
            className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground"
          >
            +p
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right">
        <RemainingCell leaf={leaf} />
      </td>
      <td className="px-3 py-2 text-right">
        <AllocateFormTrigger
          categoryId={leaf.categoryId}
          categoryName={leaf.name}
          year={year}
          month={month}
          allocation={leaf.allocation}
          carryoverPolicy={leaf.carryoverPolicy}
        />
      </td>
    </tr>
  );
}

function RemainingCell({ leaf }: { leaf: LeafRow }) {
  const effective = leaf.allocation?.effectiveCents ?? 0;
  const tone = leaf.isOverspent
    ? "text-destructive"
    : leaf.remainingCents === 0
      ? "text-muted-foreground"
      : "text-emerald-800 dark:text-emerald-400";
  const pct =
    effective > 0
      ? Math.min(100, Math.max(0, (leaf.spentCents / effective) * 100))
      : leaf.spentCents > 0
        ? 100
        : 0;
  const barTone = leaf.isOverspent
    ? "bg-destructive"
    : pct >= 80
      ? "bg-amber-500"
      : "bg-emerald-500";
  return (
    <div className="flex flex-col items-end gap-1">
      <span className={tone}>{formatCents(leaf.remainingCents)}</span>
      <div className="h-[2px] w-24 overflow-hidden rounded bg-muted">
        <div
          className={`h-full ${barTone}`}
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>
    </div>
  );
}

function MobileCards({ view }: { view: MonthView }) {
  if (view.sections.length === 0) {
    return (
      <div className="sm:hidden rounded-md border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
        No categories yet.
      </div>
    );
  }
  return (
    <div className="sm:hidden space-y-4">
      {view.sections.map((section) => (
        <section key={section.parentId ?? "ungrouped"} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {section.parentName ?? "Ungrouped"}
          </h2>
          <ul className="space-y-2">
            {section.categories.map((leaf) => (
              <li
                key={leaf.categoryId}
                className="rounded-md border border-border bg-card p-3 space-y-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={`/transactions?categoryId=${leaf.categoryId}&year=${view.year}&month=${view.month}`}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {leaf.name}
                  </Link>
                  <span
                    className={
                      leaf.isOverspent
                        ? "text-destructive"
                        : "text-emerald-800 dark:text-emerald-400"
                    }
                  >
                    {formatCents(leaf.remainingCents)}
                  </span>
                </div>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Allocated</dt>
                    <dd>
                      {formatCents(leaf.allocation?.allocatedCents ?? 0)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Effective</dt>
                    <dd>
                      {formatCents(leaf.allocation?.effectiveCents ?? 0)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Spent</dt>
                    <dd>{formatCents(leaf.spentCents)}</dd>
                  </div>
                </dl>
                <AllocateFormTrigger
                  categoryId={leaf.categoryId}
                  categoryName={leaf.name}
                  year={view.year}
                  month={view.month}
                  allocation={leaf.allocation}
                  carryoverPolicy={leaf.carryoverPolicy}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
