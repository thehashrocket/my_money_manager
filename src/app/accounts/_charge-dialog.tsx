"use client";

import { useActionState, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import type { LeafCategory } from "@/lib/categories";
import { IDLE_ACTIVITY } from "./action-state";
import { statusRole, warningOf } from "@/components/ledger/action-status";
import { addCardActivityAction } from "./actions";

/**
 * DS67 — "Add a charge" lives on the card row.
 *
 * D10 path 2 had a data model, a dedup key and a validation rule, and no
 * interface at all. Putting it here means all three of D10's paths live on
 * one page, which makes `/accounts` the single place debt is managed, and the
 * balance visibly moves as a direct result of what you just typed — the
 * feedback loop DS58 exists to close.
 *
 * E13 — a charge/refund choice, because otherwise a $200 return has nowhere
 * to go and the envelope keeps money you got back.
 *
 * THE CATEGORY IS REQUIRED. D13=B's entire argument is that card charges are
 * how card spending stays visible to the budget; a charge landing with
 * `category_id = NULL` goes to the categorize backlog instead and D13's claim
 * quietly fails for that row.
 */

const FIELD =
  "w-full rounded-md border border-border bg-card px-3 py-2 text-base text-ink-1 " +
  "focus:border-terracotta focus:outline-none focus:ring-1 focus:ring-terracotta";
const LABEL = "mb-1 block font-mono text-xs uppercase tracking-wide text-ink-3";

export function ChargeDialog({
  accountId,
  accountName,
  categories,
  today,
  canReconcile,
  onReconcileInstead,
}: {
  accountId: number;
  accountName: string;
  categories: LeafCategory[];
  today: string;
  /** Whether this row is showing a Reconcile form to hand off TO. */
  canReconcile: boolean;
  /** DS56 — hands the refusal's recovery back to the row. */
  onReconcileInstead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(addCardActivityAction, IDLE_ACTIVITY);
  const [categoryId, setCategoryId] = useState("");
  const [kind, setKind] = useState<"charge" | "refund">("charge");
  // CONTROLLED. React 19 resets a form submitted through a function action, so
  // these three snapped back to empty on every REJECTED submit while
  // `categoryId` and `kind` — already controlled — survived. That is worst
  // exactly where this dialog is designed to stay open: D12's before-anchor
  // refusal deliberately keeps it mounted to offer "Reconcile instead →", and
  // the user was looking at their amount, date and merchant wiped while the
  // refusal explained itself. Reset on the transition to `ok` instead, below,
  // so a genuinely saved charge does leave a clean form behind.
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [merchant, setMerchant] = useState("");
  const amountId = useId();
  const dateId = useId();
  const merchantId = useId();
  const categoryFieldId = useId();

  // Close on success, so the row's new balance is what the user sees next.
  //
  // Gated on the state CHANGING, not on `state.status === "ok"` alone.
  // `useActionState` keeps the last result for the life of the component, and
  // `CardControls` never remounts this one — so a bare status check re-fires
  // on the very next render after the user reopens the dialog, closing it
  // again instantly. The symptom is brutal and silent: you can log exactly one
  // charge per page load, and every attempt after that is a no-op.
  //
  // This is the "adjust state during render" pattern `_month-editor.tsx`
  // already uses to detect a genuinely new server payload, and the same
  // transition check `_category-menu.tsx`'s dialogs use.
  const [handledState, setHandledState] = useState(state);
  if (state !== handledState) {
    setHandledState(state);
    if (state.status === "ok") {
      // CLEAR AND CLOSE, OR NEITHER. `createCardActivity` is not idempotent —
      // each call mints its own batch and its own `import_row_hash` — so
      // staying open with every field reset to pristine and the submit enabled
      // builds the duplicate-write affordance directly under a message whose
      // whole point is that the write succeeded. On the warning path the dialog
      // closes too and the warning goes to a toast, which is what every other
      // surface on this branch does with one.
      setOpen(false);
      // ONE toast, warning-aware. The dialog is gone by the time this renders,
      // so an in-dialog message had nowhere to live; every other surface on
      // this branch reports a post-commit refresh failure the same way, and
      // rule 6 requires one toast rather than a success plus a warning.
      const warning = warningOf(state);
      if (warning === undefined) toast.success(state.message);
      else toast.warning(`${state.message} ${warning}`, { duration: 10_000 });
      // Now that the fields are controlled, React's own reset no longer clears
      // them — so clear them here, on SUCCESS only. Reopening the dialog after
      // a saved charge shows an empty form; reopening after a refusal shows
      // what you typed.
      setAmount("");
      setDate(today);
      setMerchant("");
      setCategoryId("");
      setKind("charge");
    }
  }

  return (
    <>
      {/* A separate trigger button beside a CONTROLLED Dialog, not a nested
          DialogTrigger — the same shape `_category-menu.tsx` uses, and for
          the same reason it documents there. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="min-h-11 w-full sm:w-auto"
      >
        Add a charge
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Add to ${accountName}`}</DialogTitle>
          <DialogDescription>
            A charge counts as spending in its envelope, in the month you made it.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="accountId" value={accountId} />

          <fieldset className="flex gap-2">
            <legend className="sr-only">Charge or refund</legend>
            {(["charge", "refund"] as const).map((k) => (
              <label
                key={k}
                /* The real radio is `sr-only`, so the UA draws its focus ring
                   on a clipped 1px box — invisible. Without this, a keyboard
                   user tabbing into the group cannot tell which option is
                   focused: focused and unfocused render identically until an
                   arrow key changes the checked state. */
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-base capitalize has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-terracotta)] ${
                  kind === k
                    ? "border-terracotta bg-[var(--bg-inset)] text-ink-1"
                    : "border-border text-ink-3"
                }`}
              >
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                  className="sr-only"
                />
                {k}
              </label>
            ))}
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor={amountId}>
                Amount
              </label>
              <input
                id={amountId}
                type="number"
                name="amount"
                step="0.01"
                min="0.01"
                required
                placeholder="80.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`${FIELD} [font-variant-numeric:tabular-nums]`}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={dateId}>
                Date
              </label>
              <input
                id={dateId}
                type="date"
                name="date"
                required
                max={today}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={FIELD}
              />
            </div>
          </div>

          <div>
            <label className={LABEL} htmlFor={merchantId}>
              Where
            </label>
            <input
              id={merchantId}
              type="text"
              name="merchant"
              required
              placeholder="Costco"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              className={FIELD}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor={categoryFieldId}>
              Category
            </label>
            <CategoryCombobox
              id={categoryFieldId}
              name="categoryId"
              value={categoryId}
              onValueChange={setCategoryId}
              categories={categories}
              required
              placeholder="Search categories…"
            />
          </div>

          {state.status === "error" ? (
            // `alert` for a refusal too — `statusRole` is the one derivation,
            // and it returns "alert" here. A refusal inside a modal that a
            // polite region holds is one the user never hears at all.
            <div role={statusRole(state)} aria-live="assertive" className="space-y-1">
              <p className="text-base text-redbrown">{state.message}</p>
              {/* DS56 — the refusal carries its own recovery, as an ACTION
                  rather than a sentence. D12 refuses correctly, but the user
                  typed a real charge and the app said no. Reconciling to the
                  true balance already includes this charge, so this is
                  genuinely the right next step — and it teaches the model by
                  doing rather than in help text. */}
              {state.reason === "before-anchor" && canReconcile ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onReconcileInstead();
                  }}
                  className="text-base font-medium text-terracotta underline-offset-4 hover:underline"
                >
                  Reconcile instead →
                </button>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="submit" variant="primary" disabled={pending} className="min-h-11">
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

