"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type TabItem = {
  label: string;
  href: string;
  icon: string;
  /** Which pathname prefix counts as "active". `/` reserved for Dashboard. */
  matchPrefix?: string;
  /** Dashboard tab — active only on exact "/". */
  isDashboard?: boolean;
  /** Optional count chip on the right. */
  count?: number;
  /** Amber-tinted count chip for the Categorize backlog. */
  backlog?: boolean;
  /** Disabled (not yet built). Renders as a non-interactive row. */
  disabled?: boolean;
  /** Tooltip for disabled tabs. */
  tooltip?: string;
  /** Extra vertical separation above this tab (used for Import). */
  divider?: boolean;
};

function isActive(pathname: string, t: TabItem): boolean {
  if (t.isDashboard) return pathname === "/";
  if (!t.matchPrefix) return false;
  return pathname === t.matchPrefix || pathname.startsWith(t.matchPrefix + "/");
}

export function SpineTabs({ tabs }: { tabs: TabItem[] }) {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="spine-tabs" aria-label="Primary navigation">
      {tabs.map((t) => {
        const active = isActive(pathname, t);
        const classes = cn(
          "spine-tab",
          active && "active",
          t.backlog && "backlog",
          t.disabled && "disabled",
          t.divider && "mt-2",
        );
        const body = (
          <>
            <span className="tab-icon" aria-hidden>
              {t.icon}
            </span>
            <span className="tab-label">{t.label}</span>
            {t.count !== undefined ? (
              <span className="tab-count">{t.count}</span>
            ) : null}
          </>
        );
        if (t.disabled) {
          return (
            <span
              key={t.label}
              className={classes}
              title={t.tooltip}
              aria-disabled="true"
            >
              {body}
            </span>
          );
        }
        return (
          <Link
            key={t.label}
            href={t.href}
            className={classes}
            aria-current={active ? "page" : undefined}
          >
            {body}
          </Link>
        );
      })}
    </nav>
  );
}
