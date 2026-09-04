"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { EffectiveAllocation } from "@/lib/budget";
import type {
  IncomeLeafRow,
  LeafRow,
  SectionGroup,
  UncategorizedRow,
} from "@/lib/budget/loadMonthView";
import type { MonthPhase } from "@/lib/budget/monthOfIso";
import { resolveRowDisplay, type BarTone, type RowBadge, type RowTone } from "@/lib/budget/resolveRowDisplay";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { LeftToBudget } from "@/components/ledger/left-to-budget";
import { CurrencyInput, type CurrencyInputCommitResult } from "@/components/ledger/currency-input";
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
import { commitAllocationAction, revalidateBudgetSurfacesAction } from "../../actions";
import { BandSection } from "./_band-section";
import { CategoryMenu } from "./_category-menu";
import { NewCategoryRow, NewGroupRow } from "./_create-category";

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

/* ── T18/DS13 — client-owned state spanning the header and every row. A
   Left to Budget total that moves while you type across 40 rows needs one
   shared store; `useOptimistic` on individual row forms cannot do it,
   because each form only knows its own value.

     <MonthEditor>            "use client" — owns the month's allocation state
         ├── <LeftToBudget>      reads the running total from editor state
         ├── income <BandSection>  rows bind to editor state
         └── expense <BandSection> rows bind to editor state
                 └── each row: onBlur / Enter → commitAllocationAction
                               → action RETURNS the reconciled row (P2)
                               → client merges by categoryId
   ────────────────────────────────────────────────────────────────────── */

type EditorContextValue = {
  phase: MonthPhase;
  hydrated: boolean;
  getAllocation: (categoryId: number) => EffectiveAllocation | null;
  commit: (categoryId: number, cents: number) => Promise<CurrencyInputCommitResult>;
};

const EditorContext = createContext<EditorContextValue | null>(null);

function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside <MonthEditor>");
  return ctx;
}

function subscribeNever() {
  return () => {};
}

/** T24/DS17: flips true once this island is running on the client — before
 * that, amount inputs render genuinely `readOnly` so there is nothing for
 * hydration's reconciliation pass to silently overwrite ("swallow").
 * `useSyncExternalStore` with a snapshot that differs from the server
 * snapshot is the documented way to read "am I hydrated yet" without a
 * `useEffect` + `setState` pair, which trips `react-hooks/set-state-in-effect`
 * (same constraint T11's Left to Budget settle transition navigated by
 * using a pure CSS transition instead — this case has no CSS equivalent). */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type MonthEditorProps = {
  year: number;
  month: number;
  phase: MonthPhase;
  railTotalCents: number;
  /** A6/D3A: FUNDS stays read-only in PR2a — a fixed number from the
   * server, not tracked state, folded into `leftToBudgetCents` below. */
  plannedFundCents: number;
  incomeSections: SectionGroup<IncomeLeafRow>[];
  expenseSections: SectionGroup<LeafRow>[];
  uncategorizedRow: UncategorizedRow | null;
  /** DS31: the `no-income` state's CTA, built server-side (it needs
   * `AllocateFormTrigger`'s dialog and a real category id) and handed in as
   * already-built JSX — this client island has no business constructing it. */
  noIncomeCta?: React.ReactNode;
  /** Server-rendered, unaffected by live editor state (§6.1's diagram scopes
   * `<MonthEditor>` to the header's numeral, not the whole header) — plain
   * slots so this component owns layout without needing to read their data. */
  headerTop: React.ReactNode;
  summaryStrip: React.ReactNode;
  firstRunCard: React.ReactNode;
};

