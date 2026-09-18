"use client";

import { useActionState } from "react";
import { syncNowAction, type SyncActionState } from "./actions";
import { ActionStatus } from "./ActionForm";
import { useStatusResetOnHide } from "@/components/ledger/use-status-reset-on-hide";

const INITIAL: SyncActionState = { status: "idle" };

export function SyncButton({ disabled }: { disabled?: boolean }) {
  const [state, formAction, pending] = useActionState(
    async () => syncNowAction(),
    INITIAL,
  );
  // Found live while verifying the red-team fix on `_action-feedback.tsx`
  // (cache-components-migration, pre-landing review) — this button's OWN
  // `useActionState` result has the identical gap on a sibling component the
  // red-team pass didn't separately name: no reset-on-hide, rendered
  // unconditionally. Without this, running a sync, leaving `/sync`, and
  // coming back would show the previous sync's "Already up to date" or
  // warning text as if it were current.
  const shownState = useStatusResetOnHide(state, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <button
        type="submit"
        disabled={disabled || pending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>

      {/* Renders the warnings too: SimpleFIN reports a broken bank connection
          in `errors[]` on an HTTP 200, so without these a dead connection looks
          exactly like a clean "already up to date". */}
      <ActionStatus state={shownState} />
    </form>
  );
}
