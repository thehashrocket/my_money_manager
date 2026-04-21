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

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;

  const sorted = [...payload].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = sorted.reduce((s, p) => s + (p.value ?? 0), 0);

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 shadow-md text-xs font-mono space-y-1 min-w-[160px]">
      <div className="font-semibold text-foreground mb-1">{label}</div>
      {sorted.map((p) =>
        (p.value ?? 0) > 0 ? (
          <div key={p.name} className="flex justify-between gap-4">
            <span style={{ color: p.fill }}>{p.name}</span>
            <span className="text-money-neg">{formatCents(Math.round((p.value ?? 0) * 100))}</span>
          </div>
        ) : null,
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
        <Tooltip content={<CustomTooltip />} />
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
