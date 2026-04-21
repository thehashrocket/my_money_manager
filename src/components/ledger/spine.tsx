import { and, isNull, sql } from "drizzle-orm";
import { connection } from "next/server";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { loadAccountBalances } from "@/lib/accounts/loadAccountBalances";
import { SpineMonth } from "./spine-month";
import { SpineTabs, type TabItem } from "./spine-tabs";
import { ThemeToggle } from "./theme-toggle";

/**
 * The Spine — left rail navigation.
 *
 * Server component. Pulls:
 *  - account balances (via loadAccountBalances)
 *  - uncategorized backlog count (same query loadMonthView uses, inlined
 *    to avoid computing the full month view here — the spine only needs
 *    the scalar count)
 *
 * The interactive bits — month picker, active-tab highlighter, theme
 * toggle — are client sub-components that read usePathname().
 */
function loadBacklogCount(): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
      ),
    )
    .get();
  return row?.count ?? 0;
}

export async function Spine() {
  // Force per-request rendering so account balances + backlog count don't
  // freeze at build time (same rationale as `/budget/page.tsx`).
  await connection();

  const balances = loadAccountBalances();
  const totalCents = balances.reduce((sum, a) => sum + a.balanceCents, 0);
  const backlog = loadBacklogCount();

  const tabs: TabItem[] = [
    { label: "Dashboard", href: "/", icon: "◇", disabled: false, isDashboard: true },
    { label: "Budget", href: "/budget", icon: "▣", matchPrefix: "/budget" },
    { label: "Transactions", href: "/transactions", icon: "≡", matchPrefix: "/transactions" },
    {
      label: "Categorize",
      href: "/categorize",
      icon: "!",
      matchPrefix: "/categorize",
      count: backlog > 0 ? backlog : undefined,
      backlog: true,
    },
    { label: "Subscriptions", href: "/subscriptions", icon: "↻", matchPrefix: "/subscriptions" },
    { label: "Goals", href: "/goals", icon: "★", matchPrefix: "/goals" },
    { label: "Import", href: "/import", icon: "↥", matchPrefix: "/import", divider: true },
  ];

  return (
    <aside className="spine" aria-label="Primary">
      <div className="spine-brand">
        <em>my</em> money<br />manager
      </div>
      <div className="spine-owner">jason · local</div>

      <SpineMonth />

      <SpineTabs tabs={tabs} />

      <div className="spine-peek">
        <div className="peek-title">Peek · balances</div>
        {balances.length === 0 ? (
          <div className="peek-empty">No accounts yet</div>
        ) : (
          <>
            {balances.map((a) => (
              <div key={a.id} className="peek-acct">
                <span className="peek-name">{a.name}</span>
                <span className="peek-amt">{formatCents(a.balanceCents)}</span>
              </div>
            ))}
            <div className="peek-sep" />
            <div className="peek-total">
              <span className="peek-label">total</span>
              <span
                className={
                  totalCents < 0
                    ? "peek-amt money-neg"
                    : totalCents === 0
                      ? "peek-amt money-zero"
                      : "peek-amt money-pos"
                }
                style={{ fontSize: "17px" }}
              >
                {formatCents(totalCents)}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="spine-footer">
        <ThemeToggle />
      </div>
    </aside>
  );
}
