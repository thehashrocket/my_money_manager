import { describe, it, expect } from "vitest";
import { detectSubscriptions, type SubscriptionTxn } from "./detectSubscriptions";

function txn(merchant: string, date: string, amountCents: number): SubscriptionTxn {
  return { normalizedMerchant: merchant, date, amountCents };
}

// Build N monthly transactions for a merchant starting at startDate
function monthly(
  merchant: string,
  startDate: string,
  amountCents: number,
  count: number,
): SubscriptionTxn[] {
  const rows: SubscriptionTxn[] = [];
  let d = new Date(Date.parse(startDate));
  for (let i = 0; i < count; i++) {
    rows.push(txn(merchant, d.toISOString().slice(0, 10), amountCents));
    d = new Date(d.getTime() + 30 * 86_400_000);
  }
  return rows;
}

function quarterly(
  merchant: string,
  startDate: string,
  amountCents: number,
  count: number,
): SubscriptionTxn[] {
  const rows: SubscriptionTxn[] = [];
  let d = new Date(Date.parse(startDate));
  for (let i = 0; i < count; i++) {
    rows.push(txn(merchant, d.toISOString().slice(0, 10), amountCents));
    d = new Date(d.getTime() + 91 * 86_400_000);
  }
  return rows;
}

describe("detectSubscriptions", () => {
  it("detects a monthly subscription", () => {
    const txns = monthly("NETFLIX", "2025-01-15", -1599, 4);
    const result = detectSubscriptions(txns);
    expect(result).toHaveLength(1);
    expect(result[0].normalizedMerchant).toBe("NETFLIX");
    expect(result[0].cadence).toBe("monthly");
    expect(result[0].medianAmountCents).toBe(1599);
    expect(result[0].count).toBe(4);
  });

  it("detects a quarterly subscription", () => {
    const txns = quarterly("AMAZON PRIME", "2025-01-01", -1499, 3);
    const result = detectSubscriptions(txns);
    expect(result).toHaveLength(1);
    expect(result[0].cadence).toBe("quarterly");
    expect(result[0].count).toBe(3);
  });

  it("requires at least 3 transactions", () => {
    const txns = monthly("SPOTIFY", "2025-01-01", -999, 2);
    expect(detectSubscriptions(txns)).toHaveLength(0);
  });

  it("rejects irregular intervals", () => {
    // 30d then 60d then 30d — mixed intervals fail
    const txns = [
      txn("HULU", "2025-01-01", -799),
      txn("HULU", "2025-01-31", -799),
      txn("HULU", "2025-04-01", -799),
      txn("HULU", "2025-05-01", -799),
    ];
    expect(detectSubscriptions(txns)).toHaveLength(0);
  });

  it("tolerates small amount variation within 2% of median", () => {
    // median = 1500, 2% = 30, so 1520 (diff 20) is ok
    const txns = [
      txn("GYM", "2025-01-01", -1500),
      txn("GYM", "2025-01-31", -1520),
      txn("GYM", "2025-03-02", -1500),
    ];
    const result = detectSubscriptions(txns);
    expect(result).toHaveLength(1);
  });

  it("rejects large amount variation exceeding tolerance", () => {
    // median ~1500, tolerance = max(50, 30) = 50; 1600 diff = 100 → reject
    const txns = [
      txn("GYM", "2025-01-01", -1500),
      txn("GYM", "2025-01-31", -1600),
      txn("GYM", "2025-03-02", -1500),
    ];
    expect(detectSubscriptions(txns)).toHaveLength(0);
  });

  it("uses abs value of amountCents (debits are negative)", () => {
    const txns = monthly("APPLE", "2025-01-01", -999, 3);
    const result = detectSubscriptions(txns);
    expect(result[0].medianAmountCents).toBe(999);
  });

  it("computes nextExpectedDate from lastSeen + median interval", () => {
    // 30-day intervals, last txn 2025-04-14 → next 2025-05-14
    const txns = monthly("NETFLIX", "2025-01-14", -1599, 4);
    const result = detectSubscriptions(txns);
    const { lastSeen, nextExpectedDate } = result[0];
    const diff = Math.round(
      (Date.parse(nextExpectedDate) - Date.parse(lastSeen)) / 86_400_000,
    );
    expect(diff).toBe(30);
  });

  it("returns multiple subscriptions sorted by merchant name", () => {
    const txns = [
      ...monthly("SPOTIFY", "2025-01-01", -999, 3),
      ...monthly("APPLE", "2025-01-05", -299, 3),
    ];
    const result = detectSubscriptions(txns);
    expect(result.map((r) => r.normalizedMerchant)).toEqual(["APPLE", "SPOTIFY"]);
  });

  it("ignores merchants that are not recurring even if 3+ transactions exist", () => {
    // Random gaps: 10d, 45d, 5d
    const txns = [
      txn("AMAZON", "2025-01-01", -2000),
      txn("AMAZON", "2025-01-11", -3500),
      txn("AMAZON", "2025-02-25", -1200),
      txn("AMAZON", "2025-03-02", -900),
    ];
    expect(detectSubscriptions(txns)).toHaveLength(0);
  });

  it("handles 50-cent minimum tolerance for cheap subscriptions", () => {
    // median = 99 cents, 2% = ~2 cents; tolerance bumped to 50 cents
    // amount of 149 = diff 50 → exactly at tolerance → should pass
    const txns = [
      txn("CHEAP APP", "2025-01-01", -99),
      txn("CHEAP APP", "2025-01-31", -149),
      txn("CHEAP APP", "2025-03-02", -99),
    ];
    const result = detectSubscriptions(txns);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no transactions provided", () => {
    expect(detectSubscriptions([])).toEqual([]);
  });

  it("records firstSeen and lastSeen correctly", () => {
    const txns = monthly("DROPBOX", "2025-03-01", -999, 3);
    const result = detectSubscriptions(txns);
    expect(result[0].firstSeen).toBe("2025-03-01");
    expect(result[0].lastSeen).toBe("2025-04-30");
  });
});
