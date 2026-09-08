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

/**
 * The picks, in memory. `sessionStorage` is the DURABILITY layer; this is the
 * source of truth for reads.
 *
 * Two things go wrong when storage is read directly on every render. First,
 * a browser that throws on `sessionStorage` (Safari private mode, Chrome with
 * "block all site data") stops being a lost-persistence problem and becomes a
 * broken picker: with nothing else holding the value, `readPendingPick` keeps
 * returning `null`, the controlled combobox never shows what you chose, and
 * Submit — `disabled={... || !categoryId}` — stays greyed out forever. The
 * comment above promises this degrades to "won't survive a trip"; without a
 * cache it degrades to "cannot pick a category at all".
 *
 * Second, `emit()` is a broadcast and every row subscribes, so on the real
 * ledger one pick used to cost ~181 synchronous `getItem` calls on the main
 * thread. Now it costs one `Map` lookup per row.
 */
const cache = new Map<string, string>();

/**
 * Storage failures are survivable by design — `cache` is the read source of
 * truth, so the picker keeps working — but they are not nothing: on a full
 * reload every parked pick is gone, which is the exact defect D19 exists to
 * close. Warning once (not per call: `prunePendingPicks` can attempt ~181
 * `removeItem`s in a single pass, and `hydrate()` walks the whole store) leaves
 * a trace that makes "my picks keep vanishing" answerable instead of a
 * mystery, without turning a locked-down browser into a wall of console noise.
 */
let warnedAboutStorage = false;
function warnStorageUnavailable(err: unknown): void {
  if (warnedAboutStorage) return;
  warnedAboutStorage = true;
  console.warn(
    "[pending-pick] sessionStorage unavailable — category picks will not survive a reload",
    err,
  );
}

/**
 * `sessionStorage` is read once, lazily, into `cache` — not per read. Runs on
 * the client only; `storage()` returns null during SSR.
 *
 * Keyed on the Storage INSTANCE rather than a boolean: the cache mirrors one
 * store, so a different store means a different set of picks and the cache
 * has to be rebuilt rather than carried over. In the browser that never
 * happens; in the test environment each case installs its own fake, and a
 * bare `hydrated` flag would have leaked one test's picks into the next.
 */
let hydratedFrom: Storage | null = null;
function hydrate(): void {
  const store = storage();
  if (store === null || store === hydratedFrom) return;
  hydratedFrom = store;
  cache.clear();
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const value = store.getItem(key);
      if (value !== null) cache.set(key.slice(PREFIX.length), value);
    }
  } catch (err) {
    // A locked-down browser leaves the cache empty, which is the correct
    // "nothing parked yet" answer — but it is also indistinguishable from a
    // genuinely empty store, so say so once.
    warnStorageUnavailable(err);
  }
}

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
  if (typeof window === "undefined") return null;
  hydrate();
  return cache.get(normalizedMerchant) ?? null;
}

/**
 * Stores `""` rather than removing the key, so "I deliberately cleared this"
 * is a different fact from "I never picked anything". Removing it would let
 * the row fall back to its existing rule's category, silently undoing the
 * clear.
 */
export function writePendingPick(normalizedMerchant: string, categoryId: string): void {
  // Never on the server: module scope is shared across requests there, so a
  // cached pick would be one user's half-finished thought leaking into the
  // next render. There is also nothing to park — the page is about to unmount.
  if (typeof window === "undefined") return;
  hydrate();
  cache.set(normalizedMerchant, categoryId);
  try {
    storage()?.setItem(PREFIX + normalizedMerchant, categoryId);
  } catch (err) {
    // Quota or a locked-down browser — the pick simply won't survive a trip.
    // It still shows in the field, because `cache` was already set above.
    // The ordering is load-bearing: writing the cache AFTER storage would
    // make a throwing `setItem` skip it and leave the picker inoperable, the
    // very bug this module was written to fix.
    warnStorageUnavailable(err);
  }
  emit();
}

export function clearPendingPick(normalizedMerchant: string): void {
  if (typeof window === "undefined") return;
  hydrate();
  cache.delete(normalizedMerchant);
  try {
    storage()?.removeItem(PREFIX + normalizedMerchant);
  } catch (err) {
    // See writePendingPick.
    warnStorageUnavailable(err);
  }
  emit();
}

/**
 * Drop parked picks for merchants this page no longer lists.
 *
 * Without it a pick outlives the thing it was about: park "Gifts" on AMAZON,
 * drill into `/transactions`, file the whole group from there, and the
 * `revalidatePath("/categorize")` that follows drops AMAZON from the server's
 * group list — but the stale "Gifts" would be restored onto whatever row
 * reused that key, or linger invisibly forever for a merchant with no backlog
 * left. The live group list is the authority; anything not in it is finished
 * business.
 *
 * The trigger is a fresh `initialGroups` (`_categorize-ui.tsx`'s effect), so
 * this covers navigation and revalidation, NOT a second browser tab: picks
 * live in `sessionStorage`, which is per-tab, and switching tabs is not a
 * navigation — nothing refetches, so nothing prunes.
 */
export function prunePendingPicks(liveMerchants: readonly string[]): void {
  if (typeof window === "undefined") return;
  hydrate();
  const live = new Set(liveMerchants);
  // Collected first, then removed: mutating `cache` while iterating its own
  // keys is the same hazard the storage-index walk had.
  const stale = [...cache.keys()].filter((merchant) => !live.has(merchant));
  if (stale.length === 0) return;
  const store = storage();
  for (const merchant of stale) {
    cache.delete(merchant);
    try {
      store?.removeItem(PREFIX + merchant);
    } catch (err) {
      // See writePendingPick.
      warnStorageUnavailable(err);
    }
  }
  emit();
}
