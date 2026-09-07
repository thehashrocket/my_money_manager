import { isLongTermLiability } from "@/lib/accounts/isLongTermLiability";
import type { AccountBalance } from "@/lib/accounts/loadAccountBalances";
import { resolveBalanceAction } from "@/lib/accounts/resolveBalanceAction";
import { resolveStalenessDisplay } from "@/lib/accounts/resolveStalenessDisplay";
import { formatMonthDay } from "@/lib/now";
import { resolveUtilizationDisplay } from "@/lib/accounts/resolveUtilizationDisplay";
import { formatCents, moneyToneClass } from "@/lib/money";
import type { LeafCategory } from "@/lib/categories";
import { RefreshButton } from "./_balance-forms";
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
}: {
  account: AccountRowData;
  today: string;
  categories?: LeafCategory[];
}) {
  const isLiability = account.class === "liability";
  const longTerm = isLongTermLiability(account.type);
  const staleness = resolveStalenessDisplay(account, new Date());
  const utilization = resolveUtilizationDisplay(account.balanceCents, account.creditLimitCents);
  const action = resolveBalanceAction(account, account.hasAnyRows);

  const amountLabel = isLiability
    ? `owed ${formatCents(Math.abs(account.balanceCents))}`
    : undefined;

  return (
    <li className="px-4 py-3 sm:px-5">
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
          
          `longTerm` gates only the CHARGE affordance, which is a genuinely
          separate question — a mortgage takes no hand-entered charges (D3=A),
          but it still has a balance somebody may need to correct. */}
      {isLiability && action === "reconcile" ? (
        <CardControls
          accountId={account.id}
          accountName={account.name}
          balanceCents={account.balanceCents}
          today={today}
          categories={categories}
          canAddCharge={!longTerm}
        />
      ) : null}
      {isLiability && action === "refresh" ? (
        <div className="mt-2">
          <RefreshButton accountId={account.id} accountName={account.name} />
        </div>
      ) : null}
    </li>
  );
}
