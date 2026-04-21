import { connection } from "next/server";
import { loadSubscriptions } from "@/lib/subscriptions/loadSubscriptions";
import { formatCents } from "@/lib/money";
import { dismissSubscriptionAction, restoreSubscriptionAction } from "./actions";
import type { DetectedSubscription } from "@/lib/subscriptions/detectSubscriptions";

export default async function SubscriptionsPage() {
  await connection();
  const { active, dismissed } = loadSubscriptions();

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-8 [font-variant-numeric:tabular-nums]">
      <div className="space-y-1">
        <h1 className="font-display text-xl font-semibold">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
          Recurring charges detected from your transaction history.
        </p>
      </div>

      {active.length === 0 && dismissed.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {active.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                Detected · {active.length}
              </h2>
              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                {active.map((sub) => (
                  <SubscriptionRow
                    key={sub.normalizedMerchant}
                    sub={sub}
                    action={dismissSubscriptionAction}
                    actionLabel="Not a subscription"
                  />
                ))}
              </div>
            </section>
          )}

          {dismissed.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                Dismissed · {dismissed.length}
              </h2>
              <div className="divide-y divide-border rounded-lg border border-border bg-card opacity-60">
                {dismissed.map((sub) => (
                  <SubscriptionRow
                    key={sub.normalizedMerchant}
                    sub={sub}
                    action={restoreSubscriptionAction}
                    actionLabel="Restore"
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function SubscriptionRow({
  sub,
  action,
  actionLabel,
}: {
  sub: DetectedSubscription;
  action: (formData: FormData) => Promise<void>;
  actionLabel: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const daysUntil = Math.round(
    (Date.parse(sub.nextExpectedDate) - Date.parse(today)) / 86_400_000,
  );
  const nextLabel =
    daysUntil === 0
      ? "today"
      : daysUntil === 1
        ? "tomorrow"
        : daysUntil < 0
          ? `${Math.abs(daysUntil)}d ago`
          : `in ${daysUntil}d`;

  return (
    <div className="flex items-center gap-4 px-4 py-3 text-sm">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{sub.normalizedMerchant}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {sub.cadence} · {sub.count} charges · since{" "}
          {new Date(Date.parse(sub.firstSeen)).toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          })}
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className="font-mono font-medium text-money-neg">
          {formatCents(-sub.medianAmountCents)}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          next {nextLabel}
        </div>
      </div>

      <form action={action}>
        <input type="hidden" name="normalizedMerchant" value={sub.normalizedMerchant} />
        <button
          type="submit"
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {actionLabel}
        </button>
      </form>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-8 py-10 text-center">
      <div className="mb-3 font-mono text-3xl text-muted-foreground">↻</div>
      <p className="mb-1 text-sm font-medium">No recurring charges detected yet</p>
      <p className="text-xs text-muted-foreground">
        Import at least 3 months of transactions for subscription detection to work.
      </p>
    </div>
  );
}
