import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { listLeafCategories, type LeafCategory } from "@/lib/categories";
import { listAccounts, type AccountOption } from "@/lib/accounts/listAccounts";
import { loadUncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";
import { loadTransactions } from "@/lib/categorize/loadTransactions";
import { AmountParseError, centsToDollarString, parseAmountToCents } from "@/lib/money";
import { FilterBar, MAX_SEARCH_LENGTH, type TransactionsFilterValues } from "./_filter-bar";
import { TransactionsUi } from "./_transactions-ui";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/**
 * `/transactions` — filtered, paginated transaction list with inline
 * categorize. Entry points:
 * - `/budget` row link → `?categoryId=<leafId>&dateFrom=<first>&dateTo=<last>`
 *   for drilldown into one category's transactions for one month
 * - standalone → no filter, newest first
 * - `_filter-bar.tsx`'s GET form → any combination of search/account/
 *   category/date-range/amount-range/pending
 *
 * Invalid searchParams (non-int, out-of-range, calendar-invalid dates,
 * unparseable amounts) route through `notFound()` so URL tampering lands in
 * Next's 404 UI rather than a server error banner (matches
 * `/budget/[year]/[month]` behavior).
 *
 * Transfer-paired rows are excluded from the list server-side (see
 * `loadTransactions`); the categorize action additionally refuses them as a
 * defense-in-depth check.
 */
const amountSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return undefined;
    try {
      return Math.abs(parseAmountToCents(raw));
    } catch (err) {
      if (err instanceof AmountParseError) {
        ctx.addIssue({ code: "custom", message: "invalid amount" });
        return z.NEVER;
      }
      throw err;
    }
  });

const searchParamsSchema = z.object({
  categoryId: z
    .union([
      z.literal("none"),
      z.coerce.number().int().positive(),
    ])
    .optional(),
  accountId: z.coerce.number().int().positive().optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  amountMin: amountSchema,
  amountMax: amountSchema,
  pending: z.enum(["posted", "pending", "all"]).optional(),
  search: z
    .string()
    .max(MAX_SEARCH_LENGTH)
    .optional()
    .transform((v) => {
      const trimmed = v?.trim();
      return trimmed ? trimmed : undefined;
    }),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
}).strict();

type RawSearchParams = Record<string, string | string[] | undefined>;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await connection();
  const raw = await searchParams;
  const parsed = searchParamsSchema.safeParse(flatten(raw));
  if (!parsed.success) notFound();

  const { categoryId, accountId, dateFrom, dateTo, amountMin, amountMax, pending, search } =
    parsed.data;
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) notFound();
  if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) notFound();

  const isPending = pending === "posted" ? false : pending === "pending" ? true : undefined;

  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? DEFAULT_PAGE_SIZE;

  const { rows, totalCount } = loadTransactions(db, {
    categoryId,
    accountId,
    dateFrom,
    dateTo,
    amountMinCents: amountMin,
    amountMaxCents: amountMax,
    isPending,
    search,
    page,
    pageSize,
  });

  // X3/B7: the picker excludes archived categories (you can't re-file a
  // transaction into one), but a `?categoryId=` filter can point at a
  // category that's since been archived — e.g. a `/budget` row link
  // followed after the fact. Resolving the filter's own label needs the
  // archived category to still be findable, or the header silently drops
  // the name it's filtering by.
  const leafCategories = listLeafCategories(db);
  const allCategoriesForLabels = listLeafCategories(db, { includeArchived: true });
  const accounts = listAccounts(db);
  // E5: unscoped (all-time), matching this page's existing behavior — only
  // /budget's own banner is month-scoped (X4).
  const uncategorizedBacklog = loadUncategorizedBacklog(db);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const activeCategoryName = resolveActiveCategoryName(categoryId, allCategoriesForLabels);
  const activeAccountName = resolveActiveAccountName(accountId, accounts);

  const filterValues = {
    search,
    accountId,
    categoryId,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    pending,
  };

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6 [font-variant-numeric:tabular-nums]">
      <header className="space-y-2">
        <h1 className="font-display text-[var(--text-3xl)] leading-none tracking-[-0.015em]">
          Transactions
        </h1>
        <FilterSummary
          categoryName={activeCategoryName}
          categoryId={categoryId}
          accountName={activeAccountName}
          accountId={accountId}
          dateFrom={dateFrom}
          dateTo={dateTo}
          amountMinCents={amountMin}
          amountMaxCents={amountMax}
          pending={pending}
          search={search}
          totalCount={totalCount}
        />
      </header>

      <FilterBar values={filterValues} leafCategories={leafCategories} accounts={accounts} pageSize={pageSize} />

      <TransactionsUi
        rows={rows}
        leafCategories={leafCategories}
        initialBacklog={uncategorizedBacklog}
        page={page}
        pageSize={pageSize}
        totalCount={totalCount}
        totalPages={totalPages}
        searchParams={filterValues}
      />
    </main>
  );
}

