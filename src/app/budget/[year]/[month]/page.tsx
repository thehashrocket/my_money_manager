import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { loadMonthView, type FundRow, type IncomeLeafRow, type MonthViewSummary } from "@/lib/budget/loadMonthView";
import { monthPhase, nextMonthOf, previousMonth } from "@/lib/budget/monthOfIso";
import { loadAccountBalances } from "@/lib/accounts/loadAccountBalances";
import { formatCents } from "@/lib/money";
import { BacklogBanner } from "@/app/_components/BacklogBanner";
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
import { BandSection } from "./_band-section";
import { MonthEditor } from "./_month-editor";

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
  /** T18: this element crosses into `<MonthEditor>`'s client boundary as
   * one of several sibling element-valued props (`noIncomeCta` alongside
   * `headerTop`/`summaryStrip`/`firstRunCard`) — RSC's Flight serialization
   * treats those as a list needing stable keys, distinct from the ordinary
   * single-hop Server→Client prop passing T11 already used safely. Callers
   * pass a slot-specific key so the two call sites (the header CTA and
   * `FirstRunCard`'s primary action) never collide. */
  key: string,
) {
  return (
    <AllocateFormTrigger
      key={key}
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
    firstIncomeAllocateCta(category, year, month, `Plan ${category.name} →`, "first-run-cta")
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

      {/* T18/DS13: everything from Left to Budget through the Income/Expense
          bands is one client island — see `_month-editor.tsx`'s own header
          comment for the full diagram. `headerTop`/`summaryStrip`/
          `firstRunCard` are server-rendered slots; none of the three reads
          live editor state (§6.1's diagram scopes the island to the
          numeral, not the whole header — see that file for why SummaryStrip
          and FirstRunCard deliberately stay static until the next
          navigation/revalidation). */}
      <MonthEditor
        year={year}
        month={month}
        phase={phase}
        railTotalCents={railTotalCents}
        plannedFundCents={view.summary.plannedFundCents}
        incomeSections={view.incomeSections}
        expenseSections={view.sections}
        uncategorizedRow={view.uncategorizedRow}
        noIncomeCta={
          firstIncomeCategory
            ? firstIncomeAllocateCta(firstIncomeCategory, year, month, `Plan ${firstIncomeCategory.name} →`, "no-income-cta")
            : undefined
        }
        headerTop={
          <div key="header-top" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
        }
        summaryStrip={<SummaryStrip key="summary-strip" cells={summaryStripCells(view.summary)} variant="ledger" />}
        firstRunCard={
          isFirstRun && firstIncomeCategory ? (
            <FirstRunCard
              key="first-run-card"
              category={firstIncomeCategory}
              year={year}
              month={month}
              backlogCount={view.uncategorizedBacklog.count}
              priorMonthLabel={priorMonthLabel}
              priorMonthHasAllocations={priorMonthHasAllocations}
            />
          ) : null
        }
      />

      {/* A6: FUNDS renders only when a fund category exists — nothing to
          reconcile with an empty section. */}
      {view.summary.fundCount > 0 ? (
        <BandSection heading="Funds">
          <FundsTable fundRows={view.fundRows} plannedFundCents={view.summary.plannedFundCents} year={year} month={month} />
          <MobileFundsList fundRows={view.fundRows} plannedFundCents={view.summary.plannedFundCents} />
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

/* ── FUNDS — desktop table (read-only, A6/D3A). Stays server-rendered:
   PR2a's inline editing is expense/income only (§6.1's diagram never lists
   a Funds editor), so this band has no live state to read. ────────────── */

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

function MobileFundsList({ fundRows, plannedFundCents }: { fundRows: FundRow[]; plannedFundCents: number }) {
  return (
    <div className="space-y-2 sm:hidden">
      <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg bg-[var(--bg-raised)] shadow-soft">
        {fundRows.map((fund) => (
          <li key={fund.categoryId}>
            <Link href="/goals" className="flex items-center justify-between gap-2 px-3 py-2.5">
              <span className="font-display text-ink-1">{fund.name}</span>
              <span className="font-mono text-sm text-ink-1">{formatCents(fund.plannedCents)} →</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* Mirrors the desktop table's `TableFooter` subtotal row — without
          it, the band-level "what did I plan here" figure was only
          recoverable from `SummaryStrip`, which doesn't break out funding. */}
      <div className="flex items-center justify-between border-t-2 border-[var(--rule-strong)] px-1 pt-2 font-mono text-sm text-ink-2">
        <span>Σ planned funding</span>
        <span>{formatCents(plannedFundCents)}</span>
      </div>
    </div>
  );
}
