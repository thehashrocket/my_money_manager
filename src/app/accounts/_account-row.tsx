import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import type { AccountBalance } from "@/lib/accounts/loadAccountBalances";
import { resolveBalanceAction } from "@/lib/accounts/resolveBalanceAction";
import { resolveStalenessDisplay } from "@/lib/accounts/resolveStalenessDisplay";
import { formatMonthDay } from "@/lib/now";
import { resolveUtilizationDisplay } from "@/lib/accounts/resolveUtilizationDisplay";
import { formatCents, moneyToneClass } from "@/lib/money";
import type { LeafCategory } from "@/lib/categories";
import { RefreshButton, RevertBalanceButton } from "./_balance-forms";
import { CardControls } from "./_card-controls";

/**
 * One ruled row in the ASSETS or LIABILITIES list.
 *
 * DS49/DS60 — a ruled row, not a card, and no icon badge. A card whose whole
 * content is a name and a number is a `<div>` with a border tax, and the
 * circular tinted glyph every generated mockup put beside the name is
 * AI-slop blacklist item 3. This app's icon idiom is the Spine's bare
 * monochrome text glyphs; the account name already says "Checking".
 *
 * DS66 — accounting parens are SILENT to a screen reader. `($2,148.00)` is
 * read as "dollar two thousand one hundred forty eight" with the entire
 * meaning gone, so every liability figure carries an explicit aria-label.
 * The utilization bar is aria-hidden and the caption beside it is the
 * accessible value.
 */

export type AccountRowData = AccountBalance & {
  /** Null when uncomputable: a row-less account (the mortgage under D3=A). */
  paidDownCents: number | null;
  hasAnyRows: boolean;
};

