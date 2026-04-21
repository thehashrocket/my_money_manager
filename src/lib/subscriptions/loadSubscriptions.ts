import { and, eq, isNull, ne, notLike } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { detectSubscriptions, type DetectedSubscription } from "./detectSubscriptions";

type Db = typeof defaultDb;

export type SubscriptionView = DetectedSubscription & {
  dismissed: boolean;
};

export type SubscriptionsResult = {
  active: DetectedSubscription[];
  dismissed: DetectedSubscription[];
};

export function loadSubscriptions(db: Db = defaultDb): SubscriptionsResult {
  const txns = db
    .select({
      normalizedMerchant: schema.transactions.normalizedMerchant,
      date: schema.transactions.date,
      amountCents: schema.transactions.amountCents,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.transferPairId),
        eq(schema.transactions.isPending, false),
        ne(schema.transactions.rawDescription, "DEPOSIT"),
        notLike(schema.transactions.rawMemo, "POS _%"),
      ),
    )
    .all();

  const detected = detectSubscriptions(txns);

  const dismissedRows = db
    .select({ normalizedMerchant: schema.subscriptionDismissals.normalizedMerchant })
    .from(schema.subscriptionDismissals)
    .all();
  const dismissedSet = new Set(dismissedRows.map((r) => r.normalizedMerchant));

  const active: DetectedSubscription[] = [];
  const dismissed: DetectedSubscription[] = [];

  for (const sub of detected) {
    if (dismissedSet.has(sub.normalizedMerchant)) {
      dismissed.push(sub);
    } else {
      active.push(sub);
    }
  }

  return { active, dismissed };
}
