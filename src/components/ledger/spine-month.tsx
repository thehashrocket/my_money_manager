"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Spine month picker. Reads pathname:
 *  - On /budget/:year/:month → reflects the viewed month
 *  - Otherwise → real current month
 *
 * Arrows always navigate to `/budget/[year]/[month]`.
 */
const BUDGET_MONTH_RE = /^\/budget\/(\d{4})\/(\d{1,2})(?:$|\/)/;

function shiftMonth(year: number, month: number, delta: -1 | 1) {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SpineMonth() {
  const pathname = usePathname();
  const m = pathname ? BUDGET_MONTH_RE.exec(pathname) : null;

  let year: number;
  let month: number;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }

  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);

  return (
    <div className="spine-month">
      <Link
        href={`/budget/${prev.year}/${prev.month}`}
        className="spine-month-arrow"
        aria-label={`Previous month (${MONTH_NAMES[prev.month - 1]} ${prev.year})`}
      >
        ‹
      </Link>
      <div className="spine-month-label">
        <span className="m">{MONTH_NAMES[month - 1]}</span>
        <span className="y">&apos;{String(year).slice(-2)}</span>
      </div>
      <Link
        href={`/budget/${next.year}/${next.month}`}
        className="spine-month-arrow"
        aria-label={`Next month (${MONTH_NAMES[next.month - 1]} ${next.year})`}
      >
        ›
      </Link>
    </div>
  );
}
