import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import {
  loadMonthView,
  type FundRow,
  type IncomeLeafRow,
  type LeafRow,
  type MonthViewSummary,
  type SectionGroup,
  type UncategorizedRow,
} from "@/lib/budget/loadMonthView";
import { monthPhase, nextMonthOf, previousMonth, type MonthPhase } from "@/lib/budget/monthOfIso";
import { loadAccountBalances } from "@/lib/accounts/loadAccountBalances";
import { formatCents } from "@/lib/money";
import { resolveRowDisplay, type BarTone, type RowBadge, type RowTone } from "@/lib/budget/resolveRowDisplay";
import { cn } from "@/lib/utils";
import { BacklogBanner } from "@/app/_components/BacklogBanner";
import { LeftToBudget } from "@/components/ledger/left-to-budget";
import { SummaryStrip, type SummaryStripCell } from "@/components/ledger/summary-strip";
import { StateCard } from "@/components/ledger/state-card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadReclassifyCandidates } from "@/lib/budget/setCategoryKind";
import { hasAnyAllocations } from "@/lib/budget/copyMonth";
import { AllocateFormTrigger } from "./_allocate-form";
import { ReclassifyIncomeBanner } from "./_reclassify-income";
import { CopyPreviousMonthButton } from "./_copy-month";

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

const TONE_CLASS: Record<RowTone, string> = {
  positive: "text-money-pos",
  negative: "text-money-neg",
  neutral: "text-money-zero",
  muted: "text-ink-3",
};

const BAR_CLASS: Record<BarTone, string> = {
  ledger: "bg-ledger",
  amber: "bg-amber-accent",
  redbrown: "bg-redbrown",
};

/**
 * DS31: both the Left to Budget hero's `no-income` CTA and DS30's first-run
 * card point at the SAME dialog — `AllocateFormTrigger` re-skinned via its
 * `triggerElement`/`triggerLabel` slots — rather than two mechanisms
 * pretending to be one. Two independent, uncontrolled dialog instances for
 * the same category-month is fine: only one is ever open at a time from
 * real use.
 */
function firstIncomeAllocateCta(
  category: IncomeLeafRow,
  year: number,
  month: number,
  label: string,
) {
  return (
    <AllocateFormTrigger
      categoryId={category.categoryId}
      categoryName={category.name}
      year={year}
      month={month}
      allocation={{ allocatedCents: category.plannedCents, rolloverCents: 0, effectiveCents: category.plannedCents }}
      carryoverPolicy="none"
      triggerElement={<Button variant="primary" />}
      triggerLabel={label}
    />
  );
}

/**
 * DS30 — the actual day-one screen: 50-odd categories, zero allocations.
 * Replaces the old `sections.length === 0` empty state, which `0017`'s
 * taxonomy seed makes permanently unreachable (10 groups + 46 leaves always
 * exist after that migration).
 *
 * DS36 — admits the page's own `Spent` figures are provisional when the
 * month-scoped backlog is non-empty, with a SECONDARY action to
 * `/categorize`; income stays primary. `BacklogBanner` above states the
 * condition ("you have uncategorized transactions"); this states the
 * consequence ("therefore Spent is wrong below").
 */
