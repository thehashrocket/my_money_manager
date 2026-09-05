import Link from "next/link";

/**
 * Static glossary for the envelope-budgeting model on this page. Plain
 * server component — no client boundary, no persisted state. `src/app/goals/page.tsx`
 * already established `<details>` as this app's disclosure pattern for
 * lightweight secondary content, so this collapses again on every page
 * load/navigation by design, not oversight (plan decision,
 * `docs/plans/budget-page-help-panel.md`).
 *
 * Describes what each `LeftToBudget` state MEANS in general — never which
 * one currently applies. `left-to-budget.tsx`'s `resolveState` is the
 * source of truth for those states; if it changes, check this copy too.
 */
export function BudgetHelpPanel() {
  return (
    <details className="group rounded-lg bg-[var(--bg-raised)] p-4 shadow-soft">
      <summary className="cursor-pointer font-mono text-xs uppercase tracking-wide text-ink-2 select-none group-open:mb-3">
        How this page works
      </summary>
      <div className="space-y-3 text-sm text-ink-1">
        <p>
          Plan your income first, then assign every dollar of it to a
          category. <span className="font-medium">Left to budget</span> drops
          as you assign — the goal is $0.00 left over.
        </p>
        <dl className="space-y-2">
          <div>
            <dt className="font-medium text-ink-1">Before any income is planned</dt>
            <dd className="text-ink-2">Left to budget prompts you to plan income first, even if you&apos;ve already assigned some expense categories — it needs an income total before it can show real progress.</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-1">Looking ahead to a future month</dt>
            <dd className="text-ink-2">Shows a progress bar toward 100% assigned, since you&apos;re still deciding how to plan ahead.</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-1">Still unassigned</dt>
            <dd className="text-ink-2">Some income isn&apos;t assigned to a category yet — assign it to bring Left to budget to $0.00.</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-1">Over-budgeted</dt>
            <dd className="text-ink-2">More is assigned to categories than income planned for the month — trim an allocation to bring it back to zero.</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-1">Every dollar has a job</dt>
            <dd className="text-ink-2">Left to budget is exactly $0.00 — every dollar of planned income is assigned to a category. Spent can still be incomplete if you have uncategorized transactions.</dd>
          </div>
        </dl>
        <p className="text-ink-2">
          If you have{" "}
          <Link href="/goals" className="underline underline-offset-4 hover:no-underline">Funds</Link>{" "}
          categories, they&apos;re read-only here — manage targets and contributions on the Goals page.
        </p>
        <p className="text-ink-2">
          If Spent looks wrong, you may have{" "}
          <Link href="/categorize" className="underline underline-offset-4 hover:no-underline">
            uncategorized transactions
          </Link>{" "}
          this month.
        </p>
      </div>
    </details>
  );
}
