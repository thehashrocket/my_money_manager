"use client";

import type { ChangeEvent } from "react";
import type { RememberUi } from "@/lib/categorize/keyTrainability";

type Props = {
  rememberUi: RememberUi;
  /** `remember.checked` from `useRememberConsent` — a MASK, not the raw
      click state. See that hook's own docstring for why. */
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Must match the `id` on the reason `<p>` the caller renders, so the
      checkbox's accessible description resolves. */
  reasonId: string;
  /** DS66's 44px touch floor. `/categorize`'s row is the only one of the
      three call sites that supplies it (`min-h-11`, reproduced here exactly
      as before this extraction). Red-team review (ship pass, 2026-09-16)
      found neither `_transaction-row.tsx` nor `_retarget-form.tsx` gives this
      checkbox a 44px tap target either — this is a pre-existing DS66 gap on
      both, not a regression this extraction introduced, and not fixed here.
      Defaults to false rather than being unconditional so a future caller
      opts in deliberately instead of inheriting a floor most call sites
      don't actually have yet. See TODOS.md. */
  minTouchTarget?: boolean;
};

/**
 * The "Remember" checkbox itself — disabled state, label text, and the
 * `title`/`aria-describedby` wiring onto a {@link RememberUi} — shared by
 * `/categorize`'s `_merchant-row.tsx`, `/transactions`' `_transaction-row.tsx`
 * and `_retarget-form.tsx` (maintainability review, ship pass, 2026-09-16).
 *
 * The three copies had already drifted once before this existed
 * (`resolveRememberUi`/`useRememberConsent` themselves exist for the same
 * reason, one layer down) — this is the render half of that consolidation,
 * covering exactly the sub-tree that was byte-identical across all three:
 * the checkbox `<input>` and its wrapping `<label>`. The reason `<p>` below
 * it is deliberately NOT included here — its layout genuinely differs per
 * caller (a flex-wrap sibling needing `basis-full` on two of the three
 * surfaces, a plain block on the third), which is a real difference in
 * context, not drift, so each caller still renders its own.
 */
export function RememberCheckbox({
  rememberUi,
  checked,
  onChange,
  reasonId,
  minTouchTarget = false,
}: Props) {
  return (
    <label
      className={`flex items-center gap-1.5 text-xs ${minTouchTarget ? "min-h-11 " : ""}${
        rememberUi.enabled ? "text-ink-2" : "cursor-not-allowed text-ink-3"
      }`}
      title={rememberUi.message}
    >
      <input
        type="checkbox"
        name="rememberMerchant"
        value="true"
        checked={checked}
        disabled={!rememberUi.enabled}
        aria-describedby={rememberUi.message === undefined ? undefined : reasonId}
        onChange={onChange}
        className="h-4 w-4 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {rememberUi.label}
    </label>
  );
}
