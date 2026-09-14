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
import type { CardPaymentCandidate } from "@/lib/accounts/loadCardPaymentCandidates";
import { formatCents } from "@/lib/money";
import type { CardActivityState } from "@/app/accounts/action-state";
import {
  linkCardPaymentAction,
  markAsCardPaymentAction,
  removeCardActivityAction,
  unmarkCardPaymentAction,
} from "@/app/accounts/actions";

/** T9 — one importing card's unpaired candidates, as handed down from the page. */
export type ImportingCardOption = AccountOption & {
  candidates: CardPaymentCandidate[];
};

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
  amountCents,
  sourceIsAsset,
  isTransfer,
  pairIsAppCreated,
  transferPartnerAccountName,
  isManual,
  cardAccounts,
  importingCards,
  onChanged,
}: {
  transactionId: number;
  /** T9 — which importing cards' candidates match this row's magnitude. */
  amountCents: number;
  /**
   * T9 (Codex adversarial finding) — is THIS row's own account checking or
   * savings, as opposed to a card? `linkCardPayment` refuses a source leg
   * that isn't an asset account (mirroring `markAsCardPayment`'s identical
   * guard), so a row living ON a credit card must never offer "Link to a
   * card charge" — a charge on Card A whose magnitude happens to match an
   * unpaired credit on Card B would otherwise render a control that always
   * refuses (rule 8).
   */
  sourceIsAsset: boolean;
  isTransfer: boolean;
  /** D5.2 — meaningless unless `isTransfer`. See `isAppCreatedCardPaymentPair`. */
  pairIsAppCreated: boolean;
  transferPartnerAccountName: string | null;
  /** `import_source = 'manual'` — a row this app wrote, not one a bank sent. */
  isManual: boolean;
  /** Credit cards only — a mortgage is rejected server-side anyway (E17). */
  cardAccounts: AccountOption[];
  /** T9 — cards whose own transactions come in from the feed. */
  importingCards: ImportingCardOption[];
  onChanged: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [linkDialogCard, setLinkDialogCard] = useState<ImportingCardOption | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  // A confirmation, because the delete has NO undo. This repo's doctrine
  // (CLAUDE.md rules 4 and 8) is that an irreversible write is confirmed and a
  // reversible one is not — a modal on a reversible action is what teaches
  // people to click through modals. Archiving a category gets a dialog here and
  // that IS reversible from /budget/categories; this is strictly less
  // recoverable, so it gets one too.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  /* The reachability of the delete, in ONE place because it is now read
     twice — by the menu item and by the dialog that item opens. Two spellings
     of it could drift into an item whose dialog never mounts, i.e. a control
     that silently does nothing; inside the ternary below `isTransfer` is
     already false, so this reads there exactly as the bare `isManual` it
     replaced. The precedence itself is argued at the ternary. */
  const canRemove = !isTransfer && isManual;

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
          // `onChanged()` is `router.refresh()` in `TransactionsUi`, so THIS
          // list updates on the client regardless of whether the server-side
          // revalidation threw. Repeating the shared "reload to see the current
          // state" sentence here would tell the user to reload a page that just
          // refreshed itself — a false warning, which is the same class of
          // wrongness this branch exists to remove, pointed the other way.
          //
          // The staleness is real, it is just elsewhere: `/accounts` (this card's
          // balance), `/budget` and the dashboard all read what these actions
          // wrote. So the toast names those instead.
          if (result.warning === undefined) {
            toast.success(result.message);
          } else {
            toast.warning(
              `${result.message} Other pages may still show the old figures — reload them to catch up.`,
              { duration: 10_000 },
            );
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

  const link = (cardTransactionId: number) =>
    run(() => {
      const fd = new FormData();
      fd.set("transactionId", String(transactionId));
      fd.set("cardTransactionId", String(cardTransactionId));
      return linkCardPaymentAction({ status: "idle" }, fd);
    });

  // T9/D8.2 — only cards with at least one candidate matching THIS row's
  // magnitude, so the menu never offers a picker that would open onto an
  // empty list. Not a rule-8 refusal-avoidance case (an empty picker isn't a
  // refusal, it's an accurate "nothing posted yet"); this is a plainer
  // cleanliness call — hide the item until there's something to pick.
  // Red-team finding (card-payment-linking-pr2): `linkCardPayment` refuses a
  // non-negative source row server-side ("A card payment has to be money
  // leaving an account"), so a row that would always be refused must not
  // offer the item at all (rule 8) — otherwise a positive row (a deposit)
  // could still find a magnitude-matching card charge and render a control
  // that can only fail.
  const linkableCards =
    amountCents >= 0 || !sourceIsAsset
      ? []
      : importingCards
          .map((card) => ({
            ...card,
            candidates: card.candidates.filter((c) => c.amountCents === -amountCents),
          }))
          .filter((card) => card.candidates.length > 0);

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
            {/* D5.2 — offered ONLY for a pair `markAsCardPayment` created (a
                synthetic mirror). `unmarkCardPayment` already refuses an
                ordinary bank-to-bank transfer pair with "wasn't created
                here" — showing the item on every paired row was a refusal
                the user could only discover by clicking it (rule 8), which
                is exactly the anti-pattern `listCardAccounts`'s own D8.3
                exclusion already names.

                A T9 `linkCardPayment` pair is DELIBERATELY excluded too, not
                merely uncovered: both its legs are real bank rows, which is
                structurally identical to an ordinary auto-matched transfer
                pair — `isAppCreatedCardPaymentPair` correctly reads it as
                `false` (`resolveCardAffordances.test.ts`'s own "T9's manual
                link is NOT app-created" case), because `unmarkCardPayment`
                would refuse it for the same reason it refuses any real-to-
                real pair: there is no synthetic mirror to delete, and
                deleting either real leg would destroy imported history. The
                way back for a T9 link is the same one an ordinary transfer
                pair already uses — `/sync`'s "linked pairs" review
                (`unlinkTransferPair`), which only clears `transfer_pair_id`
                rather than deleting a row. An earlier draft of this comment
                claimed T9 pairs render this item too; that was wrong and is
                corrected here rather than left to drift further (the exact
                failure class PR #52's comment-accuracy pass found 22 of). */}
            {pairIsAppCreated ? (
              <DropdownMenuItem onClick={unmark}>Not a card payment</DropdownMenuItem>
            ) : (
              // Design review, card-payment-linking-pr2: the common case here
              // is an ORDINARY auto-matched bank-to-bank pair, not a card
              // payment — `pairIsAppCreated` is false for most rows that take
              // this branch, so `null` left the label + separator above with
              // nothing clickable beneath them: a dead-end menu that reads as
              // broken rather than as "nothing to do here." Matches the inert
              // label already used a few branches down for the analogous
              // "no credit cards yet" case rather than leaving a silent gap.
              <DropdownMenuLabel>No actions for this pair</DropdownMenuLabel>
            )}
          </DropdownMenuGroup>
        ) : canRemove ? (
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
        ) : cardAccounts.length === 0 && linkableCards.length === 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>No credit cards yet</DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : (
          <>
            {/* D8.3 already excludes an importing card from this list
                (`listCardAccounts`) — a hand-made mirror there would double
                the bank's own credit once it arrives. */}
            {cardAccounts.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Mark as payment to</DropdownMenuLabel>
                {cardAccounts.map((card) => (
                  <DropdownMenuItem key={card.id} onClick={() => mark(card.id)}>
                    {card.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ) : null}
            {/* T9 — the entry point onto `linkTransferPairManually` for a card
                that imports its own transactions: the real bank credit is
                already staged, so this links to it instead of fabricating a
                mirror. */}
            {linkableCards.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>Link to a card charge</DropdownMenuLabel>
                {linkableCards.map((card) => (
                  <DropdownMenuItem
                    key={card.id}
                    onClick={() => {
                      setSelectedCandidateId(
                        card.candidates.length === 1 ? String(card.candidates[0]!.id) : "",
                      );
                      setLinkDialogCard(card);
                    }}
                  >
                    {card.name}…
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>

    {/* Mounted only where it can be opened. `setConfirmOpen(true)` lives in
        the one menu branch `canRemove` gates, and roughly one row in two
        hundred is hand-entered — so on every other row this was a `Dialog`
        root whose `open` could never become true, one per row on a list of
        fifty. It is the same condition, not a second reading of it. */}
    {canRemove ? (
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
            
            Both reverses put the LAST DOM child first, so "Remove charge"
            renders leftmost on desktop and on TOP on mobile, leaving Cancel
            nearest the thumb. That is the safe arrangement — the thumb rests on
            the way out, not on the destructive commit. The sibling note in
            `_category-menu.tsx` described the mobile order the other way round
            until it was corrected on 2026-09-09; the two now agree, and a
            wrong note is what drives the next change wrong. */}
        <DialogFooter className="sm:flex-row-reverse sm:justify-start">
          <Button ref={cancelRef} type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          {/* A STATIC label, not `isPending ? "Removing…" : …`. The click
              closes the dialog before `remove()` starts the transition, so
              `DialogContent` unmounts in the same commit that `isPending`
              turns true and this button never renders in the pending state —
              a label switching on it is a sentence nobody can ever read, and
              a false claim about what the UI does is the class of comment
              this branch spent a commit deleting. `disabled` stays: it costs
              nothing and is the honest guard if the dialog is ever kept open
              across the write. What actually blocks a second submit today is
              the menu trigger's own `disabled={isPending}`, which stops the
              menu reopening while one is in flight. */}
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={() => {
              setConfirmOpen(false);
              remove();
            }}
          >
            Remove charge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    ) : null}

    {/* T9 — mounted only while a linkable card exists, same reasoning as the
        remove-confirm dialog above: `linkDialogCard` can only become non-null
        from an item `linkableCards.length > 0` gates. */}
    {linkableCards.length > 0 ? (
    <Dialog
      open={linkDialogCard !== null}
      onOpenChange={(open) => {
        if (!open) setLinkDialogCard(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to {linkDialogCard?.name}</DialogTitle>
          <DialogDescription>
            Pick the transaction your bank reported for this payment — linking
            takes both rows out of spending, the same as &ldquo;Mark as payment to&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <select
          aria-label="Bank transaction"
          className="h-11 w-full rounded-md border border-[var(--border)] bg-background px-2 text-sm"
          value={selectedCandidateId}
          onChange={(e) => setSelectedCandidateId(e.target.value)}
        >
          <option value="" disabled>
            Choose…
          </option>
          {linkDialogCard?.candidates.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.date} · {formatCents(c.amountCents)} · {c.rawMemo}
            </option>
          ))}
        </select>
        <DialogFooter className="sm:flex-row-reverse sm:justify-start">
          <Button
            type="button"
            disabled={!selectedCandidateId || isPending}
            onClick={() => {
              const cardTransactionId = Number(selectedCandidateId);
              setLinkDialogCard(null);
              setSelectedCandidateId("");
              link(cardTransactionId);
            }}
          >
            Link
          </Button>
          <Button type="button" variant="ghost" onClick={() => setLinkDialogCard(null)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    ) : null}
    </>
  );
}