export function MonthEditor(props: MonthEditorProps) {
  const {
    year,
    month,
    phase,
    railTotalCents,
    plannedFundCents,
    incomeSections,
    expenseSections,
    uncategorizedRow,
    noIncomeCta,
    headerTop,
    summaryStrip,
    firstRunCard,
  } = props;

  const hydrated = useHydrated();

  function buildAllocations() {
    const map = new Map<number, EffectiveAllocation | null>();
    for (const section of incomeSections) {
      for (const income of section.categories) {
        map.set(
          income.categoryId,
          income.hasAllocation
            ? { allocatedCents: income.plannedCents, rolloverCents: 0, effectiveCents: income.plannedCents }
            : null,
        );
      }
    }
    for (const section of expenseSections) {
      for (const leaf of section.categories) {
        map.set(leaf.categoryId, leaf.allocation);
      }
    }
    return map;
  }

  const [allocations, setAllocations] = useState(buildAllocations);

  // "Adjust state during render" (React's documented pattern for resetting
  // derived state when a prop changes) — using state, not a ref, and not a
  // `useEffect`: `_category-menu.tsx`'s `wasOpen`-vs-`open` reset uses the
  // same shape, and both constraints are enforced here by lint
  // (`react-hooks/refs` forbids reading/writing a ref during render;
  // `react-hooks/set-state-in-effect` forbids calling `setState` from an
  // effect body).
  //
  // `incomeSections`/`expenseSections` are a NEW object graph only when the
  // server component actually re-executes (a navigation, or another action's
  // `revalidatePath` — e.g. `copyPreviousMonthAction`/`createCategoryAction`),
  // never merely because this client island re-rendered on its own — so this
  // only fires on a genuine fresh payload. Without it, `allocations` was
  // seeded once at mount and never resynced: "Copy previous month" would
  // toast success while every cell kept showing its pre-copy (usually blank)
  // value until the user navigated away and back. Safe to fully replace
  // rather than merge: this route has no caching layer (`ƒ Dynamic`, plain
  // SSR against the DB), so a fresh payload already reflects every
  // previously committed edit — and `CurrencyInput`'s own resync effect
  // already refuses to stomp a field the user is actively typing in.
  const [prevIncomeSections, setPrevIncomeSections] = useState(incomeSections);
  const [prevExpenseSections, setPrevExpenseSections] = useState(expenseSections);
  if (prevIncomeSections !== incomeSections || prevExpenseSections !== expenseSections) {
    setPrevIncomeSections(incomeSections);
    setPrevExpenseSections(expenseSections);
    setAllocations(buildAllocations());
  }

  const dirtyRef = useRef(false);

  const revalidate = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    void revalidateBudgetSurfacesAction(year, month);
  }, [year, month]);

  // P2: "revalidate once on exit" — covers client-side navigation to
  // another month (unmount); the wrapper's `onBlur` below covers focus
  // leaving the island without a navigation.
  useEffect(() => () => revalidate(), [revalidate]);

  const commit = useCallback(
    async (categoryId: number, cents: number): Promise<CurrencyInputCommitResult> => {
      // Set BEFORE the await, not after: the wrapper `<div onBlur>` below
      // fires `revalidate()` synchronously, in the same focusout dispatch
      // as `CurrencyInput`'s own `onBlur` — which starts this commit but
      // doesn't wait for it. Setting the flag only after
      // `commitAllocationAction` resolves meant a single edit followed by a
      // click elsewhere in the page (no route change, so the unmount
      // fallback below never fires either) checked `dirtyRef.current` while
      // it was still `false` from before this write started, silently
      // skipping the revalidate this exact write existed to trigger.
      dirtyRef.current = true;
      const result = await commitAllocationAction(categoryId, year, month, cents);
      if (result.status === "error") {
        return { ok: false, message: result.message };
      }
      setAllocations((prev) => {
        const next = new Map(prev);
        next.set(categoryId, result.allocation);
        return next;
      });
      return { ok: true };
    },
    [year, month],
  );

  const getAllocation = useCallback((categoryId: number) => allocations.get(categoryId) ?? null, [allocations]);

  const editorValue = useMemo<EditorContextValue>(
    () => ({ phase, hydrated, getAllocation, commit }),
    [phase, hydrated, getAllocation, commit],
  );

  // D6A/summary math mirrors `loadMonthView.ts`'s `summarize()` exactly:
  // `allocatedCents` sums the EXPLICIT `allocated_cents` per leaf, never
  // `effectiveCents` — rollover money was already budgeted in a prior
  // month, counting it again here would manufacture capacity.
  const { plannedIncomeCents, allocatedCents } = useMemo(() => {
    let planned = 0;
    for (const section of incomeSections) {
      for (const income of section.categories) {
        planned += allocations.get(income.categoryId)?.allocatedCents ?? 0;
      }
    }
    let allocated = 0;
    for (const section of expenseSections) {
      for (const leaf of section.categories) {
        allocated += allocations.get(leaf.categoryId)?.allocatedCents ?? 0;
      }
    }
    return { plannedIncomeCents: planned, allocatedCents: allocated };
  }, [allocations, incomeSections, expenseSections]);

  const leftToBudgetCents = plannedIncomeCents - allocatedCents - plannedFundCents;

  return (
    <EditorContext.Provider value={editorValue}>
      <div
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) revalidate();
        }}
      >
        <header className="space-y-4">
          {headerTop}
          <div className="sticky top-0 z-10 sm:static">
            <LeftToBudget
              plannedIncomeCents={plannedIncomeCents}
              allocatedCents={allocatedCents}
              plannedFundCents={plannedFundCents}
              leftToBudgetCents={leftToBudgetCents}
              phase={phase}
              railTotalCents={railTotalCents}
              noIncomeCta={noIncomeCta}
            />
          </div>
          {summaryStrip}
        </header>

        <CommitAnnouncement leftToBudgetCents={leftToBudgetCents} />

        {firstRunCard}

        <BandSection heading="Income" id="income-band">
          <IncomeTable sections={incomeSections} plannedIncomeCents={plannedIncomeCents} year={year} month={month} />
          <MobileIncomeList sections={incomeSections} year={year} month={month} />
        </BandSection>

        <BandSection heading="Expenses">
          <ExpenseTable
            sections={expenseSections}
            uncategorizedRow={uncategorizedRow}
            allocatedCents={allocatedCents}
            year={year}
            month={month}
          />
          <MobileExpenseList sections={expenseSections} uncategorizedRow={uncategorizedRow} year={year} month={month} />
          <NewGroupRow />
        </BandSection>
      </div>
    </EditorContext.Provider>
  );
}

