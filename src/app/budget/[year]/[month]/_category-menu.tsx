"use client";

import { useId, useRef, useState, useTransition } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CategoryKind } from "@/lib/budget/categoryKindLock";
import { kindsImplyUsed } from "@/lib/budget/kindsImplyUsed";
import {
  archiveCategoryAction,
  moveCategoryAction,
  renameCategoryAction,
  setCarryoverPolicyAction,
  setCategoryKindAction,
} from "../../actions";

type CarryoverPolicy = "none" | "rollover" | "reset";

/** Which dialog is open, carrying whatever that dialog needs to render. */
type ActiveDialog =
  | { kind: "rename" }
  | { kind: "archive" }
  | { kind: "setKind"; newKind: CategoryKind }
  | null;

export type CategoryMenuProps = {
  categoryId: number;
  categoryName: string;
  kind: CategoryKind;
  carryoverPolicy: CarryoverPolicy;
  /**
   * Which kinds `setCategoryKind` will still accept (rule 8 + X1), from
   * `loadMonthView`. Always includes the current kind.
   *
   * Server-computed on purpose: the answer depends on whether the category has
   * ANY transaction or ANY month's `budget_periods` row, which is not
   * derivable from anything else this menu is handed. Rendering all three
   * unconditionally is what let a fund offer "Set kind: expense" that always
   * refused — a fund acquires a `budget_periods` row from one keystroke in the
   * FUNDS band (`$0` included) or one "Copy previous month", and rule 8's X1
   * exception is expense→income only, so it never applies to a fund.
   *
   * A single-entry array is the normal state for a used category. The block
   * then renders `kindLockReason` as a label instead of a row of dead items —
   * see the comment at the render site for why it is not dropped outright.
   */
  assignableKinds: CategoryKind[];
  /**
   * Why the kind is locked, or null when it is not. Server-computed for the
   * same reason `assignableKinds` is: it counts the WHOLE ledger.
   */
  kindLockReason?: string | null;
  /** DS16 — "disabled rather than hidden" at list ends, so the control
   * column never reflows depending on position. */
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** T29 — "at both levels": a group header shares this same menu (Rename +
   * Move up/down operate identically on a leaf or a group, since
   * `moveCategory`'s "siblings" are just same-`parent_id` rows either way).
   * `kind`/`carryoverPolicy` are inert on a group (a group's own `kind` is
   * never read, and it can never hold an allocation — `ParentAllocationError`
   * enforces that), and archiving one refuses whenever it still has children
   * (`CategoryHasChildrenError`, i.e. almost always) — all three items are
   * hidden here rather than offered as an action that's essentially always
   * a guaranteed refusal. */
  isGroup?: boolean;
};

/**
 * T26/DS20 — the row's `⋯`: structural and destructive actions (rename, set
 * kind, set carryover, archive) plus T29's reorder pair, all in one menu so
 * a row has exactly one overflow affordance. Replaces T18/PR2a's
 * `RowOverflowTrigger`, whose only job (viewing the explicit/rollover/
 * effective breakdown) is now redundant with `AllocationCell`'s inline
 * rollover caption — keeping both would mean two `⋯` triggers on one row.
 *
 * Each destructive/input-needing action (rename, archive) opens its own
 * controlled `Dialog` rather than nesting a `DialogTrigger` inside a
 * `DropdownMenuItem` — Base UI's menu closes and returns focus to its own
 * trigger on any item click, which fights a nested dialog trying to open
 * and claim focus in the same tick. A plain `onClick` that sets which
 * dialog is active, rendered as siblings outside the menu, sidesteps that
 * race entirely.
 */
export function CategoryMenu({
  categoryId,
  categoryName,
  kind,
  carryoverPolicy,
  assignableKinds,
  kindLockReason = null,
  canMoveUp,
  canMoveDown,
  isGroup = false,
}: CategoryMenuProps) {
  // Payload INSIDE the discriminant. `activeDialog` and a separate
  // `pendingKind` were two pieces of state encoding one fact with nothing
  // making them agree, which forced three dead branches on the dialog: a
  // `?? ""` in its title, a `newKind === null` in its disabled test, and an
  // early return in its confirm handler — each of which a reader has to prove
  // dead. Same discipline as `SyncOutcome`.
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const [isPending, startTransition] = useTransition();

  /**
   * Whether a kind change from this menu is the IRREVERSIBLE one.
   *
   * `assignableKinds` returns all three kinds if and only if the category is
   * UNUSED (`categoryKindLock.ts` — `isCategoryUsed` is the first branch), and
   * an unused category's kind is free to change back and forth: nothing has
   * been calculated from it yet. Fewer than three means the category is used,
   * and rule 8 refuses every transition on a used category except X1
   * (expense → income, all rows positive). So on a used category the only
   * change this menu can offer IS X1 — and X1 is one-way, because
   * income → expense on a used category is refused outright. There is no undo.
   *
   * That is the same `< 3` reading `_month-editor`'s `liveAssignableKinds`
   * keys off, and it is reading the live prop, so an allocation committed in
   * this session narrows it here too.
   */
  const kindChangeIsIrreversible = kindsImplyUsed(assignableKinds);

  function moveTo(direction: "up" | "down") {
    startTransition(async () => {
      const result = await moveCategoryAction(categoryId, direction);
      if (result.status === "error") {
        toast.error(result.message);
        return;
      }
      // DS16: "an aria-live announcement of the new position" — the
      // commit-only Left to Budget region (T23) covers allocation edits,
      // not reorder, so this is its own small live region rather than
      // routing an unrelated event through that one.
      const { newPosition, siblingCount } = result.result;
      setMoveAnnouncement(`${categoryName} is now position ${newPosition + 1} of ${siblingCount}.`);
    });
  }

  /**
   * The menu item's handler. Confirms first when the change cannot be undone,
   * applies immediately when it can.
   *
   * The banner flow (`_reclassify-income.tsx`) has always gated this exact
   * write behind a dialog that says in as many words that it cannot be undone.
   * This menu reached the same server action straight from a dropdown click,
   * and v0.24.0's `assignableKinds` work made the item appear exactly when the
   * server WILL accept it — so the unguarded path became the more discoverable
   * of the two, not the less.
   *
   * Deliberately NOT a confirm on every kind change: on an unused category
   * this is ordinary setup and reversible, and a modal there is friction that
   * teaches people to click through modals.
   */
  function requestKind(newKind: CategoryKind) {
    if (newKind === kind) return;
    if (kindChangeIsIrreversible) {
      setActiveDialog({ kind: "setKind", newKind });
      return;
    }
    setKind(newKind);
  }

  function setKind(newKind: CategoryKind) {
    if (newKind === kind) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("categoryId", String(categoryId));
      formData.set("kind", newKind);
      // Not sent: this path only runs for an UNUSED category, where the change
      // is reversible and the server does not ask. Sending it here would make
      // the flag meaningless by always being present.
      try {
        const result = await setCategoryKindAction({ status: "idle" }, formData);
        if (result.status === "error") toast.error(result.message);
        else if (result.status === "ok" && result.warning) toast.warning(result.warning);
        else toast.success(`"${categoryName}" is now ${newKind}.`);
      } catch {
        // Without this, a rethrow produced NEITHER toast — success and hard
        // failure looked identical (the menu just closed).
        toast.error("Something went wrong. Reload the page to see the current kind.");
      }
    });
  }

  function setPolicy(policy: CarryoverPolicy) {
    if (policy === carryoverPolicy) return;
    startTransition(async () => {
      const result = await setCarryoverPolicyAction(categoryId, policy);
      if (result.status === "error") toast.error(result.message);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              aria-label={`More options for ${categoryName}`}
              disabled={isPending}
            />
          }
        >
          ⋯
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => setActiveDialog({ kind: "rename" })}>Rename…</DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* DS16: "44×44 hit area" — min-h-11 (44px) rather than the
              shared DropdownMenuItem's default compact padding, since
              reorder is the one menu action DS16 specifically calls out
              a touch-target size for; every other item stays list-dense. */}
          <DropdownMenuItem
            className="min-h-11"
            disabled={!canMoveUp}
            aria-label={`Move ${categoryName} up`}
            onClick={() => moveTo("up")}
          >
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            disabled={!canMoveDown}
            aria-label={`Move ${categoryName} down`}
            onClick={() => moveTo("down")}
          >
            Move down
          </DropdownMenuItem>
          {isGroup ? null : (
            <>
              {/* Only the kinds the server will ACCEPT — offering one it will
                  always refuse is the DS32 shape this fix is for.

                  A locked category still renders a block, as a label stating
                  the cause. Dropping it entirely was tried and is a different
                  bug: this menu is the only surface in the app that reaches
                  `setCategoryKindAction` (/budget/categories renders kind
                  read-only), so hiding it made `setCategoryKind`'s evidence
                  message unreachable and left "not allowed" and "this app has
                  no kind control" looking identical. The label also means the
                  section changes WORDING rather than vanishing mid-session
                  when a first allocation locks the kind. */}
              <DropdownMenuSeparator />
              {assignableKinds.length > 1 ? (
                assignableKinds.map((k) => (
                  <DropdownMenuItem
                    key={k}
                    disabled={k === kind}
                    variant={k !== kind && kindChangeIsIrreversible ? "destructive" : undefined}
                    onClick={() => requestKind(k)}
                  >
                    Set kind: {k}
                    {k !== kind && kindChangeIsIrreversible ? "…" : ""}
                  </DropdownMenuItem>
                ))
              ) : (
                // DropdownMenuGroup is REQUIRED around a label — Base UI's
                // GroupLabel throws without it and takes the route's error
                // boundary with it.
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    Kind: {kind} · locked{kindLockReason ? ` — ${kindLockReason}` : ""}
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
              )}
              <DropdownMenuSeparator />
              {(["none", "rollover", "reset"] as const).map((p) => (
                <DropdownMenuItem key={p} disabled={p === carryoverPolicy} onClick={() => setPolicy(p)}>
                  Carryover: {p}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setActiveDialog({ kind: "archive" })}>
                Archive…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div role="status" aria-live="polite" className="sr-only">
        {moveAnnouncement}
      </div>

      <RenameDialog
        open={activeDialog?.kind === "rename"}
        onOpenChange={(open) => setActiveDialog(open ? { kind: "rename" } : null)}
        categoryId={categoryId}
        categoryName={categoryName}
      />
      <ArchiveDialog
        open={activeDialog?.kind === "archive"}
        onOpenChange={(open) => setActiveDialog(open ? { kind: "archive" } : null)}
        categoryId={categoryId}
        categoryName={categoryName}
      />
      {activeDialog?.kind === "setKind" ? (
        <SetKindDialog
          open
          onOpenChange={(open) => {
            if (!open) setActiveDialog(null);
          }}
          categoryId={categoryId}
          categoryName={categoryName}
          currentKind={kind}
          newKind={activeDialog.newKind}
        />
      ) : null}
    </>
  );
}

/**
 * The confirm step for an irreversible kind change, deliberately carrying the
 * same three claims `_reclassify-income.tsx` makes rather than a generic "are
 * you sure": WHAT is recalculated, that it reaches PRIOR months and not just
 * this one, and that the app has no way back.
 *
 * Copy is duplicated rather than shared with the banner, and that is a real
 * trade rather than an oversight. The two surfaces differ in what the user has
 * already told the app: the banner is a picker, so it names the row count and
 * date range it just loaded as evidence for WHICH category to convert; here
 * the category is already chosen and the only open question is whether to go
 * through with it. Extracting one component would mean either loading
 * evidence this menu does not have or dropping it from the banner, and the
 * banner's evidence is the more load-bearing of the two. If a third surface
 * ever reaches `setCategoryKindAction`, extract then — with three call sites
 * the shared shape is knowable rather than guessed.
 */
function SetKindDialog({
  open,
  onOpenChange,
  categoryId,
  categoryName,
  currentKind,
  newKind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryId: number;
  categoryName: string;
  currentKind: CategoryKind;
  newKind: CategoryKind;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Reset on the OPEN transition, not on close — the same render-time pattern
  // (and the same reason) as RenameDialog below. `DialogContent` stays mounted
  // through its exit animation, so clearing state on close renders a degraded
  // frame for the duration of it: the title losing its kind, the button label
  // falling back to the generic "Change" and going disabled, all while the
  // user watches it animate away.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setError(null);
  }

  function confirm() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("categoryId", String(categoryId));
      formData.set("kind", newKind);
      // The server REQUIRES this on the X1 branch and refuses without it, so a
      // stale tab that never rendered this dialog cannot reach the one-way
      // write. Absence is a refusal, not a default.
      formData.set("confirmedIrreversible", "yes");
      let result;
      try {
        result = await setCategoryKindAction({ status: "idle" }, formData);
      } catch {
        // `setCategoryKindAction` rethrows anything that is not one of its four
        // domain refusals — SQLITE_BUSY, a driver error. In a production build
        // Next.js replaces the message with a digest, so there is nothing to
        // show but there IS something to say: this write may have landed, and
        // claiming it failed would be the more misleading of the two lies.
        setError(
          "Something went wrong. This change may or may not have been saved — reload the page to see.",
        );
        return;
      }
      // Stay OPEN on a refusal and render it here, like RenameDialog and
      // ArchiveDialog. Closing optimistically and routing the message to a
      // toast made `isPending` unobservable (the dialog unmounted in the same
      // commit it went true) and put the server's evidence — the transaction
      // count and date range rule 8 refuses with — somewhere the user had
      // already lost the context for.
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      onOpenChange(false);
      // A refresh failure is a warning ON a successful write, never an error.
      if (result.status === "ok" && result.warning) toast.warning(result.warning);
      else toast.success(`"${categoryName}" is now ${newKind}.`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={closeRef}>
        <DialogHeader>
          <DialogTitle>
            Change “{categoryName}” from {currentKind} to {newKind}?
          </DialogTitle>
          <DialogDescription>
            This category already has activity, so the change is not a setting — it rewrites how the
            months it appears in are calculated.
          </DialogDescription>
        </DialogHeader>
        {/* Warning surface, not the neutral evidence inset the banner uses for
            row counts: this panel carries no evidence, only the consequence,
            and it is the only thing standing between a click and a rewrite of
            every prior month. */}
        <div className="rounded-md border border-[color-mix(in_oklch,var(--accent-redbrown)_35%,transparent)] bg-[color-mix(in_oklch,var(--accent-redbrown)_12%,var(--background))] px-3 py-2 text-sm text-ink-1">
          <p>
            This month&apos;s summary, every prior month, the spending trend chart, and whether this
            category can receive transactions all change.
          </p>
          <p className="mt-1 font-medium text-money-neg">This cannot be undone in the app.</p>
        </div>
        {error ? <p className="text-sm text-money-neg">{error}</p> : null}
        <DialogFooter>
          {/* Close first in DOM order AND the initialFocus target: Base UI
              focuses the first tabbable element in the popup, which would
              otherwise park the keyboard on an irreversible commit that a
              second Enter fires. */}
          <Button ref={closeRef} type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* `destructive`, not `primary`. ArchiveDialog in this same file uses
              destructive for an action its own copy says can be undone from
              /budget/categories; styling this one as an ordinary Save inverted
              visual weight against consequence inside one component. The
              banner's primary button does not transfer: there the write
              REPAIRS a broken state (no income categories, Left to Budget
              uncomputable) and is reached from an amber prompt. */}
          <Button type="button" variant="destructive" disabled={isPending} onClick={confirm}>
            {isPending ? "Changing…" : `Change to ${newKind}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  categoryId,
  categoryName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryId: number;
  categoryName: string;
}) {
  const [name, setName] = useState(categoryName);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputId = useId();

  // Reset during render, not in an effect (React's "adjusting state when a
  // prop changes" pattern) — an effect here would trip
  // `react-hooks/set-state-in-effect`, and more importantly would leave a
  // one-frame flash of the STALE name/error before the reset commits. This
  // fires on every transition to `open`, including the parent's
  // `activeDialog` state flipping this prop true again (re-selecting
  // "Rename…" after a previous refusal) — Base UI's own `onOpenChange`
  // callback does NOT re-fire for that case, only for changes Base UI
  // itself initiates (Escape, backdrop click), which is why that seam
  // isn't used for this reset.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(categoryName);
      setError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename “{categoryName}”</DialogTitle>
          <DialogDescription>The unique name every rule, budget row, and transaction label reads.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await renameCategoryAction(categoryId, name);
              if (result.status === "error") {
                setError(result.message);
                return;
              }
              onOpenChange(false);
            });
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor={inputId} className="text-sm font-medium text-foreground">
              Name
            </label>
            <input
              id={inputId}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              autoFocus
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            {error ? <p className="text-sm text-money-neg">{error}</p> : null}
          </div>
          <DialogFooter showCloseButton>
            <Button type="submit" variant="primary" disabled={isPending || name.trim() === ""}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({
  open,
  onOpenChange,
  categoryId,
  categoryName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categoryId: number;
  categoryName: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // See RenameDialog's comment above — reset during render, keyed off
  // `open` transitioning to true, not an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setError(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive “{categoryName}”?</DialogTitle>
          <DialogDescription>
            Hides it from every picker and this month&apos;s budget going forward. Not a delete — its transactions
            and history stay exactly where they are, and this can be undone from <code>/budget/categories</code>.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-money-neg">{error}</p> : null}
        <DialogFooter showCloseButton>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                const result = await archiveCategoryAction(categoryId);
                if (result.status === "error") {
                  setError(result.message);
                  return;
                }
                onOpenChange(false);
              });
            }}
          >
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
