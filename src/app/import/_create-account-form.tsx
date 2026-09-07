"use client";

import { useId, useState } from "react";
import { accountClass } from "@/lib/accounts/accountClass";
import type { AccountType } from "@/lib/accounts/loadAccountBalances";
import { formatCents } from "@/lib/money";
import { formatLongDate } from "@/lib/now";
import { Button } from "@/components/ui/button";
import { createAccountAction } from "./actions";

/**
 * DS64 — the account-creation form, and the one surface where the sign
 * convention can silently corrupt the ledger.
 *
 * THE USER NEVER TYPES A NEGATIVE NUMBER. For a card or a loan the field is
 * "Balance owed", takes a positive figure, and `validateCreateAccountInput`
 * negates it server-side. The live echo below restates what will be stored in
 * plain words, because the failure this replaces was invisible: typing `2000`
 * for a $2,000 Visa used to create the account with a POSITIVE anchor, add
 * $2,000 to the dashboard's Cash figure, and leave net worth wrong by $4,000
 * — with a number that looked entirely plausible.
 *
 * A client component only because the labels, the helper copy, the card-only
 * fields and the echo all key off the selected type. The submit path is still
 * the plain Server Action; nothing here is optimistic.
 *
 * Restyled to Ledger Paper tokens (DS64). Scope is this `<form>` only — the
 * CSV upload form and the anchor-repair section above it stay on raw
 * `zinc-*`, so the page is visibly half-converted. That is accepted and
 * tracked in TODOS.md: a full-page restyle touches the most
 * correctness-critical code in the app for purely visual reasons.
 */

const FIELD =
  "w-full rounded-md border border-border bg-card px-3 py-2 text-base text-ink-1 " +
  "transition-colors focus:border-terracotta focus:outline-none focus:ring-1 focus:ring-terracotta";
const LABEL = "mb-1 block font-mono text-xs uppercase tracking-wide text-ink-3";
const HELP = "mt-1 block text-base font-normal text-ink-3";

export function CreateAccountForm({ today }: { today: string }) {
  const [type, setType] = useState<AccountType>("checking");
  const [balance, setBalance] = useState("");
  const [asOf, setAsOf] = useState(today);
  const nameId = useId();
  const typeId = useId();
  const balanceId = useId();
  const dateId = useId();
  const limitId = useId();
  const minPaymentId = useId();

  const isLiability = accountClass(type) === "liability";
  const isCard = type === "credit";

  const owedCents = Math.round(Number(balance) * 100);
  const echo =
    isLiability && balance.trim() !== "" && Number.isFinite(owedCents) && owedCents >= 0
      ? `You owe ${formatCents(owedCents)} as of ${formatLongDate(asOf)}.`
      : null;

  return (
    <form
      action={createAccountAction}
      className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-paper-2 p-5 shadow-soft sm:grid-cols-2"
    >
      <div className="sm:col-span-1">
        <label className={LABEL} htmlFor={nameId}>
          Name
        </label>
        <input
          id={nameId}
          type="text"
          name="name"
          required
          placeholder={isCard ? "Visa" : "Checking"}
          className={FIELD}
        />
      </div>

      <div className="sm:col-span-1">
        <label className={LABEL} htmlFor={typeId}>
          Type
        </label>
        <select
          id={typeId}
          name="type"
          required
          value={type}
          onChange={(e) => setType(e.target.value as AccountType)}
          className={FIELD}
        >
          <option value="checking">checking</option>
          <option value="savings">savings</option>
          <option value="credit">credit card</option>
          <option value="loan">loan</option>
        </select>
      </div>

      <div className="sm:col-span-1">
        <label className={LABEL} htmlFor={balanceId}>
          {/* DS61 #1 */}
          {isLiability ? "Balance owed" : "Starting balance (USD)"}
        </label>
        <input
          id={balanceId}
          type="number"
          name="startingBalance"
          step="0.01"
          min={isLiability ? "0" : undefined}
          required
          placeholder="0.00"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          className={`${FIELD} [font-variant-numeric:tabular-nums]`}
        />
        <span className={HELP}>
          {isLiability ? (
            /* DS61 #2 */
            <>
              What you owe on this account today, as a positive number.
              We&apos;ll record it as a debt.
            </>
          ) : (
            <>
              The balance at the <em>close</em> of the starting balance date —
              not necessarily today&apos;s balance. A CSV import re-derives this
              from the file&apos;s running Balance column, so a rough figure is
              fine.
            </>
          )}
        </span>
      </div>

      <div className="sm:col-span-1">
        <label className={LABEL} htmlFor={dateId}>
          {/* DS61 #4 */}
          {isLiability ? "As of" : "Starting balance date"}
        </label>
        <input
          id={dateId}
          type="date"
          name="startingBalanceDate"
          required
          max={today}
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          className={FIELD}
        />
        <span className={HELP}>
          {isLiability ? (
            /* DS61 #5 */
            <>
              Charges and payments dated after this day count toward the
              balance. Anything on or before it is already included in the
              figure above.
            </>
          ) : (
            <>
              Transactions dated <em>after</em> this day are summed onto the
              starting balance; anything on or before it counts as already
              included. Set it on or before your CSV&apos;s earliest row —
              dating it today leaves the entire import out of your balance.
            </>
          )}
        </span>
      </div>

      {/* D2=A — cards only. A mortgage renders no utilization bar and no
          minimum payment (DS59), so offering either here would store a number
          nothing ever reads; the server rejects them for a loan too. */}
      {isCard ? (
        <>
          <div className="sm:col-span-1">
            <label className={LABEL} htmlFor={limitId}>
              Credit limit <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id={limitId}
              type="number"
              name="creditLimit"
              step="0.01"
              min="0"
              placeholder="5000.00"
              className={`${FIELD} [font-variant-numeric:tabular-nums]`}
            />
            <span className={HELP}>Used to show how much of the card you&apos;ve used.</span>
          </div>

          <div className="sm:col-span-1">
            <label className={LABEL} htmlFor={minPaymentId}>
              Minimum payment <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id={minPaymentId}
              type="number"
              name="minimumPayment"
              step="0.01"
              min="0"
              placeholder="50.00"
              className={`${FIELD} [font-variant-numeric:tabular-nums]`}
            />
            <span className={HELP}>Shown on the card for reference. Nothing tracks it.</span>
          </div>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        {/* `min-h-11` / `w-full sm:w-auto` to match every other new control on
            this branch — the default Button size is 34px, which would have
            left the primary CTA of account creation below the 44px floor its
            own secondary buttons one route over already clear. */}
        <Button type="submit" variant="primary" className="min-h-11 w-full sm:w-auto">
          Create account
        </Button>
        {/* DS61 #3 — restates what will be STORED, in the words the user
            would use, so a sign mistake is visible before it is committed
            rather than three screens later on the dashboard. */}
        {echo ? (
          <span
            className="font-mono text-base text-ink-2 [font-variant-numeric:tabular-nums]"
            role="status"
            aria-live="polite"
          >
            {echo}
          </span>
        ) : null}
      </div>
    </form>
  );
}
