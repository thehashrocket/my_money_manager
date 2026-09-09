import type {
  AmbiguousBucket,
  CrossAccountBucket,
  SameAccountBucket,
} from "@/lib/simplefin/matchTransfers";
import type { TransferRow } from "@/lib/simplefin/sync";
import { formatCents } from "@/lib/money";
import { LINK_INTENT, REJECT_INTENT } from "@/lib/simplefin/validateSyncInputs";
import { ActionForm } from "./ActionForm";
import { PendingFieldset, SubmitButton } from "./_submit-button";
import { resolveSameAccountReversalAction, resolveTransferAction } from "./actions";

/**
 * One bucket of same-day, same-amount, opposite-sign rows that the app refuses
 * to pair on its own, rendered as a two-select form.
 *
 * Extracted when the same-account reversal queue landed (2026-09-08), because
 * that queue needs the identical form with different copy and a DIFFERENT
 * server action. Copying ~55 lines of JSX to change two strings is how the two
 * halves of a surface drift apart; this file is the one definition.
 *
 * `action` is DERIVED from `kind`, not passed in. It was a prop, with a
 * docblock arguing that this kept the two queues from reaching each other's
 * handler — which had it exactly backwards. A prop is what made the mismatch
 * expressible: `<ReviewQueue buckets={reversals} action={resolveTransferAction} />`
 * typechecked, and rendered a queue whose every button threw "A transfer pair
 * must span two different accounts." A lookup keyed on the discriminant is
 * what makes the two unable to cross. The bucket types are split for the same
 * reason (`CrossAccountBucket` / `SameAccountBucket`), so `kind` cannot
 * disagree with the rows either.
 *
 * A select with more than one candidate opens on "Choose…" rather than on an
 * arbitrary first row. Found by looking at the rendered page: the live
 * 2026-09-04 bucket offers 2 positives against 4 negatives, and the browser's
 * default selection paired `A2AXFER …reverse` with an unrelated `Instant Pay
 * ID:` row — a plausible-looking WRONG link, one click away, on a surface
 * whose entire premise is that a human decides each one. `required` then
 * blocks submission until both halves are picked. A single-candidate select
 * keeps its default, because there is no choice to make and the placeholder
 * would be pure friction on 12 of today's 14 buckets.
 */
/**
 * The two queues, defined once. `title` feeds both the heading here and the
 * "also listed under" cross-reference in the OTHER queue, so the two can never
 * name each other wrongly — previously `alsoIn.queue` was free text
 * hand-copied at both call sites.
 */
const QUEUES = {
  transfer: {
    title: "Transfers needing review",
    blurb:
      "Same day, same amount, opposite signs, but not auto-linked — see each item below for why. Pick the two halves of each transfer, or leave it if it isn't actually one.",
    action: resolveTransferAction,
    other: "reversal",
  },
  reversal: {
    title: "Reversals needing review",
    blurb:
      "A charge and its cancellation on ONE account — a reversed transfer, a disputed charge with a provisional credit, or a returned payment. No matcher can pair these automatically, because the same shape also turns up as pure coincidence (an unrelated refund that happens to match a real charge to the cent, on the same day). Link them only if they are genuinely two halves of one movement; a merchandise refund is NOT one, and already nets against spending on its own.",
    action: resolveSameAccountReversalAction,
    other: "transfer",
  },
} as const;

export type ReviewQueueKind = keyof typeof QUEUES;

type ReviewQueueProps = {
  accountsById: ReadonlyMap<number, { name: string }>;
  /**
   * Row ids this queue shares with the other one (see `overlappingRowIds`).
   * The overlap is a real ambiguity rather than a bucketing bug, so neither
   * queue hides it — but a user must not act in one place without knowing the
   * other reading exists.
   */
  sharedRowIds?: ReadonlySet<number>;
} & (
  | { kind: "transfer"; buckets: CrossAccountBucket<TransferRow>[] }
  | { kind: "reversal"; buckets: SameAccountBucket<TransferRow>[] }
);

