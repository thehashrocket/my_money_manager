import { and, isNull, sql } from "drizzle-orm";
import { connection } from "next/server";
import { Suspense } from "react";
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
 *
 * `Spine` (this file's default export, below) wraps the data-dependent
 * `SpineContent` in `<Suspense>` — required under Cache Components
 * (cache-components-migration plan, Stage 0). `SpineContent`'s own
 * `connection()` call forces per-request rendering, which is correct and
 * necessary (balances must never freeze at build time), but an unwrapped
 * `connection()` inside the root layout blocks *every* route's static
 * shell, including `/_not-found`, which has nothing else to make it
 * dynamic — `pnpm build` fails there without this boundary. `TABS` is
 * shared with `SpineFallback` below so the two never drift on the tab
 * list itself, only on the one field (`count`) that genuinely needs live
 * data — and `SpineShell` shares the surrounding `<aside>` markup itself
 * between `SpineFallback` and `SpineContent`, so neither can drift from the
 * other structurally either (pre-landing review, maintainability
 * specialist — this used to be two hand-duplicated copies of the shell).
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

const TABS: readonly Omit<TabItem, "count">[] = [
  { label: "Dashboard", href: "/", icon: "◇", disabled: false, isDashboard: true },
  // DS68 — second position. The two "where do I stand" surfaces before the
  // three "what do I do" ones. Without a tab the route is reachable only by
  // typing the URL, which fails Krug's trunk test by definition.
  { label: "Accounts", href: "/accounts", icon: "▤", matchPrefix: "/accounts" },
  { label: "Budget", href: "/budget", icon: "▣", matchPrefix: "/budget" },
  { label: "Transactions", href: "/transactions", icon: "≡", matchPrefix: "/transactions" },
  { label: "Categorize", href: "/categorize", icon: "!", matchPrefix: "/categorize", backlog: true },
  { label: "Subscriptions", href: "/subscriptions", icon: "↻", matchPrefix: "/subscriptions" },
  { label: "Funds", href: "/goals", icon: "★", matchPrefix: "/goals" },
  { label: "Sync", href: "/sync", icon: "⟳", matchPrefix: "/sync", divider: true },
  { label: "Import", href: "/import", icon: "↥", matchPrefix: "/import" },
];

export function Spine() {
  return (
    <Suspense fallback={<SpineFallback />}>
      <SpineContent />
    </Suspense>
  );
}

/**
 * The outer rail shell shared by `SpineFallback` and `SpineContent` — brand,
 * owner line, month picker, tabs, footer. The two callers differ only in the
 * `.spine-peek` content they pass as `peek`, so that's the one slot left out
 * (pre-landing review, maintainability specialist: this shell used to be
 * hand-duplicated in both functions and could drift between them).
 */
function SpineShell({ tabs, peek }: { tabs: TabItem[]; peek: React.ReactNode }) {
  return (
    <aside className="spine" aria-label="Primary">
      <div className="spine-brand">
        <em>my</em> money<br />manager
      </div>
      <div className="spine-owner">jason · local</div>
      <SpineMonth />
      <SpineTabs tabs={tabs} />
      <div className="spine-peek">{peek}</div>
      <div className="spine-footer">
        <ThemeToggle />
      </div>
    </aside>
  );
}

/**
 * The static shell — everything in `Spine` that needs no per-request data.
 * Rendered only while `SpineContent` is still awaiting `connection()` +
 * its queries; it exists so the route has a valid static shell to
 * prerender rather than to be a designed-for loading state. On ordinary
 * synchronous SQLite reads this is not expected to be perceptible —
 * **but "ordinary" is doing real work in that sentence (pre-landing
 * review, red-team pass; precision-corrected in post-merge review): this
 * fallback's visible duration depends on `SpineContent`'s query path, which
 * reads through the same underlying SQLite file (WAL mode) that rule 5's
 * `VACUUM INTO` snapshots (import commit, sync, `db:export`) and rule 7's
 * migration rebuilds also open their OWN connections against — separate
 * `Database` instances, several of them in separate node processes
 * entirely, not the same JS connection object or lock. WAL-mode contention
 * is a file/OS-level phenomenon between those independent connections, not
 * a same-connection one. Spine renders on every route via the root layout,
 * so a reader delayed behind one of those writers would make this fallback
 * visible sitewide for the duration, not just on the page that triggered
 * the write.** Not verified empirically against a live snapshot/backfill
 * running concurrently; recorded as a known, unmeasured exposure rather
 * than asserted safe.
 */
function SpineFallback() {
  const tabs: TabItem[] = TABS.map((tab) => ({ ...tab }));
  return (
    <SpineShell
      tabs={tabs}
      peek={
        <div className="peek-empty" aria-hidden>
          &nbsp;
        </div>
      }
    />
  );
}

async function SpineContent() {
  // Force per-request rendering so account balances + backlog count don't
  // freeze at build time (same rationale as `/budget/page.tsx`).
  await connection();

  const allBalances = loadAccountBalancesForRequest();
  // DS50 — the peek is ASSETS ONLY. D4=A relabels the subtotal to "Cash", but
  // leaving the liabilities in the list above it produces a subtotal that
  // visibly does not sum its own rows — a closure violation, on every page in
  // the app. Debt lives on / and /accounts, which you reach deliberately.
  // Side benefit: a 240px rail has less room to spare now that `--text-sm`
  // is 14px, so `.peek-name` truncates with an ellipsis (`.peek-amt` never
  // shrinks — a dollar figure is never the thing that gets clipped).
  const balances = allBalances.filter((a) => a.class === "asset");
  const { assetsCents } = summarizeBalances(allBalances);
  const backlog = loadBacklogCount();

  // Matched by `href`, not `label` — a display-string lookup key silently
  // stops the backlog count from ever attaching if the label copy ever
  // changes (this app already has precedent for that exact kind of rename:
  // the /goals tab is labelled "Funds"), with no type error and nothing to
  // catch it (pre-landing review, maintainability specialist). `href` is
  // the stable identifier every tab already carries.
  const tabs: TabItem[] = TABS.map((tab) =>
    tab.href === "/categorize" ? { ...tab, count: backlog > 0 ? backlog : undefined } : { ...tab },
  );

  return (
    <SpineShell
      tabs={tabs}
      peek={
        <>
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
        </>
      }
    />
  );
}