/**
 * DS16 — "Left to Budget is NOT a live region while typing." The precedent
 * an implementer would copy (`_allocate-form.tsx`'s dialog field) puts
 * `aria-live="polite"` directly on a number that updates per keystroke; the
 * same treatment on a header watching 40 fields announces on every key
 * press. `leftToBudgetCents` only changes on a successful commit (the
 * allocations map above is never written mid-keystroke), so gating on it
 * is commit-only by construction — the debounce below is purely to
 * collapse a fast multi-row Tab-through into one sentence instead of one
 * announcement per row.
 */
function CommitAnnouncement({ leftToBudgetCents }: { leftToBudgetCents: number }) {
  const [announcement, setAnnouncement] = useState("");
  const isFirst = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isFirst.current) {
      // Never announce the value already on screen at hydration.
      isFirst.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setAnnouncement(
        leftToBudgetCents === 0 ? "Every dollar has a job." : `${formatCents(leftToBudgetCents)} left to budget.`,
      );
    }, 500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [leftToBudgetCents]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
}

/**
 * T28/DS23 — non-dismissible: a plain `<span>` with a `title`, not a
 * dismissible tooltip/toast component. It is a fact about this month's
 * data ("this looks like income"), not a warning to acknowledge once and
 * never see again — dismissing it would let the exact F1 Layer-2 shape
 * (a category that should be `kind='income'` but isn't) go quiet again.
 */
