"use client";

import { useEffect, useRef, useState } from "react";
import { AmountParseError, parseAmountToCents } from "@/lib/money";
import { ALLOCATE_MAX_CENTS } from "@/lib/budget/validateAllocateInput";
import { cn } from "@/lib/utils";

export type CurrencyInputCommitResult = { ok: true } | { ok: false; message: string };

export type CurrencyInputStatus = "idle" | "saving" | "saved" | "failed" | "stale";

/**
 * T19/DS14 — the budget's highest-frequency interaction, and O4's one open
 * design item: DS4 removed toasts, so with no per-field confirmation
 * message, the border IS the entire feedback channel for every commit.
 * Reuses T15's `--motion-quick`/`--motion-settle` tokens rather than
 * inventing a third duration, per DS41.
 *
 * - `idle`   — hairline border, no treatment.
 * - `saving` — border eases to `--accent-terracotta` over `--motion-quick`;
 *              the typed value stays on screen, unblocked.
 * - `saved`  — border eases back to hairline over `--motion-settle`; no
 *              toast (DS4).
 * - `failed` — border `--accent-redbrown`; the optimistic value REVERTS to
 *              last-known-good (never left showing an unsaved number with
 *              no indication), inline retry.
 * - `stale`  — border `--accent-amber`, "changed elsewhere" copy. Modeled
 *              for completeness (DS4 specifies it as one of the four
 *              states) but nothing in this component triggers it: telling
 *              a genuine cross-tab overwrite apart from this tab's own
 *              write needs a version/`updated_at` compare on the server,
 *              which is schema work E7 keeps out of PR2a's no-migration
 *              scope. Correct to leave unwired rather than fake a trigger
 *              — same posture as T16c's `skippedArchived` before PR2b's
 *              archive existed to produce a nonzero count.
 */
const STATUS_BORDER: Record<CurrencyInputStatus, string> = {
  idle: "border-[var(--rule-regular)]",
  saving: "border-[var(--accent-terracotta)]",
  saved: "border-[var(--rule-regular)]",
  failed: "border-[var(--accent-redbrown)]",
  stale: "border-[var(--accent-amber)]",
};

export type CurrencyInputProps = {
  ariaLabel: string;
  /** `null` — no `budget_periods` row this month → placeholder `—` (DS14),
   * never `formatCents(0)`, which cannot express the difference. */
  committedCents: number | null;
  onCommit: (cents: number) => Promise<CurrencyInputCommitResult>;
  /** T24/DS17 — true until this island has hydrated; the input stays
   * genuinely read-only (not just visually) so there is nothing for React's
   * post-hydration reconciliation to "swallow." */
  readOnly?: boolean;
  className?: string;
  /** T26/DS20: exposed as `data-category-id` so `NewCategoryRow` can find
   * and focus THIS specific input once its just-created row appears in the
   * DOM after revalidation — "immediately focuses the new row's amount
   * cell" needs a way to address a row that didn't exist a moment ago. */
  categoryId?: number;
};

