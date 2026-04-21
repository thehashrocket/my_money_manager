import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { listLeafCategories, type LeafCategory } from "@/lib/categories";
import { loadMonthView } from "@/lib/budget/loadMonthView";
import { loadTransactions } from "@/lib/categorize/loadTransactions";
import { TransactionsUi } from "./_transactions-ui";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/**
 * `/transactions` — filtered, paginated transaction list with inline
 * categorize. Entry points:
 * - `/budget` row link → `?categoryId=<leafId>&year=<y>&month=<m>` for drilldown
 * - standalone → no filter, newest first
 *
 * Invalid searchParams (non-int, out-of-range) route through `notFound()` so
 * URL tampering lands in Next's 404 UI rather than a server error banner
 * (matches `/budget/[year]/[month]` behavior).
 *
 * Transfer-paired rows are excluded from the list server-side (see
 * `loadTransactions`); the categorize action additionally refuses them as a
 * defense-in-depth check.
 */
const searchParamsSchema = z.object({
  categoryId: z
    .union([
      z.literal("none"),
      z.coerce.number().int().positive(),
    ])
    .optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

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

  const { categoryId, year, month } = parsed.data;
  if ((year === undefined) !== (month === undefined)) notFound();

  const page = parsed.data.page ?? 1;
  const pageSize = parsed.data.pageSize ?? DEFAULT_PAGE_SIZE;

  const { rows, totalCount } = loadTransactions(db, {
    categoryId,
    year,
    month,
    page,
    pageSize,
  });

  const leafCategories = listLeafCategories(db);
  const now = new Date();
  const { uncategorizedBacklog } = loadMonthView(
    db,
    now.getFullYear(),
    now.getMonth() + 1,
  );

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const activeCategoryName = resolveActiveCategoryName(categoryId, leafCategories);

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6 [font-variant-numeric:tabular-nums]">
      <header className="space-y-2">
        <h1 className="font-display text-[var(--text-3xl)] leading-none tracking-[-0.015em]">
          Transactions
        </h1>
        <FilterSummary
          categoryName={activeCategoryName}
          categoryId={categoryId}
          year={year}
          month={month}
          totalCount={totalCount}
        />
      </header>

      <TransactionsUi
        rows={rows}
        leafCategories={leafCategories}
        initialBacklog={uncategorizedBacklog}
        page={page}
        pageSize={pageSize}
        totalCount={totalCount}
        totalPages={totalPages}
        searchParams={{ categoryId, year, month }}
      />
    </main>
  );
}

function flatten(raw: RawSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Array.isArray(v) ? v[0] : v;
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

function FilterSummary({
  categoryName,
  categoryId,
  year,
  month,
  totalCount,
}: {
  categoryName: string | null;
  categoryId: number | "none" | undefined;
  year: number | undefined;
  month: number | undefined;
  totalCount: number;
}) {
  const parts: string[] = [];
  if (categoryName !== null) parts.push(categoryName);
  else if (categoryId !== undefined) parts.push(`Category ${categoryId}`);
  if (year !== undefined && month !== undefined) {
    parts.push(
      new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
    );
  }
  const label = parts.length > 0 ? parts.join(" · ") : "All transactions";
  return (
    <p className="text-sm text-muted-foreground">
      {label} — <strong className="text-foreground">{totalCount}</strong> row
      {totalCount === 1 ? "" : "s"}
    </p>
  );
}
