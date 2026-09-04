import Link from "next/link";
import { db } from "@/db";
import { loadAllCategories, type CategoryListRow } from "@/lib/budget/loadAllCategories";
import { formatLocalDateTime } from "@/lib/now";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UnarchiveButton } from "./_unarchive-button";

/**
 * DS20 — "the full management route." Day-to-day category work (rename,
 * set kind, set carryover, archive, reorder, inline creation) all happens
 * on `/budget/[year]/[month]` itself via T26's `⋯` menu and inline rows;
 * this route's one job that ISN'T already covered there is being the place
 * an archived category is still visible and reachable — every other
 * surface (pickers, month views) hides it by design (X3).
 */
export default async function BudgetCategoriesPage() {
  const rows = loadAllCategories(db);
  const groups = groupByKind(rows);

  return (
    <main className="mx-auto max-w-5xl space-y-7 p-6 [font-variant-numeric:tabular-nums]">
      <header className="space-y-2">
        <Link href="/budget" className="text-sm text-terracotta underline-offset-4 hover:underline">
          ← Budget
        </Link>
        <h1 className="font-display text-lg font-medium text-ink-1">Categories</h1>
        <p className="text-sm text-ink-2">
          Every category, including archived ones. Day-to-day changes (rename, archive, reorder) live inline on the
          budget page&apos;s <code>⋯</code> menu — this is the one place to bring an archived category back.
        </p>
      </header>

      {(["income", "expense", "fund"] as const).map((kind) =>
        groups[kind].length > 0 ? <CategoryKindTable key={kind} kind={kind} rows={groups[kind]} /> : null,
      )}
    </main>
  );
}

function groupByKind(rows: CategoryListRow[]): Record<"income" | "expense" | "fund", CategoryListRow[]> {
  return {
    income: rows.filter((r) => r.kind === "income"),
    expense: rows.filter((r) => r.kind === "expense"),
    fund: rows.filter((r) => r.kind === "fund"),
  };
}

const KIND_LABEL: Record<"income" | "expense" | "fund", string> = {
  income: "Income",
  expense: "Expenses",
  fund: "Funds",
};

function CategoryKindTable({ kind, rows }: { kind: "income" | "expense" | "fund"; rows: CategoryListRow[] }) {
  return (
    <section className="space-y-2">
      <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-ink-2">{KIND_LABEL[kind]}</h2>
      <div className="overflow-hidden rounded-lg shadow-soft">
        <Table className="border-collapse">
          <TableCaption className="sr-only">{KIND_LABEL[kind]} categories</TableCaption>
          <TableHeader className="bg-[var(--bg-inset)] font-mono text-xs uppercase tracking-wide text-ink-2">
            <TableRow>
              <TableHead className="px-3">Name</TableHead>
              <TableHead className="px-3">Group</TableHead>
              <TableHead className="px-3">Carryover</TableHead>
              <TableHead className="px-3">Status</TableHead>
              <TableHead className="px-3 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableHead scope="row" className="px-3 py-2 font-normal text-ink-1">
                  {row.name}
                  {row.isGroup ? (
                    <span className="ml-2 rounded-xs bg-[var(--bg-inset)] px-1 font-mono text-[10px] uppercase tracking-wide text-ink-2">
                      Group
                    </span>
                  ) : null}
                </TableHead>
                <TableCell className="px-3 py-2 text-ink-2">{row.parentName ?? "—"}</TableCell>
                <TableCell className="px-3 py-2 text-ink-2">{row.carryoverPolicy}</TableCell>
                <TableCell className="px-3 py-2">
                  {row.archivedAt ? (
                    <span
                      className="rounded-xs bg-[color-mix(in_oklch,var(--accent-amber)_18%,var(--bg-raised))] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-1"
                      title={`Archived ${formatLocalDateTime(row.archivedAt)}`}
                    >
                      Archived
                    </span>
                  ) : (
                    <span className={cn("font-mono text-[10px] uppercase tracking-wide text-ink-3")}>Active</span>
                  )}
                </TableCell>
                <TableCell className="px-3 py-2 text-right">
                  {row.archivedAt ? <UnarchiveButton categoryId={row.id} categoryName={row.name} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
