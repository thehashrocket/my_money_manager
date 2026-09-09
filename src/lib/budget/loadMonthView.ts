import { and, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import {
  computeEffectiveAllocationsForRollover,
  periodKey,
  spendIgnoresPositiveRows,
  type RolloverPeriod,
} from "@/lib/budget";
import { monthBoundary, nextMonthOf } from "@/lib/budget/monthOfIso";
import {
  assignableKinds,
  kindLockReason,
  loadCategoryKindUsage,
  NO_USAGE,
  type CategoryKind,
} from "@/lib/budget/categoryKindLock";
import { loadUncategorizedBacklog, type UncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";

// Re-exported so existing importers (app/page.tsx, BacklogBanner, the
// categorize/transactions client islands) don't need touching just because
// this type's home moved (E5) — they still import it from here.
export type { UncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";

type Db = typeof defaultDb;

export type LeafAllocation = {
  allocatedCents: number;
  rolloverCents: number;
  effectiveCents: number;
};

export type LeafRow = {
  categoryId: number;
  name: string;
  parentId: number | null;
  carryoverPolicy: "none" | "rollover" | "reset";
  /** `null` when no `budget_periods` row exists for this leaf + month. */
  allocation: LeafAllocation | null;
  /** MTD spent in positive cents (includes pending, excludes transfer pairs). */
  spentCents: number;
  /** Subset of `spentCents` that comes from pending transactions. */
  pendingCents: number;
  /** `effectiveCents - spentCents`, or `-spentCents` when no allocation. */
  remainingCents: number;
  isOverspent: boolean;
  /**
   * Which kinds `setCategoryKind` will still accept for this category (rule 8
   * + X1), computed server-side by the SAME function the writer enforces.
   * `CategoryMenu` renders only these, so it can never offer a change that is
   * a guaranteed refusal — the DS32 shape the FUNDS band made reachable the
   * moment a fund could acquire a `budget_periods` row.
   */
  assignableKinds: CategoryKind[];
  /** Why the kind is locked, or null when it is not. See `kindLockReason`. */
  kindLockReason: string | null;
};

/** A `kind='income'` leaf's row on the INCOME band (A1). */
export type IncomeLeafRow = {
  categoryId: number;
  name: string;
  parentId: number | null;
  /** `budget_periods.allocated_cents`, 0 when no row for this month. */
  plannedCents: number;
  /** `computeMtdReceived` — pending EXCLUDED (TS2). */
  receivedCents: number;
  /** `received - planned`; negative means short. */
  varianceCents: number;
  /** Pending-only subset of this month's rows (DS33's `+p` badge / coverage check). */
  pendingCents: number;
  /** Whether a `budget_periods` row exists for this leaf this month (DS14). */
  hasAllocation: boolean;
  /**
   * Which kinds `setCategoryKind` will still accept for this category (rule 8
   * + X1), computed server-side by the SAME function the writer enforces.
   * `CategoryMenu` renders only these, so it can never offer a change that is
   * a guaranteed refusal — the DS32 shape the FUNDS band made reachable the
   * moment a fund could acquire a `budget_periods` row.
   */
  assignableKinds: CategoryKind[];
  /** Why the kind is locked, or null when it is not. See `kindLockReason`. */
  kindLockReason: string | null;
};

/**
 * A `kind='fund'` category's row on the FUNDS band (A6).
 *
 * EDITABLE as of D3=C (2026-09-08) — DS19 made this band read-only and sent
 * contributions to `/goals`, but `/goals` only ever grew `createGoalAction`
 * and `updateGoalTargetAction`, neither of which writes `budget_periods`. So
 * a fund could be created and never funded, and `loadGoals`' `progressCents`
 * (`allocated − withdrawn`) was pinned at `0 − withdrawn` for the life of the
 * app. `budget_periods` is keyed `(category_id, year, month)`, so a
 * contribution is inherently a per-MONTH number, and
 * `leftToBudgetCents = plannedIncome − allocated − plannedFund` means it is
 * also a Left-to-Budget decision — both of which only exist on this page.
 * `/goals` keeps targets and long-horizon progress and reads the same
 * `budget_periods` rows, so the two surfaces cannot disagree.
 */
export type FundRow = {
  categoryId: number;
  name: string;
  /** `budget_periods.allocated_cents`, never the rollover-inflated effective
   *  figure (D3A) — same rule as `leftToBudgetCents` below. */
  plannedCents: number;
  /**
   * Whether a `budget_periods` row exists for this fund this month (DS14,
   * mirroring `IncomeLeafRow`).
   *
   * The null-vs-zero distinction it names is real — `CurrencyInput` renders
   * `null` as an empty field and `0` as `$0.00`, and "I have not decided yet"
   * is a different statement from "I decided zero" on a page whose whole model
   * is that every dollar gets a job — but on THIS row it is carried by
   * `allocation`, not by this flag: both fund row components branch on
   * `getAllocation(...) !== null`. Kept for parity with `IncomeLeafRow`, whose
   * copy IS read (that band has no `allocation` field), and because
   * `loadMonthView.test.ts` pins it as the one assertion that cannot be
   * re-derived from `plannedCents`.
   *
   * It said "load-bearing" until v0.23.0's review, which is the opposite of
   * true and would have sent the next reader looking for a `CurrencyInput`
   * call site that does not exist.
   */
  hasAllocation: boolean;
  /** Drives the `Rollover` chip and the row's `CategoryMenu`, exactly as
   *  `LeafRow.carryoverPolicy` does for an expense leaf. Before the band was
   *  editable a fund's policy was settable ONLY at creation time on `/goals`. */
  carryoverPolicy: "none" | "rollover" | "reset";
  /**
   * `categories.target_cents`. NULL means "no target recorded", which is NOT
   * the same fact as `0` — a fund created inline from this page has no target
   * until one is set on `/goals`, and rendering that as `$0.00` would claim
   * the fund is already complete.
   */
  targetCents: number | null;
  /**
   * The same `{allocated, rollover, effective}` triple `LeafRow` carries, or
   * `null` when this month has no `budget_periods` row. Seeds the client's
   * allocation map, so a rollover fund's carried balance is on screen at
   * first paint rather than appearing after the first commit.
   */
  allocation: LeafAllocation | null;
  /**
   * SUM(`budget_periods.allocated_cents`) across EVERY month for this fund,
   * this month included.
   *
   * This is deliberately NOT `loadGoals`' `progressCents`. That figure is
   * `allocated − withdrawn`, and what `withdrawn` should mean is an open
   * question this repo has explicitly parked (a net figure would let a
   * deposit into a fund increase progress on top of the allocation already
   * counting the same intention). `allocated` alone carries no such dispute:
   * it is the sum of what the user typed, which is exactly the quantity the
   * cell beside it is editing. `/goals` already frames its own number this
   * way ("$X planned of $Y", and its card says progress tracking is paused
   * because the app cannot confirm money moved), so this row says "planned"
   * too rather than inventing a progress claim the app declines to make.
   */
  plannedToDateCents: number;
  /**
   * Which kinds `setCategoryKind` will still accept for this category (rule 8
   * + X1), computed server-side by the SAME function the writer enforces.
   * `CategoryMenu` renders only these, so it can never offer a change that is
   * a guaranteed refusal — the DS32 shape the FUNDS band made reachable the
   * moment a fund could acquire a `budget_periods` row.
   */
  assignableKinds: CategoryKind[];
  /** Why the kind is locked, or null when it is not. See `kindLockReason`. */
  kindLockReason: string | null;
};

/*
 * A FUND ROW HAS NO SPEND FIELD, AND THAT IS DELIBERATE — but it has one
 * visible consequence worth knowing before you treat it as a bug.
 *
 * `FundRow` carries no `spentCents`/`remainingCents`, and `plannedToDateCents`
 * is allocated-only by design (see its own note above). Fund spend is still
 * real, though: `buildRuleMatcher` refuses only POSITIVE rows on a fund
 * (`rules.ts` — a positive row poisons the category), so a NEGATIVE row can
 * auto-file into one at import, and the clamped prefix scan then subtracts it
 * from next month's carried balance.
 *
 * So a fund's `+$X rollover → $Y` caption can shrink between months with no
 * spend figure anywhere on the band to account for it. `spendIgnoresPositiveRows`
 * makes fund spend ONE-DIRECTIONAL; it does not make it visible. The row name
 * links to the transaction list, which is where the explanation actually lives.
 */

/**
 * The `Uncategorized` category's own row (X5). Not a leaf in `sections` — the
 * renderer never has to special-case a row out of a list it is mapping over.
 * `null` when DS26's condition to show it doesn't hold: no month spend and no
 * month-scoped backlog to explain.
 */
export type UncategorizedRow = {
  categoryId: number;
  name: string;
  spentCents: number;
};

/**
 * D6A: bucketing (parent grouping, unparented rows first, named parents by
 * the parent's `sort_order` then name) is identical for expense and income
 * rows and gets one implementation via this generic. Within-bucket sorting
 * is NOT identical — expense rows by `sort_order` (DS29), income rows by
 * planned amount DESC — so it stays a parameter (`compare`) rather than a
 * `kind` flag hidden inside the function.
 */
export type SectionGroup<T = LeafRow> = {
  /** `null` for the unparented bucket. A1: this never renders an "Ungrouped" header. */
  parentId: number | null;
  parentName: string | null;
  categories: T[];
};

export type MonthViewSummary = {
  /** Expense-kind only, excludes `Uncategorized` (X5). */
  allocatedCents: number;
  effectiveCents: number;
  spentCents: number;
  remainingCents: number;
  plannedIncomeCents: number;
  receivedIncomeCents: number;
  plannedFundCents: number;
  /** `plannedIncome - allocated - plannedFund` (D3A). Uses `allocated_cents`,
   * never the rollover-inflated EFFECTIVE figure — rollover money was already
   * budgeted in a prior month, so counting it again would manufacture
   * capacity. (It said "never `effective_allocation_cents`" until migration
   * 0021 removed that column; the rule is about the effective FIGURE, which
   * `allocation.effectiveCents` still carries, not about where it was stored.) */
  leftToBudgetCents: number;
  /** A6: the FUNDS band renders only when this is > 0. */
  fundCount: number;
};

export type MonthView = {
  year: number;
  month: number;
  sections: SectionGroup<LeafRow>[];
  incomeSections: SectionGroup<IncomeLeafRow>[];
  fundRows: FundRow[];
  uncategorizedRow: UncategorizedRow | null;
  summary: MonthViewSummary;
  uncategorizedBacklog: UncategorizedBacklog;
};

/**
 * Assemble the read model for `/budget/[year]/[month]`.
 *
 * Structure (A1, E9): two independent axes, easy to conflate because both
 * ultimately come from the same `categories` table.
 *
 *   BAND       ← categories.kind ('income' | 'expense' | 'fund')
 *     │          Decides which top-level field a category's row lands on:
 *     │          incomeSections | sections | fundRows. Never rendered as
 *     │          a group header — it is the SHAPE of MonthView itself.
 *     │
 *     └── GROUP ← categories.parent_id, WITHIN one band only
 *           │      A `SectionGroup.parentName`. Two categories in
 *           │      different bands are never compared for grouping even
 *           │      if one happens to reference the other's id (doesn't
 *           │      happen today, but nothing stops it schema-wise).
 *           │
 *           └── LEAF ← any category that is not itself a parent_id target
 *                        The row a user actually allocates against
 *                        (LeafRow | IncomeLeafRow | FundRow). A GROUP
 *                        never carries an allocation.
 *
 * `Uncategorized` fits neither GROUP nor LEAF cleanly — it is `kind`
 * `'expense'` but excluded from `sections` and returned as its own field
 * instead (X5); DS26 makes it conditional (see `UncategorizedRow`'s
 * docstring). An unparented category within a band renders directly under
 * that band; there is no synthetic "Ungrouped" GROUP header.
 *
 * Every read here is read-only (TS1 deleted `getEffectiveAllocation`'s
 * `persist` option), so this function is safe to call from a Server
 * Component render path: no writes during prefetch, no double-fire hazard
 * (review decision 7 / T2A).
 *
 * Sorting: within an expense section, leaves sort by `sort_order ASC, name
 * ASC` (DS29 — replaces B4's `spentCents DESC`, which reshuffled rows as you
 * spend). Expense sections themselves sort by the parent's `sort_order ASC,
 * name ASC` (DS12/DS29). Income rows sort by planned amount DESC. The
 * unparented bucket, if non-empty, always renders first within its band.
 */
export function loadMonthView(db: Db, year: number, month: number): MonthView {
  const categories = db.select().from(schema.categories).all();

  const parentIds = new Set<number>();
  for (const c of categories) {
    if (c.parentId !== null) parentIds.add(c.parentId);
  }

  const parentInfoById = new Map<number, { name: string; sortOrder: number }>();
  const sortOrderByCategoryId = new Map<number, number>();
  for (const c of categories) {
    sortOrderByCategoryId.set(c.id, c.sortOrder);
    if (parentIds.has(c.id)) {
      parentInfoById.set(c.id, { name: c.name, sortOrder: c.sortOrder });
    }
  }

  const uncategorizedCategory = categories.find((c) => c.name === "Uncategorized");
  const uncategorizedId = uncategorizedCategory?.id;
  const expenseLeavesAll = categories.filter(
    (c) => c.kind === "expense" && !parentIds.has(c.id) && c.id !== uncategorizedId,
  );
  const incomeLeavesAll = categories.filter(
    (c) => c.kind === "income" && !parentIds.has(c.id) && c.id !== uncategorizedId,
  );
  const fundLeavesAll = categories.filter(
    (c) => c.kind === "fund" && !parentIds.has(c.id) && c.id !== uncategorizedId,
  );

  // T8/T11: bounded set of queries for the whole month, not 2 per leaf plus
  // unbounded backward recursion. #1 categories (above), #2 this month's
  // budget_periods (all kinds — expense/income/fund/Uncategorized all read
  // allocated_cents from the same rows), #3 this month's transaction sums
  // (E13: total + pending in one pass), #4/#5 the rollover range — only
  // when a rollover expense OR FUND category exists (funds joined that set
  // in v0.23.0, when the band became editable) — and #6 per-fund
  // planned-to-date, only when a fund exists at all.
  const { allocatedByCategoryId, hasPeriodRow } = loadAllocationsForMonth(db, year, month);
  const { totalByCategoryId, pendingTotalByCategoryId } = loadSpendForMonth(db, year, month);

  // X3/§7.2: an archived category is hidden from a month where it has
  // neither an allocation nor any spend — but stays visible in a historical
  // month that has one or the other, so archiving never erases a past
  // month's numbers. `allocatedByCategoryId`/`totalByCategoryId` are this
  // exact month's activity, already computed above for every category
  // regardless of archive status, so this is a filter over existing maps,
  // not a new query.
  //
  // "Has an allocation" means NONZERO here — the same bar `archiveCategory`
  // (F4) uses to decide whether archiving is even allowed. A `budget_periods`
  // row can exist with `allocated_cents = 0` (an explicit "$0 planned," not
  // "nothing planned" — DS14's placeholder-vs-zero distinction), and that is
  // routinely how a category BECOMES archivable in the first place (F4 says
  // "zero out that allocation first"). Using `hasPeriodRow` (any row, even a
  // $0 one) here would mean the row you just zeroed out specifically so you
  // could archive it stays visible anyway, immediately after archiving —
  // contradicting "archived categories are hidden."
  const hadActivityThisMonth = (categoryId: number) =>
    (allocatedByCategoryId.get(categoryId) ?? 0) !== 0 || totalByCategoryId.has(categoryId);
  const notHiddenByArchive = <T extends { id: number; archivedAt: Date | null }>(c: T) =>
    c.archivedAt === null || hadActivityThisMonth(c.id);
  const expenseLeaves = expenseLeavesAll.filter(notHiddenByArchive);
  const incomeLeaves = incomeLeavesAll.filter(notHiddenByArchive);
  const fundLeaves = fundLeavesAll.filter(notHiddenByArchive);

  // FUND leaves join this list as of the D3=C design review. They were
  // excluded while the band was read-only, which was harmless then and a
  // real defect once it was editable: `FundRow` carried no rollover figure,
  // the client seeded `rolloverCents: 0`, and `AllocationCell` renders its
  // "+$X rollover" caption only on a non-zero value — so a fund with a
  // carried balance showed NOTHING on load, and the caption then appeared
  // the instant the user committed any value, because `upsertAllocation` →
  // `getEffectiveAllocation` returns the real triple and `commit()` merges
  // it. Money materializing after an unrelated keystroke is the worst
  // surprise available on a savings surface. Rollover is a first-class
  // choice for a fund (`/goals`' create form offers it), so this is not an
  // edge case.
  const rolloverCategoryIds = [...expenseLeaves, ...fundLeaves]
    .filter((c) => c.carryoverPolicy === "rollover")
    .map((c) => c.id);
  // Same DECISION as `getEffectiveAllocation`'s scalar read, through the same
  // predicate — the two spellings cannot share the SQL (grouped aggregate vs
  // single row) and they drifted apart the one release they were allowed to
  // derive it independently. See `spendIgnoresPositiveRows`.
  const rolloverFundCategoryIds = fundLeaves
    .filter((c) => c.carryoverPolicy === "rollover" && spendIgnoresPositiveRows(c.kind))
    .map((c) => c.id);
  const effectiveByCategoryId =
    rolloverCategoryIds.length > 0
      ? loadRolloverEffectiveByCategory(db, rolloverCategoryIds, rolloverFundCategoryIds, year, month)
      : new Map<number, Map<string, number>>();

  const targetKey = periodKey(year, month);

  // Query #7 — rule 8's "which kinds may this category still become?", for
  // every leaf the page renders a `CategoryMenu` on. Read here rather than
  // derived in the client because the answer depends on the WHOLE ledger (any
  // transaction, any month's `budget_periods` row), not on this month's view;
  // `hasAllocation` is a this-month fact and is NOT a substitute for it.
  // Without it the menu offered kind changes `setCategoryKind` always refuses
  // — reachable on any fund the moment the FUNDS band wrote it a row (DS32).
  const menuLeafIds = [...expenseLeaves, ...incomeLeaves, ...fundLeaves].map((c) => c.id);
  const kindUsageByCategoryId = loadCategoryKindUsage(db, menuLeafIds);
  // The band a leaf sits in IS its kind — `expenseLeaves` is the `kind='expense'`
  // partition — so the current kind is passed in rather than re-selected.
  const assignableKindsFor = (categoryId: number, kind: "income" | "expense" | "fund") =>
    assignableKinds(kind, kindUsageByCategoryId.get(categoryId) ?? NO_USAGE);
  const kindLockReasonFor = (categoryId: number) =>
    kindLockReason(kindUsageByCategoryId.get(categoryId) ?? NO_USAGE);

  /**
   * The `{allocated, rollover, effective}` triple for one leaf, or `null` when
   * this month has no `budget_periods` row for it.
   *
   * ONE spelling, called by both `leafRows` and `fundRows`. The two ran
   * verbatim-identical copies until v0.23.0's review, with only the fund copy
   * carrying a comment saying so — which is how the pair drifts: the expense
   * site had no idea it had a twin. `rolloverCents` is the DERIVED member
   * (`effective − allocated`), so it cannot disagree with the other two.
   */
  const allocationFor = (leaf: {
    id: number;
    carryoverPolicy: "none" | "rollover" | "reset";
  }): LeafAllocation | null => {
    if (!hasPeriodRow.has(leaf.id)) return null;
    const allocatedCents = allocatedByCategoryId.get(leaf.id) ?? 0;
    const effectiveCents =
      leaf.carryoverPolicy === "rollover"
        ? (effectiveByCategoryId.get(leaf.id)?.get(targetKey) ?? allocatedCents)
        : allocatedCents;
    return {
      allocatedCents,
      rolloverCents: effectiveCents - allocatedCents,
      effectiveCents,
    };
  };

  const leafRows: LeafRow[] = expenseLeaves.map((leaf) => {
    const allocation = allocationFor(leaf);

    const spentCents = 0 - (totalByCategoryId.get(leaf.id) ?? 0);
    const pendingCents = 0 - (pendingTotalByCategoryId.get(leaf.id) ?? 0);
    const effective = allocation?.effectiveCents ?? 0;
    const remainingCents = effective - spentCents;
    return {
      categoryId: leaf.id,
      name: leaf.name,
      parentId: leaf.parentId,
      carryoverPolicy: leaf.carryoverPolicy,
      allocation,
      spentCents,
      pendingCents,
      remainingCents,
      isOverspent: remainingCents < 0,
      assignableKinds: assignableKindsFor(leaf.id, "expense"),
      kindLockReason: kindLockReasonFor(leaf.id),
    };
  });

  const incomeRows: IncomeLeafRow[] = incomeLeaves.map((leaf) => {
    const plannedCents = allocatedByCategoryId.get(leaf.id) ?? 0;
    const pendingCents = pendingTotalByCategoryId.get(leaf.id) ?? 0;
    // TS2: pending EXCLUDED, sum NOT negated (computeMtdReceived's convention).
    const receivedCents = (totalByCategoryId.get(leaf.id) ?? 0) - pendingCents;
    return {
      categoryId: leaf.id,
      name: leaf.name,
      parentId: leaf.parentId,
      plannedCents,
      receivedCents,
      varianceCents: receivedCents - plannedCents,
      pendingCents,
      hasAllocation: hasPeriodRow.has(leaf.id),
      assignableKinds: assignableKindsFor(leaf.id, "income"),
      kindLockReason: kindLockReasonFor(leaf.id),
    };
  });

  // Query #6, funds only and skipped entirely when there are none — same
  // shape as the rollover-range queries, which only run when a rollover
  // expense or fund category exists. Bounded at the month being viewed; see
  // the function for why that bound is load-bearing.
  const plannedToDateByFundId = loadFundPlannedToDate(
    db,
    fundLeaves.map((f) => f.id),
    year,
    month,
  );

  const fundRows: FundRow[] = fundLeaves
    .map((leaf) => ({
      categoryId: leaf.id,
      name: leaf.name,
      plannedCents: allocatedByCategoryId.get(leaf.id) ?? 0,
      hasAllocation: hasPeriodRow.has(leaf.id),
      allocation: allocationFor(leaf),
      carryoverPolicy: leaf.carryoverPolicy,
      targetCents: leaf.targetCents,
      plannedToDateCents: plannedToDateByFundId.get(leaf.id) ?? 0,
      assignableKinds: assignableKindsFor(leaf.id, "fund"),
      kindLockReason: kindLockReasonFor(leaf.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const uncategorizedBacklog = loadUncategorizedBacklog(db, { year, month });
  let uncategorizedRow: UncategorizedRow | null = null;
  if (uncategorizedCategory) {
    const spentCents = 0 - (totalByCategoryId.get(uncategorizedCategory.id) ?? 0);
    if (spentCents !== 0 || uncategorizedBacklog.count > 0) {
      uncategorizedRow = {
        categoryId: uncategorizedCategory.id,
        name: uncategorizedCategory.name,
        spentCents,
      };
    }
  }

  const expenseCompare = (a: LeafRow, b: LeafRow) => {
    const diff =
      (sortOrderByCategoryId.get(a.categoryId) ?? 0) - (sortOrderByCategoryId.get(b.categoryId) ?? 0);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  };
  const incomeCompare = (a: IncomeLeafRow, b: IncomeLeafRow) => {
    const diff = b.plannedCents - a.plannedCents;
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  };

  const sections = groupIntoSections(leafRows, parentInfoById, expenseCompare);
  const incomeSections = groupIntoSections(incomeRows, parentInfoById, incomeCompare);
  const summary = summarize(leafRows, incomeRows, fundRows);

  return {
    year,
    month,
    sections,
    incomeSections,
    fundRows,
    uncategorizedRow,
    summary,
    uncategorizedBacklog,
  };
}

/** Query #2: every category's `budget_periods` row for exactly this month. */
function loadAllocationsForMonth(
  db: Db,
  year: number,
  month: number,
): { allocatedByCategoryId: Map<number, number>; hasPeriodRow: Set<number> } {
  const rows = db
    .select({
      categoryId: schema.budgetPeriods.categoryId,
      allocatedCents: schema.budgetPeriods.allocatedCents,
    })
    .from(schema.budgetPeriods)
    .where(and(eq(schema.budgetPeriods.year, year), eq(schema.budgetPeriods.month, month)))
    .all();

  const allocatedByCategoryId = new Map<number, number>();
  const hasPeriodRow = new Set<number>();
  for (const row of rows) {
    allocatedByCategoryId.set(row.categoryId, row.allocatedCents);
    hasPeriodRow.add(row.categoryId);
  }
  return { allocatedByCategoryId, hasPeriodRow };
}

/**
 * Query #6: cumulative `allocated_cents` per FUND, from the fund's first month
 * through the month being VIEWED — inclusive at both ends.
 *
 * No LOWER bound on purpose: "planned to date" means since the fund existed,
 * not since some window.
 *
 * The UPPER bound is `(year, month)` and is not optional. Without it the figure
 * was month-INVARIANT — the same total on every month you navigated to — because
 * `/budget/[year]/[month]` is editable for future months and nothing gates a
 * commit on `phase`. Allocate next month, navigate back, and the earlier month
 * reported money that had not been planned yet; worse, `fundTargetGap` reads
 * this, so a past month could render a green **Funded** for a target reached
 * later. A column labelled "to date" that counts the future is the
 * plausible-but-wrong shape this repo is organised against, and the label was
 * the honest half of the disagreement.
 *
 * The comparison is `(year, month) <= (viewYear, viewMonth)` written out as
 * `year < Y OR (year = Y AND month <= M)` rather than on a composed integer:
 * `budget_periods` stores year and month as separate columns, and an index on
 * them is usable by this form.
 *
 * Scoped to the fund ids rather than grouping the whole table, and skipped
 * altogether when there are no funds (the common case: the live ledger has
 * none), so an app with no savings goals pays nothing for this.
 */
function loadFundPlannedToDate(
  db: Db,
  fundIds: number[],
  year: number,
  month: number,
): Map<number, number> {
  const byId = new Map<number, number>();
  if (fundIds.length === 0) return byId;

  const rows = db
    .select({
      categoryId: schema.budgetPeriods.categoryId,
      plannedToDate: sql<number>`COALESCE(SUM(${schema.budgetPeriods.allocatedCents}), 0)`,
    })
    .from(schema.budgetPeriods)
    .where(
      and(
        inArray(schema.budgetPeriods.categoryId, fundIds),
        or(
          lt(schema.budgetPeriods.year, year),
          and(
            eq(schema.budgetPeriods.year, year),
            lte(schema.budgetPeriods.month, month),
          ),
        ),
      ),
    )
    .groupBy(schema.budgetPeriods.categoryId)
    .all();

  for (const row of rows) byId.set(row.categoryId, row.plannedToDate);
  return byId;
}

/**
 * Query #3 (E13): every category's transaction sum for exactly this month,
 * in one pass — `total` (pending included, the spend/received convention)
 * and `pendingTotal` (the subset from pending rows). Folds in what used to
 * be a separate `loadPendingByCategory` query: `received` (TS2) is then
 * `total - pendingTotal` over the SAME snapshot, not a second read.
 */
function loadSpendForMonth(
  db: Db,
  year: number,
  month: number,
): { totalByCategoryId: Map<number, number>; pendingTotalByCategoryId: Map<number, number> } {
  const firstDay = monthBoundary(year, month);
  const { year: nextYear, month: nextMonth } = nextMonthOf(year, month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);

  const rows = db
    .select({
      categoryId: schema.transactions.categoryId,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
      pendingTotal: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.isPending} THEN ${schema.transactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.transferPairId),
        gte(schema.transactions.date, firstDay),
        sql`${schema.transactions.date} < ${firstDayNext}`,
      ),
    )
    .groupBy(schema.transactions.categoryId)
    .all();

  const totalByCategoryId = new Map<number, number>();
  const pendingTotalByCategoryId = new Map<number, number>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    totalByCategoryId.set(row.categoryId, row.total);
    pendingTotalByCategoryId.set(row.categoryId, row.pendingTotal);
  }
  return { totalByCategoryId, pendingTotalByCategoryId };
}

/**
 * Queries #4 + #5 (P1 + E4): the clamped prefix scan, set-based across every
 * rollover expense category at once instead of one backward recursion per
 * leaf. #4 is each category's ENTIRE `budget_periods` history through this
 * month (sparse — only months with a real row); #5 is their spend, GROUP BY
 * (category, year, month) via `strftime`, over the same span. Both queries
 * run once regardless of how many rollover categories exist.
 *
 * `fundCategoryIds` is the subset of `categoryIds` with `kind='fund'`, and it
 * exists to keep a POSITIVE row from manufacturing rollover. Spend here is
 * `0 - SUM(amount_cents)` — the signed convention rule 1 settled — so a
 * positive unpaired row (an interest credit, an unmatched savings deposit)
 * makes `spent` NEGATIVE, and `max(0, prevEffective - spent)` then carries a
 * balance LARGER than anything ever allocated. On an expense envelope that is
 * correct and deliberate: a refund restores buying capacity. On a fund it is
 * money appearing from nowhere.
 *
 * The app had already decided this everywhere else and this was the one place
 * that had not heard. `src/lib/rules.ts:80` refuses to auto-file a positive
 * row into a fund at import time — its comment says such a row "poisons" the
 * category — `assertAssignableCategory` refuses a fund outright on all three
 * categorize paths, and `loadGoals` keeps `withdrawn` outflows-only for
 * exactly this reason (rule 1's closing note). Funds only reached this code at
 * all in v0.23.0, when they joined `rolloverCategoryIds` for the first time.
 *
 * So: for a fund, positive rows contribute 0 rather than negative spend. It
 * has to happen in SQL, not after the GROUP BY — a month holding both a $50
 * credit and a $100 withdrawal nets to $50 of spend once summed, and no
 * clamp applied afterwards can recover the $100.
 */
function loadRolloverEffectiveByCategory(
  db: Db,
  categoryIds: number[],
  fundCategoryIds: number[],
  year: number,
  month: number,
): Map<number, Map<string, number>> {
  const { year: nextYear, month: nextMonth } = nextMonthOf(year, month);
  const firstDayNext = monthBoundary(nextYear, nextMonth);

  const periodRows = db
    .select({
      categoryId: schema.budgetPeriods.categoryId,
      year: schema.budgetPeriods.year,
      month: schema.budgetPeriods.month,
      allocatedCents: schema.budgetPeriods.allocatedCents,
    })
    .from(schema.budgetPeriods)
    .where(
      and(
        inArray(schema.budgetPeriods.categoryId, categoryIds),
        sql`(${schema.budgetPeriods.year} < ${year} OR (${schema.budgetPeriods.year} = ${year} AND ${schema.budgetPeriods.month} <= ${month}))`,
      ),
    )
    .all();

  const spendRows = db
    .select({
      categoryId: schema.transactions.categoryId,
      yr: sql<string>`strftime('%Y', ${schema.transactions.date})`,
      mo: sql<string>`strftime('%m', ${schema.transactions.date})`,
      total:
        fundCategoryIds.length > 0
          ? sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amountCents} > 0 AND ${inArray(schema.transactions.categoryId, fundCategoryIds)} THEN 0 ELSE ${schema.transactions.amountCents} END), 0)`
          : sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.categoryId, categoryIds),
        isNull(schema.transactions.transferPairId),
        sql`${schema.transactions.date} < ${firstDayNext}`,
      ),
    )
    .groupBy(
      schema.transactions.categoryId,
      sql`strftime('%Y', ${schema.transactions.date})`,
      sql`strftime('%m', ${schema.transactions.date})`,
    )
    .all();

  const periodsByCategory = new Map<number, RolloverPeriod[]>();
  for (const row of periodRows) {
    const list = periodsByCategory.get(row.categoryId) ?? [];
    list.push({ year: row.year, month: row.month, allocatedCents: row.allocatedCents });
    periodsByCategory.set(row.categoryId, list);
  }

  const spentByCategory = new Map<number, Map<string, number>>();
  for (const row of spendRows) {
    if (row.categoryId === null) continue;
    const map = spentByCategory.get(row.categoryId) ?? new Map<string, number>();
    map.set(periodKey(Number(row.yr), Number(row.mo)), 0 - row.total);
    spentByCategory.set(row.categoryId, map);
  }

  const effectiveByCategoryId = new Map<number, Map<string, number>>();
  for (const categoryId of categoryIds) {
    const periods = periodsByCategory.get(categoryId) ?? [];
    const spent = spentByCategory.get(categoryId) ?? new Map<string, number>();
    effectiveByCategoryId.set(categoryId, computeEffectiveAllocationsForRollover(periods, spent));
  }
  return effectiveByCategoryId;
}

export function groupIntoSections<T extends { parentId: number | null; name: string }>(
  rows: T[],
  parentInfoById: Map<number, { name: string; sortOrder: number }>,
  compare: (a: T, b: T) => number,
): SectionGroup<T>[] {
  const buckets = new Map<number | "ungrouped", T[]>();
  for (const row of rows) {
    const key = row.parentId ?? "ungrouped";
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }

  const sections: SectionGroup<T>[] = [];
  const ungrouped = buckets.get("ungrouped");
  if (ungrouped?.length) {
    sections.push({
      parentId: null,
      parentName: null,
      categories: [...ungrouped].sort(compare),
    });
  }

  // DS29/DS12: groups order by the parent's sort_order ASC, name ASC — not
  // alphabetically by name alone.
  const namedParents = [...buckets.entries()]
    .filter((entry): entry is [number, T[]] => entry[0] !== "ungrouped")
    .map(([parentId, rowsForParent]) => {
      const info = parentInfoById.get(parentId);
      return {
        parentId,
        parentName: info?.name ?? "",
        sortOrder: info?.sortOrder ?? 0,
        categories: [...rowsForParent].sort(compare),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.parentName.localeCompare(b.parentName));

  for (const group of namedParents) {
    sections.push({
      parentId: group.parentId,
      parentName: group.parentName,
      categories: group.categories,
    });
  }

  return sections;
}

function summarize(
  leaves: LeafRow[],
  incomeRows: IncomeLeafRow[],
  fundRows: FundRow[],
): MonthViewSummary {
  let allocatedCents = 0;
  let effectiveCents = 0;
  let spentCents = 0;
  for (const leaf of leaves) {
    allocatedCents += leaf.allocation?.allocatedCents ?? 0;
    effectiveCents += leaf.allocation?.effectiveCents ?? 0;
    spentCents += leaf.spentCents;
  }

  let plannedIncomeCents = 0;
  let receivedIncomeCents = 0;
  for (const income of incomeRows) {
    plannedIncomeCents += income.plannedCents;
    receivedIncomeCents += income.receivedCents;
  }

  let plannedFundCents = 0;
  for (const fund of fundRows) {
    plannedFundCents += fund.plannedCents;
  }

  return {
    allocatedCents,
    effectiveCents,
    spentCents,
    remainingCents: effectiveCents - spentCents,
    plannedIncomeCents,
    receivedIncomeCents,
    plannedFundCents,
    leftToBudgetCents: plannedIncomeCents - allocatedCents - plannedFundCents,
    fundCount: fundRows.length,
  };
}
