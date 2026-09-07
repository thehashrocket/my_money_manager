"use client";

import { useState } from "react";
import type { LeafCategory } from "@/lib/categories";
import { ReconcileDisclosure } from "./_balance-forms";
import { ChargeDialog } from "./_charge-dialog";

/**
 * The card row's action cluster, and the owner of DS56's handoff.
 *
 * D12 refuses a charge dated on or before the anchor, correctly. But the user
 * typed a real charge and the app said no, and the plan originally specified
 * zero words of what happens next. The recovery is genuinely the right action
 * — a fresh reconcile to the true balance ALREADY includes that charge — so
 * the refusal becomes a two-click path instead of a dead end.
 *
 * That handoff needs the dialog and the reconcile form to share client state
 * (close one, open and focus the other), which is why they live under one
 * component rather than side by side in the server row.
 */
export function CardControls({
  accountId,
  accountName,
  balanceCents,
  today,
  categories,
}: {
  accountId: number;
  accountName: string;
  balanceCents: number;
  today: string;
  categories: LeafCategory[];
}) {
  // Bumping a key remounts ReconcileDisclosure in its open state, which is
  // also what moves focus into the balance field (DS66: a handoff that
  // silently relocates the user is worse than the refusal it fixes).
  const [handoff, setHandoff] = useState(0);

  return (
    <div className="mt-2 flex flex-col flex-wrap items-stretch gap-2 sm:flex-row sm:items-start">
      <ReconcileDisclosure
        key={handoff}
        accountId={accountId}
        accountName={accountName}
        balanceCents={balanceCents}
        today={today}
        startOpen={handoff > 0}
      />
      <ChargeDialog
        accountId={accountId}
        accountName={accountName}
        categories={categories}
        today={today}
        onReconcileInstead={() => setHandoff((n) => n + 1)}
      />
    </div>
  );
}
