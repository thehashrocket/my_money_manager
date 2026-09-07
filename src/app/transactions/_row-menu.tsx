"use client";

import { useTransition } from "react";
import { toast } from "sonner";
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
  unmarkCardPaymentAction,
} from "@/app/accounts/actions";

/**
 * DS52 — the row's `⋯` overflow menu, currently holding one action.
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
  cardAccounts,
  onChanged,
}: {
  transactionId: number;
  amountCents: number;
  isTransfer: boolean;
  transferPartnerAccountName: string | null;
  /** Credit cards only — a mortgage is rejected server-side anyway (E17). */
  cardAccounts: AccountOption[];
  onChanged: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  // Base UI closes the menu itself on item activation, so nothing here has to.
  const run = (fn: () => Promise<CardActivityState>) => {
    startTransition(async () => {
      try {
        const result = await fn();
        if (result.status === "error") {
          toast.error(result.message);
        } else if (result.status === "ok") {
          toast.success(result.message);
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

  return (
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
          >
            <span aria-hidden>⋯</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
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
  );
}