/**
 * The filter bar is a plain GET form (D4) — every field name is present on
 * every submit, so an untouched input arrives as `key=""` rather than the
 * key being absent. Blank means "no filter" everywhere in this schema, so
 * `""` is normalized to `undefined` here rather than let a coerced field
 * (`z.coerce.number()`, `z.iso.date()`) reject it as invalid input.
 */
function flatten(raw: RawSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    const value = Array.isArray(v) ? v[0] : v;
    out[k] = value === "" ? undefined : value;
  }
  return out;
}

function resolveActiveCategoryName(
  categoryId: number | "none" | undefined,
  leaves: LeafCategory[],
): string | null {
  if (categoryId === undefined) return null;
  if (categoryId === "none") return "Uncategorized";
  return leaves.find((l) => l.id === categoryId)?.name ?? null;
}

function resolveActiveAccountName(
  accountId: number | undefined,
  accounts: AccountOption[],
): string | null {
  if (accountId === undefined) return null;
  return accounts.find((a) => a.id === accountId)?.name ?? null;
}

function FilterSummary({
  categoryName,
  categoryId,
  accountName,
  accountId,
  dateFrom,
  dateTo,
  amountMinCents,
  amountMaxCents,
  pending,
  search,
  totalCount,
}: {
  categoryName: string | null;
  categoryId: number | "none" | undefined;
  accountName: string | null;
  accountId: number | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  amountMinCents: number | undefined;
  amountMaxCents: number | undefined;
  pending: TransactionsFilterValues["pending"];
  search: string | undefined;
  totalCount: number;
}) {
  const parts: string[] = [];
  if (search !== undefined) parts.push(`"${search}"`);
  if (categoryName !== null) parts.push(categoryName);
  else if (categoryId !== undefined) parts.push(`Category ${categoryId}`);
  if (accountName !== null) parts.push(accountName);
  else if (accountId !== undefined) parts.push(`Account ${accountId}`);
  if (dateFrom !== undefined || dateTo !== undefined) {
    parts.push(`${dateFrom ?? "…"} – ${dateTo ?? "…"}`);
  }
  if (amountMinCents !== undefined || amountMaxCents !== undefined) {
    const min = amountMinCents !== undefined ? `$${centsToDollarString(amountMinCents)}` : "$0";
    const max = amountMaxCents !== undefined ? `$${centsToDollarString(amountMaxCents)}` : "…";
    parts.push(`${min} – ${max}`);
  }
  if (pending === "posted") parts.push("Posted only");
  else if (pending === "pending") parts.push("Pending only");
  const label = parts.length > 0 ? parts.join(" · ") : "All transactions";
  return (
    <p className="text-sm text-muted-foreground">
      {label} — <strong className="text-foreground">{totalCount}</strong> row
      {totalCount === 1 ? "" : "s"}
    </p>
  );
}
