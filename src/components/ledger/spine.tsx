import { and, isNull, sql } from "drizzle-orm";
import { connection } from "next/server";
import Link from "next/link";
import { db, schema } from "@/db";
import { formatCents, moneyToneClass } from "@/lib/money";
import { loadAccountBalancesForRequest } from "@/lib/accounts/loadAccountBalances";
import { summarizeBalances } from "@/lib/accounts/summarizeBalances";
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

  const allBalances = loadAccountBalancesForRequest();
  // DS50 — the peek is ASSETS ONLY. D4=A relabels the subtotal to "Cash", but
  // leaving the liabilities in the list above it produces a subtotal that
  // visibly does not sum its own rows — a closure violation, on every page in
  // the app. Debt lives on / and /accounts, which you reach deliberately.
  // Side benefit: no truncation rule is needed in a 240px rail, where
  // ($302,480.11) in 13px mono leaves about 100px for a name and `.peek-acct`
  // has no min-width or ellipsis.
  const balances = allBalances.filter((a) => a.class === "asset");
  const { assetsCents } = summarizeBalances(allBalances);
  const backlog = loadBacklogCount();

  const tabs: TabItem[] = [
    { label: "Dashboard", href: "/", icon: "◇", disabled: false, isDashboard: true },
    // DS68 — second position. The two "where do I stand" surfaces before the
    // three "what do I do" ones. Without a tab the route is reachable only by
    // typing the URL, which fails Krug's trunk test by definition.
    { label: "Accounts", href: "/accounts", icon: "▤", matchPrefix: "/accounts" },
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
    { label: "Funds", href: "/goals", icon: "★", matchPrefix: "/goals" },
    { label: "Sync", href: "/sync", icon: "⟳", matchPrefix: "/sync", divider: true },
    { label: "Import", href: "/import", icon: "↥", matchPrefix: "/import" },
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
        {/* DS68 — a header that merely happens to be clickable signals
            nothing, and there is no hover on touch, so the affordance is
            visible: an underline on hover plus a persistent `›`. This also
            fixes a small existing oddity — these balances were a dead end. */}
        <Link className="peek-title peek-title-link" href="/accounts">
          Peek · balances <span aria-hidden>›</span>
        </Link>
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
              {/* D4=A — "cash", not "total". The rail answers "can I afford
                  this", and net worth cannot. Relabelling makes the narrowing
                  explicit instead of silently changing what the most-viewed
                  number in the app means. */}
              <span className="peek-label">cash</span>
              <span
                className={`peek-amt ${moneyToneClass(assetsCents)}`}
                style={{ fontSize: "17px" }}
              >
                {formatCents(assetsCents)}
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