export function ReviewQueue({
  kind,
  buckets,
  accountsById,
  sharedRowIds,
}: ReviewQueueProps) {
  const { blurb, action, other } = QUEUES[kind];
  const title = `${QUEUES[kind].title} (${buckets.length})`;
  const headingId = `review-queue-${slug(title)}`;

  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="font-mono text-xs uppercase tracking-wide text-muted-foreground"
      >
        {title}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">{blurb}</p>
      {buckets.map((bucket) => {
        const bucketKey = `${bucket.reason}-${bucket.date}-${bucket.absAmountCents}-${bucket.positives[0]?.id}`;
        // Names the form after the one line that distinguishes it from every
        // other form in the queue. Deterministic rather than `useId()` because
        // this renders on the server.
        const bucketLabelId = `bucket-${bucketKey}`;
        const overlaps =
          sharedRowIds !== undefined &&
          [...bucket.positives, ...bucket.negatives].some((r) =>
            sharedRowIds.has(r.id),
          );
        return (
          <ActionForm
            key={bucketKey}
            action={action}
            ariaLabelledBy={bucketLabelId}
            // This card is gone from the list the moment it succeeds, so its
            // confirmation has to be published somewhere that outlives it —
            // otherwise "Link as reversal" and "Not a reversal" are visually
            // identical outcomes on a one-candidate bucket.
            announceSuccess
            className="space-y-3 rounded-md border border-border p-4"
          >
            {/*
              Everything the form SUBMITS lives inside the fieldset, so one
              `disabled` freezes the two selects along with both buttons while
              the action is in flight. `ActionStatus` stays outside it (it is
              `ActionForm`'s own last child) — greying out the message that
              explains a refusal would be the opposite of the point.
            */}
            <PendingFieldset className="space-y-3">
              <p
                id={bucketLabelId}
                className="font-mono text-sm font-medium [font-variant-numeric:tabular-nums]"
              >
                {bucket.date} · {formatCents(bucket.absAmountCents)}
                {bucket.reason === "same-account" && (
                  <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                    {accountsById.get(bucket.accountId)?.name ?? bucket.accountId}
                  </span>
                )}
              </p>
              <p className="max-w-prose text-sm text-muted-foreground">
                {explain(bucket.reason)}
              </p>
              {overlaps && (
                <p
                  className="max-w-prose rounded-md border p-2 text-sm"
                  style={{
                    background:
                      "color-mix(in oklch, var(--accent-amber) 18%, var(--background))",
                    borderColor:
                      "color-mix(in oklch, var(--accent-amber) 45%, transparent)",
                  }}
                >
                  Also listed under <strong>{QUEUES[other].title}</strong>. Same
                  rows, two readings — the money can only be paired once, so{" "}
                  <strong>linking</strong> it in either place removes it from
                  both. Saying it is <em>not</em> a pair only answers this
                  reading; the other one stays. Check there before deciding here.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className={LABEL}>{sideLabel(bucket.reason, "positive")}</span>
                  <select
                    name="aId"
                    required
                    defaultValue={bucket.positives.length > 1 ? "" : undefined}
                    className={SELECT}
                  >
                    {bucket.positives.length > 1 && <option value="">Choose…</option>}
                    {bucket.positives.map((p) => (
                      <option key={p.id} value={p.id}>
                        {optionLabel(bucket.reason, p, accountsById)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className={LABEL}>{sideLabel(bucket.reason, "negative")}</span>
                  <select
                    name="bId"
                    required
                    defaultValue={bucket.negatives.length > 1 ? "" : undefined}
                    className={SELECT}
                  >
                    {bucket.negatives.length > 1 && <option value="">Choose…</option>}
                    {bucket.negatives.map((n) => (
                      <option key={n.id} value={n.id}>
                        {optionLabel(bucket.reason, n, accountsById)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <SubmitButton
                  label={SUBMIT[bucket.reason].idle}
                  busyLabel={SUBMIT[bucket.reason].busy}
                  // Names itself even though it is the DEFAULT submitter, so
                  // that "the user pressed Link" and "the submitter's field
                  // was lost" stop being the same bytes on the wire. The
                  // reversal schema requires `intent`, so a dropped field is
                  // a refusal rather than a silent link — see
                  // `resolveReversalInputSchema`. The cross-account queue
                  // posts to an action whose schema has no `intent`, and a
                  // non-strict `z.object` drops the extra key.
                  intent={LINK_INTENT}
                  className="min-h-11 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
                />
                {/*
                  A review queue has to be able to say no. Without this the only
                  route to a durable rejection was to CREATE the link you were
                  rejecting and then undo it — and between those two clicks both
                  rows leave every spending surface. `name`/`value` on the button
                  means the intent rides along only when this button is the one
                  that submitted; the primary carries `LINK_INTENT` for the same
                  reason, so neither branch is reachable by omission.

                  Same-account only for now: the cross-account queue's buckets are
                  resolved by linking the right pair rather than by dismissing the
                  bucket, and a "rejected" bucket there already has its own
                  "Link as transfer anyway" affordance.
                */}
                {bucket.reason === "same-account" && (
                  <SubmitButton
                    label="Not a reversal"
                    // "Recording…", not "Rejecting…": the durable thing being
                    // written is a `transfer_pair_rejections` row, and the copy
                    // has to differ from the link button's "Linking…" or the two
                    // buttons read identically at the one moment they most need
                    // to be told apart.
                    busyLabel="Recording…"
                    intent={REJECT_INTENT}
                    className="min-h-11 rounded-md px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  />
                )}
              </div>
            </PendingFieldset>
          </ActionForm>
        );
      })}
    </section>
  );
}

/** Matches the form-label treatment used by every other form in the app. */
const LABEL = "mb-1 block font-mono text-xs uppercase tracking-wide text-ink-3";

// text-base rather than the inherited text-sm: the option text IS the decision
// here, not a secondary detail, and 13px triggers zoom-on-focus on iOS.
const SELECT =
  "w-full rounded-md border border-border bg-transparent px-3 py-2 text-base";

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * "Money in" / "Money out" describe a transfer, where the money really does
 * leave one account and arrive in another. On a same-account reversal nothing
 * moves anywhere, so the direction words are actively wrong — the two rows are
 * a charge and the credit that cancels it.
 */
function sideLabel(
  reason: AmbiguousBucket<TransferRow>["reason"],
  side: "positive" | "negative",
): string {
  if (reason === "same-account") {
    return side === "positive" ? "The credit (reversal)" : "The original charge";
  }
  return side === "positive" ? "Money in" : "Money out";
}

function explain(reason: AmbiguousBucket<TransferRow>["reason"]): string {
  switch (reason) {
    case "rejected":
      return "You previously marked this pairing “not a transfer.” It stays here in case a different match ever shows up on this date and amount — link it below only if you've changed your mind.";
    case "contested":
      return "This date and amount has candidates in more than one other account, so which one it moved to is ambiguous.";
    case "cross-source":
      return "One of these rows was already examined for a Star One transaction-number match and declined, so this same-day/same-amount coincidence isn't enough on its own to auto-link.";
    case "same-account":
      // Both legs sit on one account, so nothing "moved between accounts" and
      // no counting argument applies. The memos are the only evidence, and
      // they are exactly what the matchers are built to ignore (rule 4).
      return "Both rows are on the same account, so this is a charge and its cancellation rather than a transfer between accounts. Nothing can decide it automatically — compare the two descriptions below.";
    default:
      return "The counts don't balance, so which row pairs with which changes the budget.";
  }
}

/**
 * Elide the MIDDLE, never the tail.
 *
 * Every candidate in a bucket shares a date and a magnitude by construction, so
 * the memo is the entire basis for the decision — and for a same-account bucket
 * the distinguishing token is almost always a SUFFIX: `…Ref# 64590 reverse`,
 * `Reversal ID: …`, `Provisional Credit …`, `TO`/`FRM`. A plain head-truncation
 * deletes precisely the evidence (`sameAccountReversals.ts` lists the tokens),
 * and worse, two rows sharing a long common prefix — which is the normal shape
 * for a transfer and its reversal — then render as byte-identical options with
 * nothing left to tell them apart.
 */
function elide(text: string, max: number): string {
  if (text.length <= max) return text;
  // Bias toward the tail: it carries the verb, the head carries the shared
  // protocol prefix.
  const tail = Math.max(1, Math.floor((max - 1) * 0.45));
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * For a same-account bucket every row shares one account, so printing the
 * account name on each option is noise that pushes the memo — the ONLY thing
 * distinguishing the candidates — out of the visible width.
 *
 * `raw_memo` is NOT NULL but IS allowed to be blank (a blank Memo cell survives
 * import), so an empty label is reachable. Dropping the account name for the
 * same-account case removed the only other text on the option, which would
 * leave the user confirming a money-moving link against a nameless row — hence
 * the id fallback.
 */
function optionLabel(
  reason: AmbiguousBucket<TransferRow>["reason"],
  row: TransferRow,
  accountsById: ReadonlyMap<number, { name: string }>,
): string {
  const memo = row.rawMemo.trim();
  if (reason === "same-account") {
    return memo ? elide(memo, 56) : `(no description) · #${row.id}`;
  }
  const account = accountsById.get(row.accountId)?.name ?? String(row.accountId);
  const label = memo ? elide(memo, 44) : `(no description) · #${row.id}`;
  return `${account} — ${label}`;
}

/**
 * The primary button's copy, idle and in flight, per bucket reason.
 *
 * A `Record` over the closed union rather than the if-chain with a `default`
 * this replaces: the fallback made a MISSING case indistinguishable from a
 * deliberate one, so a sixth `reason` would have shipped reading "Link as
 * transfer" — and, once the busy half existed, with no busy label at all.
 * Written out per reason, including the three that share a string, because the
 * point is that tsc forces a decision for each rather than letting one slip
 * through the bottom.
 */
const SUBMIT: Record<
  AmbiguousBucket<TransferRow>["reason"],
  { idle: string; busy: string }
> = {
  contested: { idle: "Link as transfer", busy: "Linking…" },
  unbalanced: { idle: "Link as transfer", busy: "Linking…" },
  "cross-source": { idle: "Link as transfer", busy: "Linking…" },
  rejected: { idle: "Link as transfer anyway", busy: "Linking…" },
  "same-account": { idle: "Link as reversal", busy: "Linking…" },
};
