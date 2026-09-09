"use client";

import { useState } from "react";
import type { LeafCategory } from "@/lib/categories";
import { ReconcileDisclosure } from "./_balance-forms";
import { ChargeDialog } from "./_charge-dialog";
import { CardTermsDisclosure } from "./_card-terms-form";

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
  creditLimitCents,
  minimumPaymentCents,
  canAddCharge,
  canEditTerms,
  showReconcile,
}: {
  accountId: number;
  accountName: string;
  balanceCents: number;
  today: string;
  categories: LeafCategory[];
  creditLimitCents: number | null;
  minimumPaymentCents: number | null;
  /**
   * False for a long-term liability. A mortgage takes no hand-entered
   * charges (D3=A keeps it at zero transaction rows, and `manualTransaction`
   * enforces that at its shared entry per E17) — but it still has a balance
   * that may need correcting, so Reconcile is NOT gated on this.
   */
  canAddCharge: boolean;
  /**
   * Whether this row may edit its card TERMS — credit limit and minimum
   * payment. Card-only (D2=A), and deliberately SEPARATE from `canAddCharge`.
   *
   * They were one flag until the v0.27.0 cycle-3 review. Narrowing
   * `canAddCharge` to "a legal charge date exists" then silently took the terms
   * form with it, so on any card anchored TODAY — the ordinary state after a
   * sync or a same-day reconcile — `Card details` vanished. That form is the
   * only surface for the credit-limit repair rule 9 gives it, and the
   * utilization bar is gated on `credit_limit_cents` being present, so a user
   * who never set a limit had no way to set one and no bar telling them why.
   *
   * Terms have no date to refuse. Nothing about them should depend on one.
   */
  canEditTerms: boolean;
  /**
   * Whether `resolveBalanceAction` picked `reconcile` for this row. DS55's
   * "exactly one balance control" is still decided by that function ALONE —
   * this only relays the answer, so the Reconcile form and the Refresh button
   * cannot both appear.
   *
   * It exists because this component holds TWO unrelated things: the balance
   * control, and the card's own affordances (charge, terms). Nesting the
   * second inside the first deadlocked a feed-linked card — see the note in
   * `_account-row.tsx`.
   */
  showReconcile: boolean;
}) {
  // Bumping a key remounts ReconcileDisclosure in its open state, which is
  // also what moves focus into the balance field (DS66: a handoff that
  // silently relocates the user is worse than the refusal it fixes).
  const [handoff, setHandoff] = useState(0);

  // A feed-linked LONG-TERM liability reaches here with nothing to render:
  // `showReconcile` is false (its balance control is Refresh, drawn by the row
  // itself), and a mortgage takes neither hand-entered charges nor card terms
  // (D3=A / D2=A). Before the un-nesting this component was not mounted at all
  // in that state; now it is, so it has to say so rather than drawing an empty
  // `mt-2 flex gap-2` and an 8px phantom gap under the row.
  //
  // ALL THREE, not two: gating this on `canAddCharge` alone made a CARD anchored
  // today render nothing at all, terms form included.
  if (!showReconcile && !canAddCharge && !canEditTerms) return null;

  return (
    <div className="mt-2 flex flex-col flex-wrap items-stretch gap-2 sm:flex-row sm:items-start">
      {showReconcile ? (
        <ReconcileDisclosure
          key={handoff}
          accountId={accountId}
          accountName={accountName}
          balanceCents={balanceCents}
          today={today}
          startOpen={handoff > 0}
        />
      ) : null}
      {canAddCharge ? (
        <ChargeDialog
          accountId={accountId}
          accountName={accountName}
          categories={categories}
          today={today}
          // DS56's handoff only exists where the destination does. On a
          // feed-refreshed card the row offers Refresh instead, so
          // "Reconcile instead →" would point at a form that is not on screen.
          canReconcile={showReconcile}
          // `!showReconcile` is exactly `resolveBalanceAction === "refresh"`,
          // which is exactly "feed-linked and holding no rows" — the state the
          // first charge ENDS. Passed so the dialog can say so before the
          // click rather than leaving the user to notice the Refresh button
          // has gone.
          endsFeedRefresh={!showReconcile}
          onReconcileInstead={() => setHandoff((n) => n + 1)}
        />
      ) : null}
      {/* D2=A — a credit limit and a minimum payment are card-only concepts,
          so this rides the same gate as the charge affordance rather than
          appearing on a mortgage row that draws neither. */}
      {canEditTerms ? (
        <CardTermsDisclosure
          accountId={accountId}
          accountName={accountName}
          creditLimitCents={creditLimitCents}
          minimumPaymentCents={minimumPaymentCents}
        />
      ) : null}
    </div>
  );
}