function LooksLikeIncomeHint({ categoryName }: { categoryName: string }) {
  return (
    <span
      title={`${categoryName} received more than it spent this month — this might actually be income.`}
      aria-label={`${categoryName} looks like income this month`}
      className="ml-1.5 inline-block cursor-help font-mono text-[10px] text-terracotta"
    >
      ⓘ
    </span>
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
  year,
  month,
}: {
  sections: SectionGroup<LeafRow>[];
  uncategorizedRow: UncategorizedRow | null;
  allocatedCents: number;
  year: number;
  month: number;
}) {
  // T29 "at both levels" — a group's siblings are the OTHER groups, so its
  // position for Move up/down comes from this band's own group order
  // (`sections` is already sorted that way), not from `sections`' raw index
  // (which also holds the unparented bucket, itself never a real category).
  const groupSections = sections.filter((s) => s.parentName !== null);
  const groupIndexByParentId = new Map(groupSections.map((g, i) => [g.parentId, i]));

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
        {sections.map((section) => {
          const groupIndex = groupIndexByParentId.get(section.parentId) ?? -1;
          return (
            <TableBody key={section.parentId ?? "unparented"}>
              {section.parentName && section.parentId !== null ? (
                <TableRow className="bg-[var(--bg-inset)] hover:bg-[var(--bg-inset)]">
                  <TableHead scope="rowgroup" colSpan={4} className="px-3 py-1.5 font-display text-sm font-normal text-ink-2">
                    {section.parentName}
                  </TableHead>
                  <TableCell className="px-3 py-1.5 text-right">
                    <CategoryMenu
                      categoryId={section.parentId}
                      categoryName={section.parentName}
                      kind="expense"
                      carryoverPolicy="none"
                      isGroup
                      canMoveUp={groupIndex > 0}
                      canMoveDown={groupIndex < groupSections.length - 1}
                    />
                  </TableCell>
                </TableRow>
              ) : null}
              {section.categories.map((leaf, i) => (
                <ExpenseDesktopRow
                  key={leaf.categoryId}
                  leaf={leaf}
                  year={year}
                  month={month}
                  canMoveUp={i > 0}
                  canMoveDown={i < section.categories.length - 1}
                />
              ))}
              <NewCategoryRow parentId={section.parentId} parentName={section.parentName} colSpan={5} />
            </TableBody>
          );
        })}
        {uncategorizedRow ? (
          <TableBody>
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
  year,
  month,
  canMoveUp,
  canMoveDown,
}: {
  leaf: LeafRow;
  year: number;
  month: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const { phase, hydrated, getAllocation, commit } = useEditor();
  const allocation = getAllocation(leaf.categoryId);
  const effective = allocation?.effectiveCents ?? 0;
  const display = resolveRowDisplay(
    {
      effectiveCents: effective,
      spentCents: leaf.spentCents,
      pendingCents: leaf.pendingCents,
      hasAllocation: allocation !== null,
    },
    "expense",
    phase,
  );
  return (
    <TableRow>
      <TableHead scope="row" className="px-3 py-2 font-normal">
        <Link
          href={`/transactions?categoryId=${leaf.categoryId}&year=${year}&month=${month}`}
          tabIndex={-1}
          className="font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {leaf.name}
        </Link>
        {leaf.carryoverPolicy === "rollover" ? (
          <span className="ml-2 rounded-xs bg-[var(--bg-inset)] px-1 font-mono text-[10px] uppercase tracking-wide text-ink-2">
            Rollover
          </span>
        ) : null}
        {display.looksLikeIncome ? <LooksLikeIncomeHint categoryName={leaf.name} /> : null}
      </TableHead>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        <AllocationCell categoryId={leaf.categoryId} name={leaf.name} allocation={allocation} commit={commit} hydrated={hydrated} />
      </TableCell>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        {formatCents(leaf.spentCents)}
        <RowBadges badges={display.badges} />
      </TableCell>
      <TableCell className="px-3 py-2 text-right">
        <div className="flex flex-col items-end gap-1">
          <span className={TONE_CLASS[display.tone]}>{formatCents(effective - leaf.spentCents)}</span>
          <Bar pct={display.barPct} tone={display.barTone} />
        </div>
      </TableCell>
      <TableCell className="px-3 py-2 text-right">
        <CategoryMenu
          categoryId={leaf.categoryId}
          categoryName={leaf.name}
          kind="expense"
          carryoverPolicy={leaf.carryoverPolicy}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
        />
      </TableCell>
    </TableRow>
  );
}

/**
 * The inline "Planned" cell edits and displays the EXPLICIT
 * `allocated_cents` — the same field the `⋯` dialog's "Explicit" row
 * edits — never the rollover-inclusive `effectiveCents` also shown
 * elsewhere in the row. Binding this input to `effectiveCents` instead
 * would be a real correctness bug for any rollover category: committing
 * the displayed effective total AS IF it were the explicit amount would
 * write it into `allocated_cents`, and next month's rollover math would
 * then add carried-forward money on top of a number that already included
 * it — compounding on every edit. When there IS a nonzero carried balance,
 * a small caption underneath names it, so nothing is hidden — just not
 * conflated with what this input commits.
 */
function AllocationCell({
  categoryId,
  name,
  allocation,
  commit,
  hydrated,
}: {
  categoryId: number;
  name: string;
  allocation: EffectiveAllocation | null;
  commit: (categoryId: number, cents: number) => Promise<CurrencyInputCommitResult>;
  hydrated: boolean;
}) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <CurrencyInput
        ariaLabel={`${name} planned amount`}
        committedCents={allocation?.allocatedCents ?? null}
        readOnly={!hydrated}
        categoryId={categoryId}
        onCommit={(cents) => commit(categoryId, cents)}
      />
      {allocation && allocation.rolloverCents !== 0 ? (
        <span className="text-[10px] text-ink-3">
          +{formatCents(allocation.rolloverCents)} rollover → {formatCents(allocation.effectiveCents)}
        </span>
      ) : null}
    </div>
  );
}

