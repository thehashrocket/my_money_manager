"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Spine month picker. Reads pathname:
 *  - On /budget/:year/:month → reflects the viewed month
 *  - Otherwise → real current month
 *
 * Arrows always navigate to `/budget/[year]/[month]`.
 *
 * The exported `SpineMonth` wraps the real component (`SpineMonthReader`) in
 * its own `<Suspense>` — required under Cache Components
 * (cache-components-migration plan, Stage 0). This component's own `new
 * Date()` fallback is deliberately client-only (see `src/lib/now.ts`'s
 * docstring: it must reflect the *visitor's* real timezone, not the
 * server's), but Next 16 still does an initial server-side render pass for
 * a Client Component's first paint, and Cache Components' build-time
 * validation flags that read as "would freeze at build time" wherever it
 * sits inside a route's static shell — reached via `Spine`'s own
 * `SpineFallback` for `/_not-found`, which otherwise has nothing else
 * making it dynamic. The `<Suspense>` boundary tells Next to defer this
 * component past the static shell instead of baking its first value in;
 * behavior (which month shows on first paint) is unchanged, since the
 * shown value was always going to be replaced by the client render either
 * way once React hydrates.
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
  return (
    <Suspense fallback={<div className="spine-month" aria-hidden />}>
      <SpineMonthReader />
    </Suspense>
  );
}

function SpineMonthReader() {
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