function FirstRunCard({
  category,
  year,
  month,
  backlogCount,
  priorMonthLabel,
  priorMonthHasAllocations,
}: {
  category: IncomeLeafRow;
  year: number;
  month: number;
  backlogCount: number;
  priorMonthLabel: string;
  priorMonthHasAllocations: boolean;
}) {
  // DS7: when the prior month has something to copy, THAT is the escape
  // hatch this card leads with — copying is less work than typing the first
  // income allocation by hand. DS30's plan-income CTA is what remains when
  // there is nothing to copy either (the true first-ever render).
  const primaryAction = priorMonthHasAllocations ? (
    <CopyPreviousMonthButton
      year={year}
      month={month}
      priorMonthLabel={priorMonthLabel}
      priorMonthHasAllocations
      variant="primary"
      label={`Copy ${priorMonthLabel}'s budget`}
    />
  ) : (
    firstIncomeAllocateCta(category, year, month, `Plan ${category.name} →`)
  );
  const secondaryAction = priorMonthHasAllocations ? (
    <Button variant="outline" render={<a href="#income-band" />}>
      Start blank
    </Button>
  ) : backlogCount > 0 ? (
    <Button variant="outline" render={<Link href="/categorize" />}>
      Categorize backlog →
    </Button>
  ) : undefined;

  return (
    <StateCard
      variant="empty"
      title={`Nothing is planned for ${monthLabel(year, month)} yet.`}
      description={
        <>
          <p>Start with your income — everything else is assigned from it.</p>
          {backlogCount > 0 ? (
            <p className="mt-1">
              {backlogCount} transaction{backlogCount === 1 ? "" : "s"} this month aren&apos;t categorized
              yet, so Spent is incomplete.
            </p>
          ) : null}
        </>
      }
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
    />
  );
}