/* ── INCOME — desktop table ───────────────────────────────────────────── */

function IncomeTable({
  sections,
  plannedIncomeCents,
  year,
  month,
}: {
  sections: SectionGroup<IncomeLeafRow>[];
  plannedIncomeCents: number;
  year: number;
  month: number;
}) {
  return (
    <div className="hidden overflow-hidden rounded-lg shadow-soft sm:block">
      <Table className="border-collapse">
        <TableCaption className="sr-only">Income for {monthLabel(year, month)}</TableCaption>
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
              <IncomeDesktopRow key={income.categoryId} income={income} year={year} month={month} />
            ))}
            <NewCategoryRow parentId={section.parentId} parentName={section.parentName} kind="income" colSpan={5} />
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

function IncomeDesktopRow({ income, year, month }: { income: IncomeLeafRow; year: number; month: number }) {
  const { phase, hydrated, getAllocation, commit } = useEditor();
  const allocation = getAllocation(income.categoryId);
  const plannedCents = allocation?.allocatedCents ?? 0;
  const varianceCents = income.receivedCents - plannedCents;
  const display = resolveRowDisplay(
    {
      plannedCents,
      receivedCents: income.receivedCents,
      varianceCents,
      pendingCents: income.pendingCents,
      hasAllocation: allocation !== null,
    },
    "income",
    phase,
  );
  return (
    <TableRow>
      <TableHead scope="row" className="px-3 py-2 font-normal">
        <Link
          href={`/transactions?categoryId=${income.categoryId}&year=${year}&month=${month}`}
          tabIndex={-1}
          className="font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {income.name}
        </Link>
      </TableHead>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        <CurrencyInput
          ariaLabel={`${income.name} planned amount`}
          committedCents={allocation?.allocatedCents ?? null}
          readOnly={!hydrated}
          categoryId={income.categoryId}
          onCommit={(cents) => commit(income.categoryId, cents)}
        />
      </TableCell>
      <TableCell className="px-3 py-2 text-right text-ink-1">
        {formatCents(income.receivedCents)}
        <RowBadges badges={display.badges} />
      </TableCell>
      <TableCell className={cn("px-3 py-2 text-right", TONE_CLASS[display.tone])}>{formatCents(varianceCents)}</TableCell>
      <TableCell className="px-3 py-2 text-right">
        <CategoryMenu
          categoryId={income.categoryId}
          categoryName={income.name}
          kind="income"
          carryoverPolicy="none"
          // Income rows sort by planned amount, never `sort_order`
          // (`incomeCompare` in loadMonthView.ts) — reordering would swap a
          // column nothing here ever reads, so it's never offered.
          canMoveUp={false}
          canMoveDown={false}
        />
      </TableCell>
    </TableRow>
  );
}

/* ── DS43 — mobile ledger list. Compact rows under the same band/group
   headings as desktop, reading the same `resolveRowDisplay` decisions
   rather than a folded-flap `EnvelopeCard` per row. T22: the amount input
   binds to the same editor state as the desktop table. ──────────────── */

function MobileGroupHeading({ name, menu }: { name: string | null; menu?: React.ReactNode }) {
  if (!name) return null;
  return (
    <div className="flex items-center justify-between">
      <h3 className="font-display text-sm text-ink-2">{name}</h3>
      {menu}
    </div>
  );
}