function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function CurrencyInput({ ariaLabel, committedCents, onCommit, readOnly, className, categoryId }: CurrencyInputProps) {
  const [status, setStatus] = useState<CurrencyInputStatus>("idle");
  const [draft, setDraft] = useState(committedCents === null ? "" : formatDollars(committedCents));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Enter commits AND immediately calls `advanceFocus`, which focuses the
  // next input — that triggers THIS input's own `onBlur` synchronously,
  // before the Enter-triggered commit's `await onCommit(cents)` has
  // resolved. Without a guard, `onBlur`'s `commitIfDirty()` would re-enter
  // with the same (still-uncommitted) `draft`/`committedCents` and fire a
  // second, redundant `commitAllocationAction` call with identical
  // arguments. Harmless to the DATA (`upsertAllocation`'s upsert is
  // idempotent), but wasteful on the app's highest-frequency interaction
  // and a source of out-of-order `saving`/`saved` flicker. Set synchronously
  // before the `await` (not after) so the blur-triggered re-entry — which
  // happens synchronously within the same call stack as `advanceFocus`, not
  // on a later microtask — is guaranteed to see it already `true`.
  const isCommittingRef = useRef(false);
  // The cents value the in-flight commit is actually writing — lets a
  // re-entrant call (above) tell "the same edit, re-entering via blur" apart
  // from "a genuinely newer edit typed into this field before the first
  // commit finished." Only the latter needs to survive.
  const inFlightCentsRef = useRef<number | null>(null);
  // Set when a re-entrant call carries a newer edit. Retried via the
  // `retrySignal` effect below rather than called directly from the
  // in-flight commit's own `finally` — that `finally` runs synchronously
  // right after `await onCommit(cents)` resolves, before React has
  // necessarily re-rendered with the value `onCommit` just wrote (`commit`
  // in `_month-editor.tsx` calls `setAllocations` before returning, but
  // that's a scheduled update, not an applied one). A direct recursive call
  // would still be the SAME closure from the render that started the
  // original commit, so its `committedCents` would be one write behind —
  // exactly the value that write just changed. `useEffect` only runs after
  // the render (and its props) are current, so retrying there is the only
  // way to guarantee the retry sees the just-committed value.
  const recommitPendingRef = useRef(false);
  const draftRef = useRef(committedCents === null ? "" : formatDollars(committedCents));
  const [retrySignal, setRetrySignal] = useState(0);

  // Re-sync the displayed value when the committed value changes from
  // outside this input (the `⋯` dialog committed the same category-month
  // while this cell wasn't focused) — but never while the user is actively
  // typing here, or an in-flight server round trip would stomp a
  // keystroke.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraftBoth(committedCents === null ? "" : formatDollars(committedCents));
    }
  }, [committedCents]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  useEffect(() => {
    if (retrySignal === 0) return; // skip on mount
    if (recommitPendingRef.current) {
      recommitPendingRef.current = false;
      void commitIfDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retrySignal]);

  function setDraftBoth(value: string) {
    draftRef.current = value;
    setDraft(value);
  }

  function revertToCommitted() {
    setDraftBoth(committedCents === null ? "" : formatDollars(committedCents));
  }

  async function commitIfDirty() {
    // Any invocation that reaches here — manual or a queued retry — is about
    // to act on the current draft, so it supersedes whatever earlier call
    // (if any) set this.
    recommitPendingRef.current = false;

    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }

    const trimmed = draftRef.current.trim();
    if (trimmed === "") {
      // No delete-to-clear flow in PR2a (§6.1 scopes this to entry, not
      // unset) — an emptied field reverts rather than erroring.
      revertToCommitted();
      setError(null);
      return;
    }

    let cents: number;
    try {
      cents = parseAmountToCents(trimmed);
    } catch (err) {
      if (!(err instanceof AmountParseError)) throw err;
      setStatus("failed");
      setError("Enter a valid dollar amount.");
      return;
    }

    if (cents > ALLOCATE_MAX_CENTS) {
      setStatus("failed");
      setError("Amounts over $1,000,000 aren't supported.");
      return;
    }

    // Checked BEFORE the "unchanged" shortcut below, and against the value
    // actually in flight rather than `committedCents` — a retype back to
    // the pre-edit `committedCents` while a different value is still being
    // written would otherwise look like a no-op and skip queuing a retry,
    // leaving the server holding the in-flight value while the UI shows the
    // one the user actually wanted.
    if (isCommittingRef.current) {
      if (inFlightCentsRef.current === cents) {
        // The same edit, re-entering via the Enter-triggered blur above —
        // already covered by the in-flight commit, nothing new to do.
        return;
      }
      // A genuinely different value than what's in flight. Queue it rather
      // than starting a second concurrent request (which could resolve out
      // of order) or silently dropping it (which used to happen here — the
      // in-flight commit's own success handler would overwrite this newer,
      // uncommitted draft with its own stale value once it resolved).
      recommitPendingRef.current = true;
      return;
    }

    if (committedCents !== null && cents === committedCents) {
      setDraftBoth(formatDollars(cents));
      return; // unchanged — no network round trip
    }

    setStatus("saving");
    setError(null);
    isCommittingRef.current = true;
    inFlightCentsRef.current = cents;
    try {
      const result = await onCommit(cents);
      // A recommit was queued while this commit was in flight — its result
      // is about to be superseded, so don't let it stomp the newer draft;
      // the retry (triggered below) will set the draft to whatever it
      // actually saves, using a render where `committedCents` reflects
      // THIS commit's write.
      if (result.ok) {
        if (!recommitPendingRef.current) setDraftBoth(formatDollars(cents));
        setStatus("saved");
        settleTimer.current = setTimeout(() => setStatus("idle"), 240);
      } else {
        if (!recommitPendingRef.current) revertToCommitted();
        setStatus("failed");
        setError(result.message);
      }
    } finally {
      isCommittingRef.current = false;
      inFlightCentsRef.current = null;
      if (recommitPendingRef.current) {
        setRetrySignal((n) => n + 1);
      }
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        data-amount-input="true"
        data-category-id={categoryId}
        readOnly={readOnly}
        tabIndex={readOnly ? -1 : 0}
        value={draft}
        placeholder="—"
        onFocus={(e) => {
          setError(null);
          e.currentTarget.select();
        }}
        onChange={(e) => setDraftBoth(e.target.value)}
        onBlur={() => {
          void commitIfDirty();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Commits never block navigation/advance — fire the commit and
            // move on immediately rather than awaiting the server round trip.
            e.preventDefault();
            void commitIfDirty();
            advanceFocus(inputRef.current);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setError(null);
            revertToCommitted();
          }
        }}
        className={cn(
          "h-8 w-24 rounded-sm border bg-transparent px-2 text-right font-mono text-sm text-ink-1 outline-none",
          "[font-variant-numeric:tabular-nums] transition-colors duration-[var(--motion-quick)] ease-[var(--motion-ease)]",
          "focus-visible:ring-2 focus-visible:ring-ring/50",
          STATUS_BORDER[status],
          readOnly && "opacity-40",
          className,
        )}
      />
      {status === "failed" && error ? (
        <span className="flex max-w-32 flex-wrap items-center justify-end gap-1 text-right text-[10px] text-money-neg">
          {error}
          <button
            type="button"
            tabIndex={-1}
            className="underline"
            onClick={() => {
              setStatus("idle");
              setError(null);
              inputRef.current?.focus();
            }}
          >
            retry
          </button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * DS14 — "Enter = commit + advance, wrapping across section boundaries."
 * Every mounted amount cell shares the `data-amount-input` marker in one
 * flat DOM-order list spanning INCOME and EXPENSES, so "wrapping across
 * section boundaries" falls out of plain document order rather than a
 * row-index registry threaded through both bands' state.
 */
function advanceFocus(current: HTMLElement | null): void {
  if (!current) return;
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-amount-input="true"]'));
  const idx = all.indexOf(current);
  if (idx === -1) return;
  const next = all[(idx + 1) % all.length];
  next?.focus();
}
