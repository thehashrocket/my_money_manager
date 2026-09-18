"use client";

import { useState, type ChangeEvent } from "react";
import { ruleActionSignature, type RuleAction } from "@/lib/categorize/keyTrainability";

/**
 * The "Remember" checkbox's consent state, shared by `_merchant-row.tsx`
 * (`/categorize`) and `_transaction-row.tsx` (`/transactions`) — the mask
 * expression and the `onChange` handler were the last verbatim-identical
 * pair left in either component after `resolveRememberUi` (`keyTrainability.ts`)
 * absorbed the verdict derivation itself (maintainability review finding,
 * same pass that produced `resolveRememberUi`).
 *
 * `consentedSignature` stays PER-CALL — this hook's own `useState`, not a
 * module-level or externally shared store — so each row still gets its own
 * independent consent, exactly as it did with the two components' own local
 * state. Only the CODE that manages it is shared; nothing about the state
 * itself becomes cross-component. `resolveRememberUi`'s own docstring
 * explains why `consentedSignature` can't be folded into that function: it
 * is React state, not a pure derivation, which is why it lives here instead
 * of in `keyTrainability.ts` (a zero-runtime-import module read by server
 * code too — see that file's own module docstring).
 *
 * INVALIDATES on mismatch — does NOT merely mask it. The first version of
 * this hook only compared `consentedSignature === currentSignature` for
 * `checked` and never cleared the stored value on its own, which a Codex
 * structured review AND an independent Codex adversarial pass both
 * reproduced as a real, no-special-input-needed bug: tick "Remove
 * conflicting rule" against existing category 9, repick to 9 itself (action
 * becomes `none`, box correctly hides), then repick to a DIFFERENT
 * category still contradicting the rule — the signature matches the
 * ORIGINAL consent again, so the box silently RE-CHECKS with no new click,
 * and submitting deletes the rule on a consent gesture the user made against
 * a state that no longer exists. The fix clears `consentedSignature` the
 * instant it stops matching the current signature (the "adjust state during
 * render" pattern `_transaction-row.tsx`'s own `prevRow` block already uses
 * elsewhere in this codebase) — so a later return to the same signature has
 * nothing stored left to match against, and consent must be re-given.
 *
 * `pendingCategoryId` and `normalizedMerchant` are REQUIRED arguments, not
 * optional context — `ruleActionSignature` needs the pick to tell two
 * different "train" targets apart (a `bulkRetarget` on an unrelated form
 * silently resyncing this row's picker to a new category, with the old
 * "train" consent surviving because a bare `"train"` signature never
 * changed) and needs the merchant to tell two different WRITES apart (a
 * second review pass found `pnpm db:backfill-merchants` renaming a row's
 * `normalized_merchant` in place, with `_transaction-row.tsx`'s
 * transaction-id-keyed component surviving the rename and carrying stale
 * consent to the new merchant) — see that function's own docstring for both
 * exact reproductions. Passing both through here rather than computing them
 * internally keeps this hook agnostic to where the pick lives — plain
 * component state on both `/categorize` and `/transactions` as of the
 * cache-components-migration plan (Stage 2 deleted `/categorize`'s
 * `sessionStorage`-backed version; Activity now preserves component state
 * across navigation without it).
 */
export function useRememberConsent(
  normalizedMerchant: string,
  action: RuleAction,
  pendingCategoryId: number | null,
): {
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  reset: () => void;
} {
  const [consentedSignature, setConsentedSignature] = useState<string | null>(null);
  const currentSignature = ruleActionSignature(normalizedMerchant, action, pendingCategoryId);
  if (consentedSignature !== null && consentedSignature !== currentSignature) {
    setConsentedSignature(null);
  }
  return {
    checked: consentedSignature !== null && consentedSignature === currentSignature,
    onChange: (event) => {
      setConsentedSignature(event.target.checked ? currentSignature : null);
    },
    reset: () => setConsentedSignature(null),
  };
}
