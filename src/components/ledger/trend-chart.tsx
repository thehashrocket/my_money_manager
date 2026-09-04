"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCents } from "@/lib/money";
import type { MonthTrend } from "@/lib/trends/loadMonthlyTrends";

type TooltipPayloadItem = {
  name: string;
  value: number;
  fill: string;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
};

export type TrendChartProps = {
  months: MonthTrend[];
  categoryNames: string[];
};

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function buildChartData(months: MonthTrend[], categoryNames: string[]) {
  return months.map((m) => {
    const row: Record<string, string | number> = { label: m.label };
    for (const name of categoryNames) {
      const entry = m.byCategory.find((c) => c.name === name);
      row[name] = entry ? entry.spentCents / 100 : 0;
    }
    return row;
  });
}

// Capped so the tooltip's height stays predictable regardless of how many
// categories a month has — an uncapped list (13 categories) grows tall enough
// to reach past the plot area into the Legend rendered below it, since the
// tooltip floats independently of the Legend's layout.
const TOOLTIP_MAX_ROWS = 5;

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;

  const present = payload.filter((p) => (p.value ?? 0) > 0);
  const sorted = [...present].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = sorted.reduce((s, p) => s + (p.value ?? 0), 0);
  const shown = sorted.slice(0, TOOLTIP_MAX_ROWS);
  const rest = sorted.slice(TOOLTIP_MAX_ROWS);
  const restTotal = rest.reduce((s, p) => s + (p.value ?? 0), 0);

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 shadow-md text-xs font-mono space-y-1 min-w-[160px]">
      <div className="font-semibold text-foreground mb-1">{label}</div>
      {shown.map((p) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.fill }}>{p.name}</span>
          <span className="text-money-neg">{formatCents(Math.round((p.value ?? 0) * 100))}</span>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="flex justify-between gap-4 text-muted-foreground">
          <span>+{rest.length} more</span>
          <span>{formatCents(Math.round(restTotal * 100))}</span>
        </div>
      )}
      <div className="flex justify-between gap-4 border-t border-border pt-1 font-semibold">
        <span className="text-muted-foreground">Total</span>
        <span className="text-money-neg">{formatCents(Math.round(total * 100))}</span>
      </div>
    </div>
  );
}

export function TrendChart({ months, categoryNames }: TrendChartProps) {
  const isEmpty = months.every((m) => m.totalSpentCents === 0);

  if (isEmpty) {
    return (
      <div className="flex items-center justify-center h-[240px] text-sm text-muted-foreground">
        Import more transactions to see spending trends.
      </div>
    );
  }

  const data = buildChartData(months, categoryNames);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v: number) => `$${v}`}
          tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
          axisLine={false}
          tickLine={false}
          width={56}
        />
        {/* Pinning y keeps the tooltip anchored near the top of the plot area
            regardless of which bar is hovered (x still tracks the cursor) —
            otherwise a tall tooltip for a bar near the bottom of the chart
            renders on top of the Legend below it. Combined with capping the
            tooltip's row count above, this keeps the two from overlapping.
            `cursor` overrides Recharts' default hover-highlight rectangle,
            which otherwise renders with its own light-theme default fill —
            a stark white box against this app's dark background. */}
        <Tooltip
          content={<CustomTooltip />}
          position={{ y: 8 }}
          cursor={{ fill: "var(--border)", opacity: 0.5 }}
        />
        <Legend wrapperStyle={{ fontSize: "11px", fontFamily: "var(--font-mono)" }} />
        {categoryNames.map((name, i) => (
          <Bar
            key={name}
            dataKey={name}
            stackId="spend"
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            radius={i === categoryNames.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
