export type SubscriptionTxn = {
  normalizedMerchant: string;
  date: string; // YYYY-MM-DD
  amountCents: number; // signed; we use absolute value
};

export type DetectedSubscription = {
  normalizedMerchant: string;
  cadence: "monthly" | "quarterly";
  medianAmountCents: number;
  firstSeen: string; // YYYY-MM-DD
  lastSeen: string; // YYYY-MM-DD
  nextExpectedDate: string; // YYYY-MM-DD
  count: number;
};

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b) - Date.parse(a)) / 86_400_000,
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(Date.parse(dateStr) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const MONTHLY_MIN = 25;
const MONTHLY_MAX = 35;
const QUARTERLY_MIN = 85;
const QUARTERLY_MAX = 95;

export function detectSubscriptions(
  txns: SubscriptionTxn[],
): DetectedSubscription[] {
  const byMerchant = new Map<string, SubscriptionTxn[]>();
  for (const t of txns) {
    const group = byMerchant.get(t.normalizedMerchant) ?? [];
    group.push(t);
    byMerchant.set(t.normalizedMerchant, group);
  }

  const results: DetectedSubscription[] = [];

  for (const [merchant, group] of byMerchant) {
    if (group.length < 3) continue;

    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : 1));

    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date));
    }

    const isMonthly = intervals.every(
      (d) => d >= MONTHLY_MIN && d <= MONTHLY_MAX,
    );
    const isQuarterly = intervals.every(
      (d) => d >= QUARTERLY_MIN && d <= QUARTERLY_MAX,
    );

    if (!isMonthly && !isQuarterly) continue;

    const amounts = sorted.map((t) => Math.abs(t.amountCents));
    const med = median(amounts);
    const tolerance = Math.max(50, Math.round(med * 0.02));
    const amountsOk = amounts.every((a) => Math.abs(a - med) <= tolerance);

    if (!amountsOk) continue;

    const medianInterval = median(intervals);
    const lastSeen = sorted[sorted.length - 1].date;

    results.push({
      normalizedMerchant: merchant,
      cadence: isMonthly ? "monthly" : "quarterly",
      medianAmountCents: med,
      firstSeen: sorted[0].date,
      lastSeen,
      nextExpectedDate: addDays(lastSeen, medianInterval),
      count: sorted.length,
    });
  }

  return results.sort((a, b) =>
    a.normalizedMerchant.localeCompare(b.normalizedMerchant),
  );
}
