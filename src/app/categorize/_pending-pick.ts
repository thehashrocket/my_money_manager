/**
 * T11/D19 — the unsaved category pick on a `/categorize` row, parked where it
 * survives leaving the page.
 *
 * The defect this closes: you choose "Gifts" for AMAZON, open the row to
 * check what those 53 charges actually were, follow "See all 53 transactions"
 * to be sure — and come back to an empty dropdown. `MerchantRow` holds the
 * pick in `useState`, and React state does not survive a route change unless
 * Next is preserving the tree; that preservation is gated on Cache Components,
 * which `next.config.ts` does not enable (verified against the bundled Next 16
 * docs — only `output: "standalone"` is set). So the page genuinely unmounts.
 * The interaction punished exactly the careful user: the one who checks before
 * submitting is the only one who loses anything.
 *
 * `sessionStorage`, not `localStorage`: a pick is a half-finished thought
 * inside one sitting, not a preference. Closing the tab should discard it.
 *
 * Every access is wrapped — Safari's private mode throws on `sessionStorage`
 * access rather than returning null, and a persistence convenience must never
 * be able to take down the page it is helping on.
 *
 * Exposed as a `useSyncExternalStore` source rather than read into `useState`
 * from an effect. That is not a style preference: reading it during render
 * would make the server HTML and the first client render disagree, and
 * writing it into state from an effect is a cascading render (and is what the
 * `react-hooks/set-state-in-effect` rule refuses). `getServerSnapshot`
 * returning `null` is what makes the hydration honest — the server genuinely
 * does not know about a parked pick.
 */
const PREFIX = "mm.categorize.pick.";

const listeners = new Set<() => void>();

/** Stable identity — `useSyncExternalStore` resubscribes when this changes. */
export function subscribePendingPicks(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** The hydration-safe snapshot: the server has no session storage to read. */
export function noPendingPick(): null {
  return null;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPendingPick(normalizedMerchant: string): string | null {
  try {
    return storage()?.getItem(PREFIX + normalizedMerchant) ?? null;
  } catch {
    return null;
  }
}

/**
 * Stores `""` rather than removing the key, so "I deliberately cleared this"
 * is a different fact from "I never picked anything". Removing it would let
 * the row fall back to its existing rule's category, silently undoing the
 * clear.
 */
export function writePendingPick(normalizedMerchant: string, categoryId: string): void {
  try {
    storage()?.setItem(PREFIX + normalizedMerchant, categoryId);
  } catch {
    // Quota or a locked-down browser — the pick simply won't survive a trip.
  }
  emit();
}

export function clearPendingPick(normalizedMerchant: string): void {
  try {
    storage()?.removeItem(PREFIX + normalizedMerchant);
  } catch {
    // See writePendingPick.
  }
  emit();
}

/**
 * Drop parked picks for merchants this page no longer lists.
 *
 * Without it a pick outlives the thing it was about: categorize AMAZON from
 * `/transactions` in another tab, come back, and a stale "Gifts" would be
 * restored onto whatever row reused that key — or linger invisibly forever
 * for a merchant that no longer has a backlog at all. The live group list is
 * the authority; anything not in it is finished business.
 */
export function prunePendingPicks(liveMerchants: readonly string[]): void {
  const store = storage();
  if (store === null) return;
  const live = new Set(liveMerchants);
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      if (!live.has(key.slice(PREFIX.length))) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
    if (stale.length > 0) emit();
  } catch {
    // See writePendingPick.
  }
}
