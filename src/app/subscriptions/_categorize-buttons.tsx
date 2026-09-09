"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { FOCUS_RING } from "@/components/ledger/focus-ring";
import { cn } from "@/lib/utils";
import {
  categorizeAllSubscriptionsAction,
  categorizeSubscriptionAction,
  dismissSubscriptionAction,
  restoreSubscriptionAction,
} from "./actions";

/**
 * The two "Categorize" controls on `/subscriptions`, as client islands.
 *
 * They were plain `<form action={serverAction}>` posts whose actions returned
 * `void`, which is why every refusal on this page was invisible: the page had
 * no channel to report one and the action had nothing to report. "Categorize
 * all" could withhold a rule for many merchants in a single click and render as
 * an ordinary success. The rest of the app already reports categorize outcomes
 * through Sonner (`/categorize`, `/transactions`), so this brings the third
 * caller onto the same channel rather than inventing a surface for it.
 *
 * There is no Undo here, unlike the other two surfaces, so everything this page
 * can do to your rules has to be said out loud instead. It cannot REMOVE one
 * (`fileSubscription` does not pass `allowRuleRemoval`), but a trainable verdict
 * still upserts, which RETARGETS an existing rule — so `retargetedRule` is
 * reported with the same weight as a refusal rather than folded into "done".
 * Rows are recoverable without an undo (`/budget` and `/transactions` both let
 * the user move them back); a repointed rule is not, which is the asymmetry.
 */
const BUTTON_CLASS =
  "rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

export function CategorizeSubscriptionButton({
  normalizedMerchant,
}: {
  normalizedMerchant: string;
}) {
  const [isPending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("normalizedMerchant", normalizedMerchant);
      try {
        const outcome = await categorizeSubscriptionAction(formData);
        const filed =
          outcome.filedCount === 0
            ? `Nothing left to file for ${normalizedMerchant}.`
            : `Filed ${outcome.filedCount} ${normalizedMerchant} row${outcome.filedCount === 1 ? "" : "s"} as Subscriptions.`;
        /* `warning` rides in the SAME array as the refusal sentences, never a
           second toast. Sonner's collapsed stack draws a non-newest toast's
           children at `opacity: 0`, so stacking would make one of the two
           unreadable until hover (rule 6) — and here the unreadable one could
           be "a hand-trained rule was repointed", which this page cannot
           undo. */
        const notes = [
          outcome.refusal,
          outcome.retargetedRule,
          outcome.warning,
        ].filter((n): n is string => n !== null && n !== undefined);
        if (notes.length === 0) toast.success(filed);
        else
          toast.warning(`${filed} ${notes.join(" ")}`, { duration: 10_000 });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Categorize failed.");
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className={cn(BUTTON_CLASS, FOCUS_RING)}
    >
      {isPending ? "Filing…" : "Categorize"}
    </button>
  );
}

/** Names at most this many merchants in a summary toast before counting the rest. */
const MAX_NAMED = 3;

export function CategorizeAllSubscriptionsButton() {
  const [isPending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      try {
        const outcome = await categorizeAllSubscriptionsAction();
        const filed =
          outcome.filedCount === 0
            ? "Nothing left to file."
            : `Filed ${outcome.filedCount} row${outcome.filedCount === 1 ? "" : "s"} across ${outcome.merchantsFiled} merchant${outcome.merchantsFiled === 1 ? "" : "s"}.`;

        /* Each merchant's OWN sentence, never a generalization over them.
           This first said "each is filed under more than one category, or its
           key names no merchant" — which is false for the commonest case here:
           `loadSubscriptions` does not filter on `category_id`, so a merchant
           filed under exactly ONE category is on this list, and telling the user
           it spans several is the very lie the server-side wording was fixed to
           stop telling. The accurate per-merchant sentence already crossed the
           boundary on `refusal`; throwing it away to hand-write a summary was
           the mistake. */
        const notes: string[] = [
          ...describeSome(outcome.refusals.map((r) => r.refusal), "had no rule saved"),
          ...describeSome(outcome.retargets.map((r) => r.retargetedRule), "had an existing rule repointed"),
        ];
        if (outcome.warning !== undefined) notes.push(outcome.warning);
        if (outcome.failures.length > 0) {
          notes.push(
            `Failed for ${nameList(outcome.failures.map((f) => f.normalizedMerchant))}: ${outcome.failures[0].message}`,
          );
        }

        if (notes.length === 0) toast.success(filed);
        else if (outcome.failures.length > 0)
          toast.error(`${filed} ${notes.join(" ")}`, { duration: 15_000 });
        else toast.warning(`${filed} ${notes.join(" ")}`, { duration: 15_000 });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Categorize failed.");
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className={cn(BUTTON_CLASS, FOCUS_RING)}
    >
      {isPending ? "Filing…" : "Categorize all"}
    </button>
  );
}

/**
 * Up to `MAX_NAMED` of the server's own sentences, then a count for the rest.
 *
 * A toast has to end somewhere, but the cut is on how many sentences are shown —
 * never on replacing them with one summary of our own devising.
 */
function describeSome(
  sentences: readonly (string | null)[],
  tailVerb: string,
): string[] {
  const present = sentences.filter((s): s is string => s !== null);
  if (present.length === 0) return [];
  const shown = present.slice(0, MAX_NAMED);
  const rest = present.length - shown.length;
  return rest === 0
    ? shown
    : [...shown, `${rest} other merchant${rest === 1 ? "" : "s"} ${tailVerb}.`];
}

function nameList(names: readonly string[]): string {
  if (names.length <= MAX_NAMED) return names.join(", ");
  const shown = names.slice(0, MAX_NAMED).join(", ");
  return `${shown} and ${names.length - MAX_NAMED} more`;
}

/**
 * "Not a subscription" / "Restore", as a client island rather than a plain
 * `<form action={serverAction}>`.
 *
 * Both writes are idempotent, so there is nothing to report about the write
 * itself — but they revalidate after committing, and an unguarded throw there
 * used to render `/subscriptions/error.tsx`, whose copy denies that anything
 * was written. Guarded, the failure becomes a warning, and a warning needs a
 * channel: a dismissed row that is still on the list because the page could not
 * refresh is indistinguishable from a dismiss that never took.
 *
 * `mode` rather than the action itself as a prop: a server component may pass a
 * Server Action across the boundary, but this component picks its own so the
 * two labels and the two actions cannot drift apart.
 */
export function DismissSubscriptionButton({
  normalizedMerchant,
  mode,
}: {
  normalizedMerchant: string;
  mode: "dismiss" | "restore";
}) {
  const [isPending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("normalizedMerchant", normalizedMerchant);
      try {
        const action =
          mode === "dismiss" ? dismissSubscriptionAction : restoreSubscriptionAction;
        const { warning } = await action(formData);
        const done =
          mode === "dismiss"
            ? `Dismissed ${normalizedMerchant}.`
            : `Restored ${normalizedMerchant}.`;
        // One toast, same rule as above.
        if (warning === undefined) toast.success(done);
        else toast.warning(`${done} ${warning}`, { duration: 10_000 });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That didn't save.");
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className={cn(BUTTON_CLASS, FOCUS_RING)}
    >
      {isPending ? "Saving…" : mode === "dismiss" ? "Not a subscription" : "Restore"}
    </button>
  );
}
