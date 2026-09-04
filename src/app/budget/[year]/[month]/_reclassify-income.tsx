"use client";

import { useActionState, useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import type { ReclassifyCandidate } from "@/lib/budget/setCategoryKind";
import { setCategoryKindAction, type SetCategoryKindActionState } from "../../actions";

const initialState: SetCategoryKindActionState = { status: "idle" };

function monthRange(candidate: ReclassifyCandidate): string {
  if (candidate.transactionCount === 0) return "no transactions yet";
  return `${candidate.earliestDate} – ${candidate.latestDate}`;
}

/**
 * D14A layer 1 / DS22 — total-failure banner: `/budget` renders this when
 * ZERO categories have `kind='income'`, which makes Left to Budget
 * uncomputable. Unreachable today (the seed always keeps three income
 * leaves), but the failure mode it repairs — every income category
 * eventually renamed away by PR2b's rename action — has no earlier warning,
 * so this ships ahead of the risk rather than after it (same posture as
 * DS30's first-run card).
 *
 * DS32: the confirmation dialog states a concrete transaction count, date
 * range, and the X1 all-positive check as evidence BEFORE the user
 * confirms — `candidates` is computed server-side (`loadReclassifyCandidates`)
 * so that evidence is real, not discovered only after a refused submit.
 */
export function ReclassifyIncomeBanner({ candidates }: { candidates: ReclassifyCandidate[] }) {
  const [categoryId, setCategoryId] = useState("");
  const selected = candidates.find((c) => String(c.id) === categoryId) ?? null;
  const [state, formAction, pending] = useActionState(setCategoryKindAction, initialState);
  const comboboxId = useId();

  return (
    <div
      className="flex flex-col gap-3 rounded-lg px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      style={{
        background: "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
        border: "1px solid color-mix(in oklch, var(--accent-amber) 45%, transparent)",
      }}
    >
      <span style={{ color: "color-mix(in oklch, var(--accent-amber) 55%, var(--fg))" }}>
        No income categories — Left to Budget cannot be computed.
      </span>

      <Dialog>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>Fix this</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reclassify a category as income</DialogTitle>
            <DialogDescription>
              Pick the category your income actually lands in — this changes what it does, not just its
              label.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <CategoryCombobox
              id={comboboxId}
              name="categoryIdPicker"
              value={categoryId}
              onValueChange={setCategoryId}
              categories={candidates.map((c) => ({ id: c.id, name: c.name, parentId: null }))}
              placeholder="Pick a category…"
            />

            {selected ? (
              <div className="rounded-md bg-[var(--bg-inset)] px-3 py-2 text-sm text-ink-1">
                <p className="font-medium">{selected.name}</p>
                <p className="text-ink-2">
                  {selected.transactionCount} transaction{selected.transactionCount === 1 ? "" : "s"} ·{" "}
                  {monthRange(selected)} · {selected.allPositive ? "all positive" : "includes a negative row"}
                </p>
                <p className="mt-2 text-ink-1">
                  Reclassifying rewrites how those months are calculated. This month&apos;s summary, every
                  prior month, the spending trend chart, and whether this category can receive transactions
                  all change.
                </p>
                <p className="mt-1 font-medium text-money-neg">This cannot be undone in the app.</p>
                {!selected.allPositive ? (
                  <p className="mt-2 text-money-neg">
                    This category has at least one negative transaction, so it can&apos;t be reclassified —
                    pick the category that only ever receives money.
                  </p>
                ) : null}
              </div>
            ) : null}

            {state.status === "error" ? <p className="text-money-neg">{state.message}</p> : null}
          </div>

          <DialogFooter showCloseButton>
            <form action={formAction}>
              <input type="hidden" name="categoryId" value={categoryId} />
              <input type="hidden" name="kind" value="income" />
              <Button
                type="submit"
                variant="primary"
                disabled={!selected || !selected.allPositive || pending}
              >
                {selected ? `Reclassify ${selected.name}` : "Reclassify"}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