function MobileExpenseList({
  sections,
  uncategorizedRow,
  year,
  month,
}: {
  sections: SectionGroup<LeafRow>[];
  uncategorizedRow: UncategorizedRow | null;
  year: number;
  month: number;
}) {
  const groupSections = sections.filter((s) => s.parentName !== null);
  const groupIndexByParentId = new Map(groupSections.map((g, i) => [g.parentId, i]));

  return (
    <div className="space-y-4 sm:hidden">
      {sections.map((section) => {
        const groupIndex = groupIndexByParentId.get(section.parentId) ?? -1;
        return (
          <div key={section.parentId ?? "unparented"} className="space-y-2">
            <MobileGroupHeading
              name={section.parentName}
              menu={
                section.parentName && section.parentId !== null ? (
                  <CategoryMenu
                    categoryId={section.parentId}
                    categoryName={section.parentName}
                    kind="expense"
                    carryoverPolicy="none"
                    isGroup
                    canMoveUp={groupIndex > 0}
                    canMoveDown={groupIndex < groupSections.length - 1}
                  />
                ) : null
              }
            />
            <ul className="divide-y divide-[var(--rule-faint)] overflow-hidden rounded-lg bg-[var(--bg-raised)] shadow-soft">
              {section.categories.map((leaf, i) => (
                <MobileExpenseRow
                  key={leaf.categoryId}
                  leaf={leaf}
                  year={year}
                  month={month}
                  canMoveUp={i > 0}
                  canMoveDown={i < section.categories.length - 1}
                />
              ))}
              <NewCategoryRow parentId={section.parentId} parentName={section.parentName} mobile />
            </ul>
          </div>
        );
      })}
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
  year,
  month,
  canMoveUp,
  canMoveDown,
}: {
  leaf: LeafRow;
  year: number;
  month: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const { phase, hydrated, getAllocation, commit } = useEditor();
  const allocation = getAllocation(leaf.categoryId);
  const effective = allocation?.effectiveCents ?? 0;
  const display = resolveRowDisplay(
    {
      effectiveCents: effective,
      spentCents: leaf.spentCents,
      pendingCents: leaf.pendingCents,
      hasAllocation: allocation !== null,
    },
    "expense",
    phase,
  );
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <Link
          href={`/transactions?categoryId=${leaf.categoryId}&year=${year}&month=${month}`}
          tabIndex={-1}
          className="min-w-0 truncate font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {leaf.name}
        </Link>
        <span className={cn("shrink-0 font-mono text-sm", TONE_CLASS[display.tone])}>
          {formatCents(effective - leaf.spentCents)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 font-mono text-xs text-ink-3">
          <span>{formatCents(leaf.spentCents)} spent</span>
          <RowBadges badges={display.badges} />
          {leaf.carryoverPolicy === "rollover" ? (
            <span className="rounded-xs bg-[var(--bg-inset)] px-1 uppercase tracking-wide">Rollover</span>
          ) : null}
          {display.looksLikeIncome ? <LooksLikeIncomeHint categoryName={leaf.name} /> : null}
        </div>
        <div className="w-16">
          <Bar pct={display.barPct} tone={display.barTone} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <AllocationCell categoryId={leaf.categoryId} name={leaf.name} allocation={allocation} commit={commit} hydrated={hydrated} />
        <CategoryMenu
          categoryId={leaf.categoryId}
          categoryName={leaf.name}
          kind="expense"
          carryoverPolicy={leaf.carryoverPolicy}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
        />
      </div>
    </li>
  );
}

function MobileIncomeList({
  sections,
  year,
  month,
}: {
  sections: SectionGroup<IncomeLeafRow>[];
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
              <MobileIncomeRow key={income.categoryId} income={income} year={year} month={month} />
            ))}
            <NewCategoryRow parentId={section.parentId} parentName={section.parentName} kind="income" mobile />
          </ul>
        </div>
      ))}
    </div>
  );
}

function MobileIncomeRow({ income, year, month }: { income: IncomeLeafRow; year: number; month: number }) {
  const { phase, hydrated, getAllocation, commit } = useEditor();
  const allocation = getAllocation(income.categoryId);
  const plannedCents = allocation?.allocatedCents ?? 0;
  const varianceCents = income.receivedCents - plannedCents;
  const display = resolveRowDisplay(
    {
      plannedCents,
      receivedCents: income.receivedCents,
      varianceCents,
      pendingCents: income.pendingCents,
      hasAllocation: allocation !== null,
    },
    "income",
    phase,
  );
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <Link
          href={`/transactions?categoryId=${income.categoryId}&year=${year}&month=${month}`}
          tabIndex={-1}
          className="min-w-0 truncate font-display text-ink-1 underline-offset-4 hover:underline"
        >
          {income.name}
        </Link>
        <span className={cn("shrink-0 font-mono text-sm", TONE_CLASS[display.tone])}>{formatCents(varianceCents)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1 font-mono text-xs text-ink-3">
        <span>{formatCents(income.receivedCents)} received</span>
        <RowBadges badges={display.badges} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <CurrencyInput
          ariaLabel={`${income.name} planned amount`}
          committedCents={allocation?.allocatedCents ?? null}
          readOnly={!hydrated}
          categoryId={income.categoryId}
          onCommit={(cents) => commit(income.categoryId, cents)}
        />
        <CategoryMenu
          categoryId={income.categoryId}
          categoryName={income.name}
          kind="income"
          carryoverPolicy="none"
          canMoveUp={false}
          canMoveDown={false}
        />
      </div>
    </li>
  );
}
