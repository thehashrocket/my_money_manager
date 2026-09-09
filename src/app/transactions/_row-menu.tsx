"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { AccountOption } from "@/lib/accounts/listAccounts";
import type { CardActivityState } from "@/app/accounts/action-state";
import {
  markAsCardPaymentAction,
  removeCardActivityAction,
  unmarkCardPaymentAction,
} from "@/app/accounts/actions";

/**
 * DS52 — the row's `⋯` overflow menu.
 *
 * `_transaction-row.tsx` already carries ten elements per row, and roughly one
 * row in two hundred is a card payment. An always-visible control on every row
 * to serve that is the clutter Krug names; a row-level overflow menu is the
 * conventional home for a rare per-row action and gives the next one somewhere
 * to go.
 *
 * E8 — this WIRES the existing `src/components/ui/dropdown-menu.tsx`. The plan
 * claimed it had zero consumers and had never rendered; that was wrong in one
 * direction (`_category-menu.tsx` ships it on every budget row) and right in
 * the useful one: there was nothing to acquire, so DS63's "deliberate fifth
 * shadcn component" purchase was never needed.
 */
export function TransactionRowMenu({
  transactionId,
  isTransfer,
  transferPartnerAccountName,
  isManual,
  cardAccounts,
  onChanged,
}: {
  transactionId: number;
  isTransfer: boolean;
  transferPartnerAccountName: string | null;
  /** `import_source = 'manual'` — a row this app wrote, not one a bank sent. */
  isManual: boolean;
  /** Credit cards only — a mortgage is rejected server-side anyway (E17). */
  cardAccounts: AccountOption[];
  onChanged: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  // A confirmation, because the delete has NO undo. This repo's doctrine
  // (CLAUDE.md rules 4 and 8) is that an irreversible write is confirmed and a
  // reversible one is not — a modal on a reversible action is what teaches
  // people to click through modals. Archiving a category gets a dialog here and
  // that IS reversible from /budget/categories; this is strictly less
  // recoverable, so it gets one too.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Base UI closes the menu itself on item activation, so nothing here has to.
  const run = (fn: () => Promise<CardActivityState>) => {
    startTransition(async () => {
      try {
        const result = await fn();
        if (result.status === "error") {
          toast.error(result.message);
        } else if (result.status === "ok") {
          // THE WARNING IS NOT OPTIONAL TO READ. All three actions this drives
          // now return one from `revalidateCardActivitySurfaces`, and
          // `revalidateAfterWrite.ts` says in as many words that a caller which
          // DISCARDS it makes a failed refresh silent again. It matters most on
          // `removeCardActivityAction`: the delete has no undo, and a stale list
          // still showing the row under a green "success" reads as the delete
          // having failed — so the user's next move is to try again.
          //
          // ONE toast, never a success plus a warning (rule 6): the collapsed
          // Sonner stack draws a non-newest toast's action button invisible.
          if (result.warning === undefined) {
            toast.success(result.message);
          } else {
            toast.warning(`${result.message} ${result.warning}`, { duration: 10_000 });
          }
          onChanged();
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That didn't work.");
      }
    });
  };

  const mark = (cardAccountId: number) =>
    run(() => {
      const fd = new FormData();
      fd.set("transactionId", String(transactionId));
      fd.set("cardAccountId", String(cardAccountId));
      return markAsCardPaymentAction({ status: "idle" }, fd);
    });

  const unmark = () =>
    run(() => {
      const fd = new FormData();
      fd.set("transactionId", String(transactionId));
      return unmarkCardPaymentAction({ status: "idle" }, fd);
    });

  const remove = () =>
    run(() => {
      const fd = new FormData();
      fd.set("transactionId", String(transactionId));
      // Sent ONLY from the confirm dialog's own button. `removeCardActivity`
      // refuses without it, so the confirmation is a fact the server checks
      // rather than one this component is trusted to have performed — rules 4
      // and 8 both arrived at that after being burned by the opposite.
      fd.set("confirmedIrreversible", "yes");
      return removeCardActivityAction({ status: "idle" }, fd);
    });

  return (
    <>
    <DropdownMenu>
      {/* Same `render` shape `_category-menu.tsx` uses, so the trigger is a
          real <button> with Base UI's keyboard behaviour — Escape, arrow-key
          roving, aria-haspopup and focus return to the trigger — rather than
          a hand-rolled menu that loses all four. */}
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            disabled={isPending}
            className="min-h-11 min-w-11"
          >
            <span aria-hidden>⋯</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {/* PRECEDENCE IS LOAD-BEARING, and it mirrors `removeCardActivity`'s
            own guard order. `isTransfer` is tested FIRST, because a manual row
            that is paired is a card-payment leg: deleting one side strands the
            other, which is the damage E12 describes, so that row must get
            "Not a card payment" and never "Remove this charge". The server
            refuses it either way — this just means the user never sees an item
            that cannot work. */}
        {isTransfer ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              {transferPartnerAccountName
                ? `Paired with ${transferPartnerAccountName}`
                : "Paired transfer"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* E12 — unmarkCardPayment, NOT unlinkTransferPair. The latter
                would strand the synthetic mirror as an uncategorized row in
                the backlog, still inflating the card balance, and
                rejection-mark the pair so re-pairing is blocked. It refuses
                politely if this pair was not created here. */}
            <DropdownMenuItem onClick={unmark}>Not a card payment</DropdownMenuItem>
          </DropdownMenuGroup>
        ) : isManual ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Hand-entered</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* The way back from "Add a charge", which had none. Until this
                existed, a mistyped amount or a charge on the wrong card was
                permanent — and because one row flips the account off the feed
                balance pass (E16/D15), it also permanently converted a
                feed-refreshed card into a hand-reconcile chore. Removing the
                last row restores both. */}
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmOpen(true)}>
              Remove this charge…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : cardAccounts.length === 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>No credit cards yet</DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Mark as payment to</DropdownMenuLabel>
            {cardAccounts.map((card) => (
              <DropdownMenuItem key={card.id} onClick={() => mark(card.id)}>
                {card.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>

    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <DialogContent className="sm:max-w-md" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>Remove this charge?</DialogTitle>
          <DialogDescription>
            You typed this one in, so removing it takes it out of the ledger entirely.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-[color-mix(in_oklch,var(--accent-redbrown)_35%,transparent)] bg-[color-mix(in_oklch,var(--accent-redbrown)_12%,var(--background))] px-3 py-2 text-sm text-ink-1">
          {/* "may change", not "changes". Under rule 1 the balance sum is
              `date > starting_balance_date`, so a row dated on or before the
              account's current anchor — the ordinary state after any later
              reconcile — contributes nothing to it. Overstating the blast
              radius of a delete that has no undo is the direction that erodes
              trust in every other confirmation in the app. */}
          <p>
            This category&apos;s spend changes, and the card&apos;s balance may too.
          </p>
          <p className="mt-1 font-medium text-money-neg">This cannot be undone in the app.</p>
        </div>
        {/* Same footer treatment as the budget menu's dialogs: Cancel FIRST in
            DOM order and holding `initialFocus`, because Base UI focuses the
            first tabbable element and that would otherwise park the keyboard on
            a destructive commit a second Enter fires.
            
            The MOBILE order is the opposite of what a copy of this comment in
            `_category-menu.tsx` claims: `flex-col-reverse` puts the LAST DOM
            child first, so "Remove charge" renders on top and Cancel sits
            nearest the thumb. That is the safe arrangement — the thumb rests on
            the way out, not on the destructive commit — but the note said the
            reverse, and a wrong note is what drives the next change wrong. */}
        <DialogFooter className="sm:flex-row-reverse sm:justify-start">
          <Button ref={cancelRef} type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={() => {
              setConfirmOpen(false);
              remove();
            }}
          >
            {isPending ? "Removing…" : "Remove charge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
