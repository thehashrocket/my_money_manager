"use client";

import { useId, useState, useTransition } from "react";
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  archiveCategoryAction,
  moveCategoryAction,
  renameCategoryAction,
  setCarryoverPolicyAction,
  setCategoryKindAction,
} from "../../actions";

type CategoryKind = "income" | "expense" | "fund";
type CarryoverPolicy = "none" | "rollover" | "reset";

export type CategoryMenuProps = {
  categoryId: number;
  categoryName: string;
  kind: CategoryKind;
  carryoverPolicy: CarryoverPolicy;
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
  canMoveUp,
  canMoveDown,
  isGroup = false,
}: CategoryMenuProps) {
  const [activeDialog, setActiveDialog] = useState<"rename" | "archive" | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const [isPending, startTransition] = useTransition();

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

  function setKind(newKind: CategoryKind) {
    if (newKind === kind) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("categoryId", String(categoryId));
      formData.set("kind", newKind);
      const result = await setCategoryKindAction({ status: "idle" }, formData);
      if (result.status === "error") toast.error(result.message);
      else toast.success(`"${categoryName}" is now ${newKind}.`);
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
          <DropdownMenuItem onClick={() => setActiveDialog("rename")}>Rename…</DropdownMenuItem>
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
              <DropdownMenuSeparator />
              {(["expense", "income", "fund"] as const).map((k) => (
                <DropdownMenuItem key={k} disabled={k === kind} onClick={() => setKind(k)}>
                  Set kind: {k}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {(["none", "rollover", "reset"] as const).map((p) => (
                <DropdownMenuItem key={p} disabled={p === carryoverPolicy} onClick={() => setPolicy(p)}>
                  Carryover: {p}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setActiveDialog("archive")}>
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
        open={activeDialog === "rename"}
        onOpenChange={(open) => setActiveDialog(open ? "rename" : null)}
        categoryId={categoryId}
        categoryName={categoryName}
      />
      <ArchiveDialog
        open={activeDialog === "archive"}
        onOpenChange={(open) => setActiveDialog(open ? "archive" : null)}
        categoryId={categoryId}
        categoryName={categoryName}
      />
    </>
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