export function AccountRow({
  account,
  today,
  categories = [],
  heading,
}: {
  account: AccountRowData;
  today: string;
  categories?: LeafCategory[];
  /** DS66's LONG-TERM label, rendered INSIDE this row's own <li>.
   *
   *  It used to be a sibling <li>, which put it in the parent's `divide-y`
   *  and drew a hairline both above the label AND between the label and the
   *  row it labels — so the mortgage read as detached from its own group and
   *  the label read as an empty ruled row. The mockup shows one rule above
   *  the group, with the label attached to what it groups. */
  heading?: string;
}) {
  const isLiability = account.class === "liability";
  const longTerm = isLongTermLiability(account.type);
  const staleness = resolveStalenessDisplay(account, new Date());
  const utilization = resolveUtilizationDisplay(account.balanceCents, account.creditLimitCents);
  const action = resolveBalanceAction(account, account.hasAnyRows);

  // Is there any date a hand-entered charge could legally carry? The window is
  // `startingBalanceDate < date <= today`, so it closes exactly when the anchor
  // has caught up to today. Derived here rather than inside the dialog because
  // it decides whether the affordance is OFFERED, not what it says once open.
  const chargeableDateExists = account.startingBalanceDate < today;

  const amountLabel = isLiability
    ? `owed ${formatCents(Math.abs(account.balanceCents))}`
    : undefined;

  return (
    <li className="px-4 py-3 sm:px-5">
      {heading ? (
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-ink-3">{heading}</h3>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span
          className={`font-display text-base ${longTerm ? "text-ink-3" : "text-ink-1"}`}
        >
          {account.name}
        </span>

        {/* DS59 — a mortgage is a fact about your life; a card balance is a
            problem you are solving. Rendered identically, the $302k sets the
            emotional register of a page whose real subject is the $2,148 you
            can act on this month. Muting is derived from the TYPE, never from
            the absence of a credit limit (E7). */}
        <span
          className={`font-mono text-lg [font-variant-numeric:tabular-nums] ${
            longTerm ? "text-ink-3" : moneyToneClass(account.balanceCents, {
              context: isLiability ? "liability" : "asset",
            })
          }`}
          aria-label={amountLabel}
        >
          {formatCents(account.balanceCents)}
        </span>
      </div>

      {utilization.hasLimit && account.creditLimitCents !== null ? (
        <div className="mt-2">
          {/* DS62 — always terracotta, no warn threshold. "Your utilization is
              high" is financial advice, and --accent-amber already carries
              eight distinct meanings in DESIGN.md's own inventory. */}
          <div
            aria-hidden
            className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]"
          >
            <div
              className="h-full rounded-full bg-terracotta"
              style={{ width: `${utilization.pct}%` }}
            />
          </div>
          <p className="mt-1 font-mono text-xs text-ink-3 [font-variant-numeric:tabular-nums]">
            {formatCents(Math.abs(account.balanceCents))} of{" "}
            {formatCents(account.creditLimitCents)}
          </p>
        </div>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        {account.minimumPaymentCents !== null ? (
          <span className="font-mono [font-variant-numeric:tabular-nums]">
            min. payment {formatCents(account.minimumPaymentCents)}
          </span>
        ) : null}
        <span
          className="font-mono"
          style={
            /* DS57 — amber past this source's threshold, reusing BacklogTile's
               color-mix formula rather than inventing a second one. */
            isLiability && staleness.isStale
              ? { color: "color-mix(in oklch, var(--accent-amber) 55%, var(--foreground))" }
              : undefined
          }
        >
          {isLiability ? staleness.label : `updated ${formatMonthDay(account.ledgerAsOfDate)}`}
        </span>
      </div>

      {/* DS58 — the app has to show debt MOVING, not just debt. D13=B
          correctly makes a payment invisible to every spend query, which
          leaves paying $500 with no acknowledgement anywhere. Omitted at $0
          (a $0.00 reads as a reproach) and at null (the mortgage's figure is
          uncomputable — it has no rows by D3=A — and a false $0 would be
          worse than silence). */}
      {account.paidDownCents !== null && account.paidDownCents > 0 ? (
        <p className="mt-1 font-mono text-xs text-ledger [font-variant-numeric:tabular-nums]">
          paid down {formatCents(account.paidDownCents)} this month
        </p>
      ) : null}

      {/* DS55 — exactly one BALANCE control, never both, never neither.
          
          The choice is made by `action` ALONE. It must not be ANDed with
          anything else: `resolveBalanceAction` is total over its inputs
          precisely so this stays true, and adding `&& !longTerm` here
          reintroduced E4's own failure one layer up — an unlinked loan (a car
          loan, say) resolves to "reconcile", was then excluded for being
          long-term, and rendered NEITHER control. Its balance was
          unreachable: `manualTransaction` refuses a loan (E17), and
          `/import`'s repair form excludes every liability (E18) while
          pointing the user at this page.
          
          `longTerm` gates the two CARD affordances instead — hand-entered
          charges and the card-terms form — and neither of those is the balance
          question: a mortgage takes no charges and has no credit limit (D3=A),
          but it still has a balance somebody may need to correct. This
          paragraph has now named the wrong number of gates twice — if a third
          card-only affordance appears, name it here too. */}
      {isLiability ? (
        <CardControls
          accountId={account.id}
          accountName={account.name}
          balanceCents={account.balanceCents}
          today={today}
          categories={categories}
          creditLimitCents={account.creditLimitCents}
          minimumPaymentCents={account.minimumPaymentCents}
          // OFFERED ONLY WHEN THE SERVER WILL ACCEPT IT. `createCardActivity`
          // refuses `date <= startingBalanceDate` and the dialog caps the date
          // at today, so on a feed-refreshed card whose anchor IS today the
          // legal date set is EMPTY — the button could only ever refuse.
          // `refreshLiabilityBalances` writes that anchor from the bank's own
          // balance-date, so it is the ordinary state on a sync day, not an
          // edge case. (When the feed's date lags, which is the common case on
          // the real ledger, the button appears and works.)
          //
          // This is the pattern rule 8 already established: v0.24.0's
          // `assignableKinds` work made the row menu's kind item appear exactly
          // when the server would accept it, because a refusal the user can
          // only discover by triggering it is worse than an absent control.
          // Card DETAILS stays available either way — it has no date to refuse.
          canAddCharge={!longTerm && chargeableDateExists}
          // NOT `canAddCharge`. Terms have no date to refuse, so the credit-limit
          // repair form must stay reachable on a card anchored today — that is
          // the half of the original deadlock that always mattered, and folding
          // it into the charge flag took it away again for one review cycle.
          canEditTerms={!longTerm}
          // DS55 IS INTACT: `action` still solely decides which balance control
          // renders, and it is relayed here rather than re-derived.
          //
          // What changed is that `CardControls` used to be mounted ONLY on the
          // `reconcile` branch, which silently gated two things that have
          // nothing to do with the balance control — "Add a charge" and the
          // card-terms form — on it. That deadlocked a feed-linked card:
          // `resolveBalanceAction` returns "refresh" while `hasAnyRows` is
          // false, so the row offered Refresh and nothing else, and the only
          // way to reach the charge form was to already have a row. A card
          // cannot get its first hand-entered charge, and a mistyped credit
          // limit cannot be repaired — which is the exact purpose rule 9 gives
          // that form — without unlinking the account from SimpleFIN first.
          //
          // The two questions were always separate; the DS55 block above has
          // said so since it was written. Only the nesting disagreed.
          showReconcile={action === "reconcile"}
        />
      ) : null}
      {isLiability && action === "refresh" ? (
        <div className="mt-2">
          <RefreshButton accountId={account.id} accountName={account.name} />
        </div>
      ) : null}

      {/* E19 — offered independently of the control above, because it answers
          a different question. `action` decides how you SET a balance; this
          appears whenever there is a previous one to go back to, which is
          exactly when the error boundary's "one step to reverse" promise is
          supposed to be true. Both a reconciled card and a feed-refreshed
          loan can have one. */}
      {isLiability && account.priorStartingBalanceDate !== null ? (
        <div className="mt-2">
          <RevertBalanceButton
            accountId={account.id}
            accountName={account.name}
            priorBalanceDate={account.priorStartingBalanceDate}
          />
        </div>
      ) : null}
    </li>
  );
}
