import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/db";
import { loadMerchantGroups } from "@/lib/categorize/loadMerchantGroups";
import { listLeafCategories } from "@/lib/categories";
import { loadUncategorizedBacklog } from "@/lib/budget/loadUncategorizedBacklog";
import { parseScopeParams } from "@/lib/categorize/scopeParams";
import { currentMonth } from "@/lib/now";
import { CategorizeUi } from "./_categorize-ui";
import { ScopeNav } from "./_scope-nav";

type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * `/categorize` — bulk-by-merchant view.
 *
 * Server renders the initial grouped list + leaf dropdown options; the client
 * island (`CategorizeUi`) holds the live backlog counter + per-row submit
 * state for Sonner toast + Undo.
 *
 * `?year=&month=` (parsed by `parseScopeParams`) narrows both the list AND
 * the counter to one calendar month — "categorize September, leave the rest
 * for later" — TODOS.md's long-open "no month-scoped BULK categorize
 * screen" item. No params (the default, and the only state this page had
 * before this) means all-time, matching E5's original choice exactly:
 * `loadUncategorizedBacklog` is still called directly rather than through a
 * full `loadMonthView`, just with `scope` threaded through when present.
 */
export default async function CategorizePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await connection();
  const scope = parseScopeParams(await searchParams);
  const groups = loadMerchantGroups(db, scope);
  const leafCategories = listLeafCategories(db);
  const uncategorizedBacklog = loadUncategorizedBacklog(db, scope);

  return (
    <main className="mx-auto max-w-4xl p-5 space-y-7">
      <header className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Link
            href="/budget"
            className="underline-offset-4 hover:underline"
          >
            ← Budget
          </Link>
        </div>
        <h1 className="font-display text-2xl tracking-[-0.015em]">Categorize</h1>
        {/* T15/D16 — the disclosure is the feature this page was missing, and
            a `<details>` chevron alone does not say what is behind it. One
            sentence naming it is the difference between the samples being
            found and being shipped unused. */}
        <p className="text-sm text-ink-2">
          Pick a category for each merchant group — open a merchant name to see
          what the bank actually called those charges. Tick <em>Remember</em> to
          save an exact rule so future imports auto-categorize.
        </p>
      </header>

      <ScopeNav scope={scope} thisMonth={currentMonth()} />

      <CategorizeUi
        initialGroups={groups}
        leafCategories={leafCategories}
        initialBacklog={uncategorizedBacklog}
        scope={scope}
      />
    </main>
  );
}
