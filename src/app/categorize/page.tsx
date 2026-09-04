import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/db";
import { loadMerchantGroups } from "@/lib/categorize/loadMerchantGroups";
import { listLeafCategories } from "@/lib/categories";
import { loadUncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";
import { CategorizeUi } from "./_categorize-ui";

/**
 * `/categorize` — bulk-by-merchant view.
 *
 * Server renders the initial grouped list + leaf dropdown options; the client
 * island (`CategorizeUi`) holds the live backlog counter + per-row submit
 * state for Sonner toast + Undo. E5: calls `loadUncategorizedBacklog`
 * directly (unscoped — all-time, matching this page's existing behavior)
 * instead of building and discarding a full `loadMonthView` for one COUNT(*).
 */
export default async function CategorizePage() {
  await connection();
  const groups = loadMerchantGroups(db);
  const leafCategories = listLeafCategories(db);
  const uncategorizedBacklog = loadUncategorizedBacklog(db);

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <header className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Link
            href="/budget"
            className="underline-offset-4 hover:underline"
          >
            ← Budget
          </Link>
        </div>
        <h1 className="text-2xl font-semibold">Categorize</h1>
        <p className="text-sm text-muted-foreground">
          Pick a category for each merchant group. Tick <em>Remember</em> to
          save an exact rule so future imports auto-categorize.
        </p>
      </header>

      <CategorizeUi
        initialGroups={groups}
        leafCategories={leafCategories}
        initialBacklog={uncategorizedBacklog}
      />
    </main>
  );
}
