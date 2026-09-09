import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { loadMonthView, type IncomeLeafRow, type MonthViewSummary } from "@/lib/budget/loadMonthView";
import { monthPhase, nextMonthOf, previousMonth } from "@/lib/budget/monthOfIso";
import { loadAccountBalancesForRequest } from "@/lib/accounts/loadAccountBalances";
import { BacklogBanner } from "@/app/_components/BacklogBanner";
import { SummaryStrip, type SummaryStripCell } from "@/components/ledger/summary-strip";
import { StateCard } from "@/components/ledger/state-card";
import { Button } from "@/components/ui/button";
import { loadReclassifyCandidates } from "@/lib/budget/setCategoryKind";
import { hasAnyAllocations } from "@/lib/budget/copyMonth";
import { AllocateFormTrigger } from "./_allocate-form";
import { ReclassifyIncomeBanner } from "./_reclassify-income";
import { CopyPreviousMonthButton } from "./_copy-month";
import { MonthEditor } from "./_month-editor";
import { BudgetHelpPanel } from "./_help-panel";

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
  const accounts = loadAccountBalancesForRequest();
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
  // `allocatedCents` is EXPENSE-KIND ONLY, so the fund term has to be its own
  // clause. Without it, funding a goal in a fresh month — the exact thing
  // D3=C exists to enable, and the "pay yourself first" order a person might
  // reasonably take — renders FirstRunCard's "Nothing is planned for
  // September yet" directly above a Funds band showing $500, and suppresses
  // the help panel too. Unreachable while the band was read-only; reachable
  // the moment it was not.
  const isFirstRun =
    view.summary.plannedIncomeCents === 0 &&
    view.summary.allocatedCents === 0 &&
    view.summary.plannedFundCents === 0;

  const prior = previousMonth(year, month);
  const priorMonthLabel = monthLabel(prior.year, prior.month);
  const priorMonthHasAllocations = hasAnyAllocations(db, prior.year, prior.month);

  return (
    <main className="mx-auto max-w-5xl space-y-7 p-5 [font-variant-numeric:tabular-nums]">
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
        fundRows={view.fundRows}
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

      {/* Eng review Issue 4 + design review (2026-09-05): hidden on
          first-run so it never stacks with FirstRunCard's onboarding above,
          and placed after the hero/bands (not before) so a top-to-bottom
          scan hits the real budget numbers first.

          D3=C moved the FUNDS band into `<MonthEditor>` (it needs live
          editor state now that it is editable), which is what finally makes
          "after the bands" literally true — this panel used to sit BETWEEN
          Expenses and Funds. */}
      {!isFirstRun ? <BudgetHelpPanel /> : null}
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
/**
 * DS27 — every term of the headline must be derivable from something on
 * screen. `leftToBudgetCents` is `plannedIncome − allocated − plannedFund`,
 * and this strip listed only the first two: edit a fund, watch Left to
 * budget drop, and nothing above it accounts for the difference. That was
 * unreachable while the FUNDS band was read-only and the ledger had no funds
 * (`plannedFundCents` was always 0), and D3=C made it reachable — so the
 * third term joins the strip the moment a fund exists.
 *
 * Gated on `fundCount`, matching A6: no funds, no cell. An always-present
 * `$0.00` funding stat on the ~100% of months with no savings goals is the
 * inert row A6 exists to prevent.
 *
 * Like every other cell here it is server-rendered and lags live edits until
 * the next revalidation — the same deliberate staleness `Planned spending`
 * already has, not a new inconsistency.
 */
function summaryStripCells(summary: MonthViewSummary): SummaryStripCell[] {
  return [
    { label: "Planned income", cents: summary.plannedIncomeCents },
    { label: "Received", cents: summary.receivedIncomeCents },
    { label: "Planned spending", cents: summary.allocatedCents },
    { label: "Spent", cents: summary.spentCents },
    ...(summary.fundCount > 0
      ? [{ label: "Planned funding", cents: summary.plannedFundCents } satisfies SummaryStripCell]
      : []),
    {
      label: "Remaining",
      cents: summary.remainingCents,
      tone: summary.remainingCents < 0 ? "neg" : summary.remainingCents === 0 ? "zero" : "pos",
    },
  ];
}