export default async function BudgetMonthPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  // T11/DS6′: monthPhase reads the real clock, which Next 16 freezes during
  // prerender without this — same reason src/app/page.tsx calls it.
  await connection();

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const { year, month } = parsed.data;
  const view = loadMonthView(db, year, month);
  const phase = monthPhase(year, month);
  const accounts = loadAccountBalances(db);
  const railTotalCents = accounts.reduce((sum, a) => sum + a.balanceCents, 0);

  // D14A layer 1 / DS22: total failure when NO category is kind='income' —
  // Left to Budget has no left-hand side to subtract from. Unreachable
  // today (three income leaves always survive migration 0017's seed) until
  // PR2b's rename action can rename all three away.
  const hasIncomeCategory = view.incomeSections.some((s) => s.categories.length > 0);
  const reclassifyCandidates = hasIncomeCategory ? [] : loadReclassifyCandidates(db);

  // DS30/DS31: the first-run state needs a target for its primary action —
  // the first income leaf, by whatever order the INCOME band already sorts
  // by (planned DESC, so on a virgin month this is just the first
  // alphabetically). `null` only when `!hasIncomeCategory` too, in which
  // case the F1 banner above is the page's real story.
  const firstIncomeCategory = view.incomeSections.flatMap((s) => s.categories)[0] ?? null;
  // DS30: the first-run condition — nothing planned on EITHER side yet.
  // Stricter than Left to Budget's own `plannedIncome === 0` state: a month
  // with expense allocations already set but no income yet does not get
  // this card, only the hero's own message.
  const isFirstRun = view.summary.plannedIncomeCents === 0 && view.summary.allocatedCents === 0;

  const prior = previousMonth(year, month);
  const priorMonthLabel = monthLabel(prior.year, prior.month);
  const priorMonthHasAllocations = hasAnyAllocations(db, prior.year, prior.month);

  return (
    <main className="mx-auto max-w-5xl space-y-7 p-6 [font-variant-numeric:tabular-nums]">
      {view.uncategorizedBacklog.count > 0 ? (
        <BacklogBanner backlog={view.uncategorizedBacklog} variant="budget" />
      ) : null}
      {!hasIncomeCategory ? <ReclassifyIncomeBanner candidates={reclassifyCandidates} /> : null}

      <header className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <MonthNav year={year} month={month} />
          </div>
          {/* DS7: "in any other month the trigger is a btn-outline beside
              MonthNav" — the first-run card already leads with this same
              action when it's showing, so it doesn't need a second copy. */}
          {!isFirstRun ? (
            <CopyPreviousMonthButton
              year={year}
              month={month}
              priorMonthLabel={priorMonthLabel}
              priorMonthHasAllocations={priorMonthHasAllocations}
            />
          ) : null}
        </div>
        <LeftToBudget
          plannedIncomeCents={view.summary.plannedIncomeCents}
          allocatedCents={view.summary.allocatedCents}
          plannedFundCents={view.summary.plannedFundCents}
          leftToBudgetCents={view.summary.leftToBudgetCents}
          phase={phase}
          railTotalCents={railTotalCents}
          noIncomeCta={
            firstIncomeCategory
              ? firstIncomeAllocateCta(firstIncomeCategory, year, month, `Plan ${firstIncomeCategory.name} →`)
              : undefined
          }
        />
        <SummaryStrip cells={summaryStripCells(view.summary)} variant="ledger" />
      </header>

      {isFirstRun && firstIncomeCategory ? (
        <FirstRunCard
          category={firstIncomeCategory}
          year={year}
          month={month}
          backlogCount={view.uncategorizedBacklog.count}
          priorMonthLabel={priorMonthLabel}
          priorMonthHasAllocations={priorMonthHasAllocations}
        />
      ) : null}

      {/* A1: bands come from `kind`, groups from `parent_id` — never
          conflated. Each band is its own table (DS18), so income's column
          meaning never silently inherits expense's. */}
      <BandSection heading="Income" id="income-band">
        <IncomeTable
          sections={view.incomeSections}
          plannedIncomeCents={view.summary.plannedIncomeCents}
          phase={phase}
          year={year}
          month={month}
        />
        <MobileIncomeList sections={view.incomeSections} phase={phase} year={year} month={month} />
      </BandSection>

      <BandSection heading="Expenses">
        <ExpenseTable
          sections={view.sections}
          uncategorizedRow={view.uncategorizedRow}
          allocatedCents={view.summary.allocatedCents}
          phase={phase}
          year={year}
          month={month}
        />
        <MobileExpenseList
          sections={view.sections}
          uncategorizedRow={view.uncategorizedRow}
          phase={phase}
          year={year}
          month={month}
        />
      </BandSection>

      {/* A6: FUNDS renders only when a fund category exists — nothing to
          reconcile with an empty section. */}
      {view.summary.fundCount > 0 ? (
        <BandSection heading="Funds">
          <FundsTable fundRows={view.fundRows} plannedFundCents={view.summary.plannedFundCents} year={year} month={month} />
          <MobileFundsList fundRows={view.fundRows} />
        </BandSection>
      ) : null}
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

function MonthNav({ year, month }: { year: number; month: number }) {
  const prev = previousMonth(year, month);
  const next = nextMonthOf(year, month);
  return (
    <nav className="flex items-center justify-between text-sm">
      <Link href={`/budget/${prev.year}/${prev.month}`} className="text-terracotta underline-offset-4 hover:underline">
        ← {monthLabel(prev.year, prev.month)}
      </Link>
      <h1 className="font-display text-lg font-medium text-ink-1">{monthLabel(year, month)}</h1>
      <Link href={`/budget/${next.year}/${next.month}`} className="text-terracotta underline-offset-4 hover:underline">
        {monthLabel(next.year, next.month)} →
      </Link>
    </nav>
  );
}

/** DS2: five paired stat cells — `SummaryStrip` (T13) renders them. */
function summaryStripCells(summary: MonthViewSummary): SummaryStripCell[] {
  return [
    { label: "Planned income", cents: summary.plannedIncomeCents },
    { label: "Received", cents: summary.receivedIncomeCents },
    { label: "Planned spending", cents: summary.allocatedCents },
    { label: "Spent", cents: summary.spentCents },
    {
      label: "Remaining",
      cents: summary.remainingCents,
      tone: summary.remainingCents < 0 ? "neg" : summary.remainingCents === 0 ? "zero" : "pos",
    },
  ];
}

function BandSection({
  heading,
  id,
  children,
}: {
  heading: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-2">
      <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-ink-2">{heading}</h2>
      {children}
    </section>
  );
}

function RowBadges({ badges }: { badges: RowBadge[] }) {
  return (
    <>
      {badges.map((badge, i) => {
        if (badge.type === "pending") {
          return (
            <span
              key={i}
              title={`Includes ${formatCents(badge.amountCents)} pending`}
              className="ml-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-3"
            >
              +p
            </span>
          );
        }
        if (badge.type === "over-plan") {
          return (
            <span key={i} className="ml-1.5 font-mono text-[10px] text-ledger">
              +{formatCents(badge.amountCents)} over plan
            </span>
          );
        }
        return (
          <span
            key={i}
            aria-hidden
            title={`${formatCents(badge.amountCents)} over budget`}
            className="ml-1.5 inline-block h-2 w-[2px] align-middle bg-redbrown"
          />
        );
      })}
    </>
  );
}

function Bar({ pct, tone }: { pct: number; tone: BarTone }) {
  return (
    <div className="h-[2px] w-24 overflow-hidden rounded-full bg-[var(--bg-inset)]" aria-hidden>
      <div className={cn("h-full", BAR_CLASS[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ── EXPENSES — desktop table ─────────────────────────────────────────── */

function ExpenseTable({
  sections,
  uncategorizedRow,
  allocatedCents,
  phase,
  year,
  month,
}: {
  sections: SectionGroup<LeafRow>[];
  uncategorizedRow: UncategorizedRow | null;
  allocatedCents: number;
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  return (
    <div className="hidden overflow-hidden rounded-lg shadow-soft sm:block">
      <Table className="border-collapse">
        <TableCaption className="sr-only">Expenses for {monthLabel(year, month)}</TableCaption>
        <TableHeader className="bg-[var(--bg-inset)] font-mono text-xs uppercase tracking-wide text-ink-2">
          <TableRow>
            <TableHead className="px-3">Category</TableHead>
            <TableHead className="px-3 text-right">Planned</TableHead>
            <TableHead className="px-3 text-right">Spent</TableHead>
            <TableHead className="px-3 text-right">Remaining</TableHead>
            <TableHead className="px-3 text-right">Allocate</TableHead>
          </TableRow>
        </TableHeader>
        {sections.map((section) => (
          <TableBody key={section.parentId ?? "unparented"}>
            {section.parentName ? (
              <TableRow className="bg-[var(--bg-inset)] hover:bg-[var(--bg-inset)]">
                <TableHead scope="rowgroup" colSpan={5} className="px-3 py-1.5 font-display text-sm font-normal text-ink-2">
                  {section.parentName}
                </TableHead>
              </TableRow>
            ) : null}
            {section.categories.map((leaf) => (
              <ExpenseDesktopRow key={leaf.categoryId} leaf={leaf} phase={phase} year={year} month={month} />
            ))}
          </TableBody>
        ))}
        {uncategorizedRow ? (
          <TableBody>
            {/* DS26: hairline separates the one row nobody can act on from
                the rows above it. `aria-hidden` — the cell beneath already
                announces its own header via `<th scope="row">`. */}
            <TableRow aria-hidden className="hover:bg-transparent">
              <TableCell colSpan={5} className="h-px border-t-2 border-[var(--rule-strong)] p-0" />
            </TableRow>
            <TableRow>
              <TableHead scope="row" className="px-3 py-2 font-normal text-ink-1">
                {uncategorizedRow.name}
              </TableHead>
              <TableCell className="px-3 py-2 text-right text-ink-3">—</TableCell>
              <TableCell className="px-3 py-2 text-right text-ink-1">{formatCents(uncategorizedRow.spentCents)}</TableCell>
              <TableCell className="px-3 py-2 text-right text-ink-3">—</TableCell>
              <TableCell className="px-3 py-2 text-right text-ink-3">—</TableCell>
            </TableRow>
          </TableBody>
        ) : null}
        <TableFooter className="bg-transparent">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="row" className="px-3 py-2 font-mono text-sm font-normal text-ink-2">
              Σ planned spending
            </TableHead>
            <TableCell className="px-3 py-2 text-right font-mono text-sm text-ink-2">{formatCents(allocatedCents)}</TableCell>
            <TableCell colSpan={3} />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function ExpenseDesktopRow({
  leaf,
  phase,
  year,
  month,
}: {
  leaf: LeafRow;
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  const effective = leaf.allocation?.effectiveCents ?? 0;
  const display = resolveRowDisplay(
    {
      effectiveCents: effective,
      spentCents: leaf.spentCents,
      pendingCents: leaf.pendingCents,
      hasAllocation: leaf.allocation !== null,
    },
    "expense",
    phase,
  );
  return (
    <TableRow>
      <TableHead scope="row" className="px-3 py-2 font-normal">
        <Link
          href={`/transactions?categoryId=${leaf.categoryId}&year=${year}&month=${month}`}
          className="font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {leaf.name}
        </Link>
        {leaf.carryoverPolicy === "rollover" ? (
          <span className="ml-2 rounded-xs bg-[var(--bg-inset)] px-1 font-mono text-[10px] uppercase tracking-wide text-ink-2">
            Rollover
          </span>
        ) : null}
      </TableHead>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        {display.amountPlaceholder ? <span className="text-ink-3">—</span> : formatCents(effective)}
      </TableCell>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        {formatCents(leaf.spentCents)}
        <RowBadges badges={display.badges} />
      </TableCell>
      <TableCell className="px-3 py-2 text-right">
        <div className="flex flex-col items-end gap-1">
          <span className={TONE_CLASS[display.tone]}>{formatCents(leaf.remainingCents)}</span>
          <Bar pct={display.barPct} tone={display.barTone} />
        </div>
      </TableCell>
      <TableCell className="px-3 py-2 text-right">
        <AllocateFormTrigger
          categoryId={leaf.categoryId}
          categoryName={leaf.name}
          year={year}
          month={month}
          allocation={leaf.allocation}
          carryoverPolicy={leaf.carryoverPolicy}
        />
      </TableCell>
    </TableRow>
  );
}

/* ── INCOME — desktop table ───────────────────────────────────────────── */

function IncomeTable({
  sections,
  plannedIncomeCents,
  phase,
  year,
  month,
}: {
  sections: SectionGroup<IncomeLeafRow>[];
  plannedIncomeCents: number;
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  return (
    <div className="hidden overflow-hidden rounded-lg shadow-soft sm:block">
      <Table className="border-collapse">
        <TableCaption className="sr-only">Income for {monthLabel(year, month)}</TableCaption>
        {/* DS18: income keeps its own column header row rather than
            inheriting the expense table's — the heavier rule beneath marks
            the boundary where column meaning changes. */}
        <TableHeader className="border-b-2 border-[var(--rule-strong)] bg-[var(--bg-inset)] font-mono text-xs uppercase tracking-wide text-ink-2">
          <TableRow>
            <TableHead className="px-3">Category</TableHead>
            <TableHead className="px-3 text-right">Planned</TableHead>
            <TableHead className="px-3 text-right">Received</TableHead>
            <TableHead className="px-3 text-right">Variance</TableHead>
            <TableHead className="px-3 text-right">Allocate</TableHead>
          </TableRow>
        </TableHeader>
        {sections.map((section) => (
          <TableBody key={section.parentId ?? "unparented"}>
            {section.parentName ? (
              <TableRow className="bg-[var(--bg-inset)] hover:bg-[var(--bg-inset)]">
                <TableHead scope="rowgroup" colSpan={5} className="px-3 py-1.5 font-display text-sm font-normal text-ink-2">
                  {section.parentName}
                </TableHead>
              </TableRow>
            ) : null}
            {section.categories.map((income) => (
              <IncomeDesktopRow key={income.categoryId} income={income} phase={phase} year={year} month={month} />
            ))}
          </TableBody>
        ))}
        <TableFooter className="bg-transparent">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="row" className="px-3 py-2 font-mono text-sm font-normal text-ink-2">
              Σ planned income
            </TableHead>
            <TableCell className="px-3 py-2 text-right font-mono text-sm text-ink-2">{formatCents(plannedIncomeCents)}</TableCell>
            <TableCell colSpan={3} />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function IncomeDesktopRow({
  income,
  phase,
  year,
  month,
}: {
  income: IncomeLeafRow;
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  const display = resolveRowDisplay(
    {
      plannedCents: income.plannedCents,
      receivedCents: income.receivedCents,
      varianceCents: income.varianceCents,
      pendingCents: income.pendingCents,
      hasAllocation: income.hasAllocation,
    },
    "income",
    phase,
  );
  return (
    <TableRow>
      <TableHead scope="row" className="px-3 py-2 font-normal">
        <Link
          href={`/transactions?categoryId=${income.categoryId}&year=${year}&month=${month}`}
          className="font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {income.name}
        </Link>
      </TableHead>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        {display.amountPlaceholder ? <span className="text-ink-3">—</span> : formatCents(income.plannedCents)}
      </TableCell>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        {formatCents(income.receivedCents)}
        <RowBadges badges={display.badges} />
      </TableCell>
      <TableCell className={cn("px-3 py-2 text-right", TONE_CLASS[display.tone])}>
        {formatCents(income.varianceCents)}
      </TableCell>
      <TableCell className="px-3 py-2 text-right">
        <AllocateFormTrigger
          categoryId={income.categoryId}
          categoryName={income.name}
          year={year}
          month={month}
          allocation={{ allocatedCents: income.plannedCents, rolloverCents: 0, effectiveCents: income.plannedCents }}
          carryoverPolicy="none"
        />
      </TableCell>
    </TableRow>
  );
}

/* ── FUNDS — desktop table (read-only, A6/D3A) ────────────────────────── */

function FundsTable({
  fundRows,
  plannedFundCents,
  year,
  month,
}: {
  fundRows: FundRow[];
  plannedFundCents: number;
  year: number;
  month: number;
}) {
  return (
    <div className="hidden overflow-hidden rounded-lg shadow-soft sm:block">
      <Table className="border-collapse">
        <TableCaption className="sr-only">Funds for {monthLabel(year, month)}</TableCaption>
        <TableHeader className="bg-[var(--bg-inset)] font-mono text-xs uppercase tracking-wide text-ink-2">
          <TableRow>
            <TableHead className="px-3">Category</TableHead>
            <TableHead className="px-3 text-right">Planned</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fundRows.map((fund) => (
            <TableRow key={fund.categoryId}>
              <TableHead scope="row" className="px-3 py-2 font-normal">
                <Link href="/goals" className="font-display text-ink-1 underline-offset-4 hover:underline">
                  {fund.name}
                </Link>
              </TableHead>
              <TableCell className="px-3 py-2 text-right">
                <Link href="/goals" className="text-ink-1 underline-offset-4 hover:underline">
                  {formatCents(fund.plannedCents)} →
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter className="bg-transparent">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="row" className="px-3 py-2 font-mono text-sm font-normal text-ink-2">
              Σ planned funding
            </TableHead>
            <TableCell className="px-3 py-2 text-right font-mono text-sm text-ink-2">{formatCents(plannedFundCents)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

/* ── DS43 — mobile ledger list. Compact rows under the same band/group
   headings as desktop, reading the same `resolveRowDisplay` decisions
   rather than a folded-flap `EnvelopeCard` per row. ──────────────────── */

function MobileGroupHeading({ name }: { name: string | null }) {
  if (!name) return null;
  return <h3 className="font-display text-sm text-ink-2">{name}</h3>;
}

function MobileExpenseList({
  sections,
  uncategorizedRow,
  phase,
  year,
  month,
}: {
  sections: SectionGroup<LeafRow>[];
  uncategorizedRow: UncategorizedRow | null;
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  return (
    <div className="space-y-4 sm:hidden">
      {sections.map((section) => (
        <div key={section.parentId ?? "unparented"} className="space-y-2">
          <MobileGroupHeading name={section.parentName} />
          <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg bg-[var(--bg-raised)] shadow-soft">
            {section.categories.map((leaf) => (
              <MobileExpenseRow key={leaf.categoryId} leaf={leaf} phase={phase} year={year} month={month} />
            ))}
          </ul>
        </div>
      ))}
      {uncategorizedRow ? (
        <div className="space-y-2 border-t-2 border-[var(--rule-strong)] pt-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-ink-1">{uncategorizedRow.name}</span>
            <span className="font-mono text-ink-1">{formatCents(uncategorizedRow.spentCents)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MobileExpenseRow({
  leaf,
  phase,
  year,
  month,
}: {
  leaf: LeafRow;
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  const effective = leaf.allocation?.effectiveCents ?? 0;
  const display = resolveRowDisplay(
    {
      effectiveCents: effective,
      spentCents: leaf.spentCents,
      pendingCents: leaf.pendingCents,
      hasAllocation: leaf.allocation !== null,
    },
    "expense",
    phase,
  );
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <Link
          href={`/transactions?categoryId=${leaf.categoryId}&year=${year}&month=${month}`}
          className="min-w-0 truncate font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {leaf.name}
        </Link>
        <span className={cn("shrink-0 font-mono text-sm", TONE_CLASS[display.tone])}>
          {formatCents(leaf.remainingCents)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 font-mono text-xs text-ink-3">
          <span>
            {formatCents(leaf.spentCents)} / {display.amountPlaceholder ? "—" : formatCents(effective)}
          </span>
          <RowBadges badges={display.badges} />
          {leaf.carryoverPolicy === "rollover" ? (
            <span className="rounded-xs bg-[var(--bg-inset)] px-1 uppercase tracking-wide">Rollover</span>
          ) : null}
        </div>
        <div className="w-16">
          <Bar pct={display.barPct} tone={display.barTone} />
        </div>
      </div>
      <div className="mt-2">
        <AllocateFormTrigger
          categoryId={leaf.categoryId}
          categoryName={leaf.name}
          year={year}
          month={month}
          allocation={leaf.allocation}
          carryoverPolicy={leaf.carryoverPolicy}
        />
      </div>
    </li>
  );
}

function MobileIncomeList({
  sections,
  phase,
  year,
  month,
}: {
  sections: SectionGroup<IncomeLeafRow>[];
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  return (
    <div className="space-y-4 sm:hidden">
      {sections.map((section) => (
        <div key={section.parentId ?? "unparented"} className="space-y-2">
          <MobileGroupHeading name={section.parentName} />
          <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg bg-[var(--bg-raised)] shadow-soft">
            {section.categories.map((income) => (
              <MobileIncomeRow key={income.categoryId} income={income} phase={phase} year={year} month={month} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function MobileIncomeRow({
  income,
  phase,
  year,
  month,
}: {
  income: IncomeLeafRow;
  phase: MonthPhase;
  year: number;
  month: number;
}) {
  const display = resolveRowDisplay(
    {
      plannedCents: income.plannedCents,
      receivedCents: income.receivedCents,
      varianceCents: income.varianceCents,
      pendingCents: income.pendingCents,
      hasAllocation: income.hasAllocation,
    },
    "income",
    phase,
  );
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <Link
          href={`/transactions?categoryId=${income.categoryId}&year=${year}&month=${month}`}
          className="min-w-0 truncate font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {income.name}
        </Link>
        <span className={cn("shrink-0 font-mono text-sm", TONE_CLASS[display.tone])}>
          {formatCents(income.varianceCents)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1 font-mono text-xs text-ink-3">
        <span>
          {formatCents(income.receivedCents)} / {display.amountPlaceholder ? "—" : formatCents(income.plannedCents)}
        </span>
        <RowBadges badges={display.badges} />
      </div>
      <div className="mt-2">
        <AllocateFormTrigger
          categoryId={income.categoryId}
          categoryName={income.name}
          year={year}
          month={month}
          allocation={{ allocatedCents: income.plannedCents, rolloverCents: 0, effectiveCents: income.plannedCents }}
          carryoverPolicy="none"
        />
      </div>
    </li>
  );
}

function MobileFundsList({ fundRows }: { fundRows: FundRow[] }) {
  return (
    <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg bg-[var(--bg-raised)] shadow-soft sm:hidden">
      {fundRows.map((fund) => (
        <li key={fund.categoryId}>
          <Link href="/goals" className="flex items-center justify-between gap-2 px-3 py-2.5">
            <span className="font-display text-ink-1">{fund.name}</span>
            <span className="font-mono text-sm text-ink-1">{formatCents(fund.plannedCents)} →</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
