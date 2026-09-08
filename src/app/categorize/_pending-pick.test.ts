import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingPick,
  noPendingPick,
  prunePendingPicks,
  readPendingPick,
  subscribePendingPicks,
  writePendingPick,
} from "./_pending-pick";

/**
 * T11/D19 — the parked `/categorize` pick.
 *
 * This module is a plain `.ts` store, not a component, so it is inside the
 * testable surface (same precedent as `_filter-bar.test.ts`). It is also the
 * only place in the feature where a browser API can *throw* rather than
 * return a falsy value — Safari's private mode throws on `sessionStorage`
 * access — and the whole point of the wrapping is that a persistence
 * convenience must never take down the page it is helping on. That guarantee
 * is only real if something exercises the throwing path.
 *
 * `vitest.config.mts` is `environment: "node"`, so there is no `window` here
 * by default. That is not a limitation to work around — it IS the server
 * render, and the first test pins it.
 */
class FakeStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }

  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }

  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }

  removeItem(k: string): void {
    this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Safari private mode: touching `window.sessionStorage` throws outright. */
const THROWING_WINDOW = {
  get sessionStorage(): Storage {
    throw new Error("SecurityError: sessionStorage is not available");
  },
};

/**
 * The OTHER shape of storage failure, and the one `THROWING_WINDOW` cannot
 * reach: a store that hands back a perfectly good `Storage` object whose
 * writes throw. Chrome's "block all site data" does this, and so does a full
 * quota (`QuotaExceededError`).
 *
 * It matters because `THROWING_WINDOW` fails at the getter, so `storage()`
 * returns `null` and every `storage()?.setItem(...)` short-circuits before
 * the `try` body — leaving the inner `catch` blocks, which are the actual
 * failure handling, never executed. Without this fake, reordering
 * `writePendingPick` to write storage BEFORE the cache would reintroduce the
 * inoperable-picker bug this module exists to prevent, and every existing
 * test would still pass.
 */
class WriteThrowingStorage extends FakeStorage {
  override setItem(): never {
    throw new Error("QuotaExceededError");
  }

  override removeItem(): never {
    throw new Error("QuotaExceededError");
  }
}

let store: FakeStorage;

function stubBrowser(): void {
  store = new FakeStorage();
  vi.stubGlobal("window", { sessionStorage: store });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("_pending-pick — no browser (the server render)", () => {
  it("noPendingPick is the hydration-honest snapshot", () => {
    expect(noPendingPick()).toBeNull();
  });

  it("reads null and neither writes nor prunes throw without a window", () => {
    expect(readPendingPick("AMAZON")).toBeNull();
    expect(() => writePendingPick("AMAZON", "7")).not.toThrow();
    expect(() => clearPendingPick("AMAZON")).not.toThrow();
    expect(() => prunePendingPicks(["AMAZON"])).not.toThrow();
  });
});

describe("_pending-pick — round trip", () => {
  beforeEach(stubBrowser);

  it("stores a pick under a namespaced key and reads it back", () => {
    writePendingPick("AMAZON", "7");
    expect(readPendingPick("AMAZON")).toBe("7");
    expect(store.getItem("mm.categorize.pick.AMAZON")).toBe("7");
  });

  it("returns null for a merchant that was never picked", () => {
    writePendingPick("AMAZON", "7");
    expect(readPendingPick("SAFEWAY")).toBeNull();
  });

  it('distinguishes a deliberate clear ("") from never having picked (null)', () => {
    // Storing "" rather than removing the key is what stops the row falling
    // back to its existing rule's category and silently undoing the clear.
    writePendingPick("AMAZON", "");
    expect(readPendingPick("AMAZON")).toBe("");
    expect(readPendingPick("AMAZON")).not.toBeNull();
  });

  it("clearPendingPick removes the key entirely", () => {
    writePendingPick("AMAZON", "7");
    clearPendingPick("AMAZON");
    expect(readPendingPick("AMAZON")).toBeNull();
    expect(store.getItem("mm.categorize.pick.AMAZON")).toBeNull();
  });

  it("keeps URL-hostile merchant keys distinct rather than colliding", () => {
    writePendingPick("GASCO#00000ANYTWN", "3");
    writePendingPick("GASCO", "9");
    expect(readPendingPick("GASCO#00000ANYTWN")).toBe("3");
    expect(readPendingPick("GASCO")).toBe("9");
  });
});

describe("_pending-pick — subscribers", () => {
  beforeEach(stubBrowser);

  it("notifies on write and on clear, and stops after unsubscribe", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribePendingPicks(onChange);

    writePendingPick("AMAZON", "7");
    expect(onChange).toHaveBeenCalledTimes(1);

    clearPendingPick("AMAZON");
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    writePendingPick("AMAZON", "9");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("_pending-pick — prune", () => {
  beforeEach(stubBrowser);

  it("drops picks for merchants the page no longer lists, keeping the live ones", () => {
    writePendingPick("AMAZON", "7");
    writePendingPick("SAFEWAY", "3");
    writePendingPick("SHELL", "9");

    prunePendingPicks(["AMAZON", "SHELL"]);

    expect(readPendingPick("AMAZON")).toBe("7");
    expect(readPendingPick("SHELL")).toBe("9");
    expect(readPendingPick("SAFEWAY")).toBeNull();
  });

  it("never touches keys belonging to anything else in sessionStorage", () => {
    store.setItem("unrelated.app.key", "keep me");
    writePendingPick("AMAZON", "7");

    prunePendingPicks([]);

    expect(store.getItem("unrelated.app.key")).toBe("keep me");
    expect(readPendingPick("AMAZON")).toBeNull();
  });

  it("notifies only when it actually removed something", () => {
    writePendingPick("AMAZON", "7");
    const onChange = vi.fn();
    // The listener set is module scope; leaving a subscriber behind makes
    // every later test in this file emit into a stale mock.
    const unsubscribe = subscribePendingPicks(onChange);

    try {
      prunePendingPicks(["AMAZON"]);
      expect(onChange).not.toHaveBeenCalled();

      prunePendingPicks([]);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("removes every stale key, not every other one — mutation during iteration", () => {
    // The two-pass shape (collect, then remove) matters: removing inside the
    // `store.key(i)` loop shifts the indices and silently leaves half behind.
    for (const merchant of ["A", "B", "C", "D", "E", "F"]) {
      writePendingPick(merchant, "1");
    }
    prunePendingPicks([]);
    expect(store.length).toBe(0);
  });
});

/**
 * This block re-imports the module per test instead of using the file's
 * static imports, and that is load-bearing rather than stylistic.
 *
 * `cache` and `hydratedFrom` are module scope — deliberately, that is what
 * makes one pick cost a `Map` lookup instead of ~181 `getItem` calls — so a
 * statically-imported module carries whatever earlier tests left in it.
 * Everywhere else that does not matter, because `hydrate()` clears the cache
 * when it adopts a new store. Here it cannot: `THROWING_WINDOW` fails at the
 * `sessionStorage` getter, so `storage()` returns `null` and `hydrate()`
 * returns BEFORE `cache.clear()`. A pick written by any earlier test then
 * survives into the first assertion below, which reads `null`.
 *
 * That is not hypothetical. With the static imports, `vitest run
 * --sequence.shuffle=true` on this file failed 2 runs in 5 on
 * "degrades to no persistence" — the suite passed only because the default
 * file order happened to be kind. The `import.meta.glob`-free dynamic import
 * matches what the two `resetModules` tests further down already do.
 */
describe("_pending-pick — a storage that throws (Safari private mode)", () => {
  let mod: typeof import("./_pending-pick");

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("window", THROWING_WINDOW);
    mod = await import("./_pending-pick");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("degrades to no persistence instead of taking the page down", () => {
    expect(mod.readPendingPick("AMAZON")).toBeNull();
    expect(() => mod.writePendingPick("AMAZON", "7")).not.toThrow();
    expect(() => mod.clearPendingPick("AMAZON")).not.toThrow();
    expect(() => mod.prunePendingPicks(["AMAZON"])).not.toThrow();
  });

  it("still notifies subscribers so the UI stays consistent with itself", () => {
    const onChange = vi.fn();
    const unsubscribe = mod.subscribePendingPicks(onChange);
    try {
      mod.writePendingPick("AMAZON", "7");
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  /**
   * The guarantee the docstring above actually makes.
   *
   * "Degrades to no persistence" is a much weaker claim than "does not throw",
   * and only the weak one used to be pinned. With `sessionStorage` as the
   * field's ONLY state, a throwing store meant the controlled combobox never
   * reflected the selection and `disabled={... || !categoryId}` kept Submit
   * greyed out — the picker was inoperable, not merely forgetful. The
   * in-memory cache is what makes the docstring true.
   */
  it("a pick still reads back within the sitting, storage or no storage", () => {
    mod.writePendingPick("AMAZON", "7");
    expect(mod.readPendingPick("AMAZON")).toBe("7");

    mod.writePendingPick("AMAZON", "");
    expect(mod.readPendingPick("AMAZON")).toBe("");

    mod.clearPendingPick("AMAZON");
    expect(mod.readPendingPick("AMAZON")).toBeNull();
  });
});

describe("_pending-pick — the cache mirrors one store, not all of them", () => {
  it("does not carry picks across a change of sessionStorage instance", () => {
    stubBrowser();
    writePendingPick("AMAZON", "7");
    expect(readPendingPick("AMAZON")).toBe("7");

    // A second, empty store: the cache has to be rebuilt from it rather than
    // answering from the previous one.
    stubBrowser();
    expect(readPendingPick("AMAZON")).toBeNull();
  });

  it("hydrates picks written to storage before this module ever read it", () => {
    stubBrowser();
    store.setItem("mm.categorize.pick.AMAZON", "12");
    store.setItem("unrelated.app.key", "keep me");

    expect(readPendingPick("AMAZON")).toBe("12");
    expect(readPendingPick("unrelated.app.key")).toBeNull();
  });
});

/**
 * A store whose WRITES throw, which is a different failure from a store you
 * cannot touch at all — and the only one that actually runs the inner
 * `catch` blocks. See `WriteThrowingStorage`.
 */
describe("_pending-pick — a store that accepts reads but throws on write", () => {
  function stubWriteThrowingBrowser(): void {
    vi.stubGlobal("window", { sessionStorage: new WriteThrowingStorage() });
  }

  it("keeps the pick readable, so the picker stays operable", () => {
    // The strong claim, not "does not throw": the cache is written before
    // storage is attempted, so a throwing `setItem` cannot lose the value.
    // If it could, the combobox would never show the pick and Submit —
    // `disabled={... || !categoryId}` — would stay greyed out forever.
    stubWriteThrowingBrowser();
    expect(() => writePendingPick("AMAZON", "7")).not.toThrow();
    expect(readPendingPick("AMAZON")).toBe("7");
  });

  it("still notifies subscribers, so the row re-renders with the pick", () => {
    stubWriteThrowingBrowser();
    const seen = vi.fn();
    const unsubscribe = subscribePendingPicks(seen);
    writePendingPick("AMAZON", "7");
    expect(seen).toHaveBeenCalled();
    unsubscribe();
  });

  it("clears the pick from the cache even though removeItem throws", () => {
    stubWriteThrowingBrowser();
    writePendingPick("AMAZON", "7");
    expect(() => clearPendingPick("AMAZON")).not.toThrow();
    expect(readPendingPick("AMAZON")).toBeNull();
  });

  it("prunes stale picks even though removeItem throws", () => {
    stubWriteThrowingBrowser();
    writePendingPick("AMAZON", "7");
    writePendingPick("COSTCO", "9");
    expect(() => prunePendingPicks(["COSTCO"])).not.toThrow();
    expect(readPendingPick("AMAZON")).toBeNull();
    expect(readPendingPick("COSTCO")).toBe("9");
  });

  it("warns once rather than per key, so a locked-down browser is legible not noisy", async () => {
    // A FRESH module instance. The once-only flag is module scope — which is
    // the point of it — so by this line the statically-imported module has
    // long since warned, and asserting a count against it would only be
    // measuring test order.
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stubWriteThrowingBrowser();
      const fresh = await import("./_pending-pick");
      fresh.writePendingPick("AMAZON", "7");
      fresh.writePendingPick("COSTCO", "9");
      fresh.clearPendingPick("AMAZON");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });
});

/**
 * The THIRD shape of storage failure, and the last `catch` in this module that
 * nothing reached.
 *
 * `THROWING_WINDOW` fails at the `sessionStorage` getter, so `storage()`
 * returns `null` and `hydrate()` returns before its `try` body ever runs.
 * `WriteThrowingStorage` hands back a readable store, so its read walk
 * succeeds. Neither one executes `hydrate()`'s own `catch` — the handler that
 * stands between a locked-down browser and a `/categorize` page that throws on
 * FIRST RENDER, before the user has picked anything at all. That is a strictly
 * worse failure than the lost-persistence one the other two cover: every row
 * on the page calls `readPendingPick` through `useSyncExternalStore`.
 *
 * Chrome with "block all site data" and some enterprise policies produce
 * exactly this: property access on the Storage object throws rather than the
 * object being absent.
 */
class ReadThrowingStorage extends FakeStorage {
  override get length(): never {
    throw new Error("SecurityError: storage access is denied");
  }
}

describe("_pending-pick — a store that hands itself over but throws when read", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // This module has already warned by now (module-scope once-flag), but the
    // fresh-module case below has not — and an unmocked warn is console noise
    // on an otherwise passing run either way.
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("window", { sessionStorage: new ReadThrowingStorage() });
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("reads null instead of throwing out of the row's render", () => {
    // `readPendingPick` runs inside `useSyncExternalStore`'s snapshot on every
    // row. A throw here is not a lost pick, it is a blank page.
    expect(() => readPendingPick("AMAZON")).not.toThrow();
    expect(readPendingPick("AMAZON")).toBeNull();
  });

  it("leaves the picker fully operable — the cache is the read source of truth", () => {
    // An empty cache after a failed hydration is the correct "nothing parked
    // yet" answer, and picks made during the sitting still work.
    expect(() => writePendingPick("AMAZON", "7")).not.toThrow();
    expect(readPendingPick("AMAZON")).toBe("7");
    clearPendingPick("AMAZON");
    expect(readPendingPick("AMAZON")).toBeNull();
  });

  it("prunes and notifies without throwing", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribePendingPicks(onChange);
    try {
      writePendingPick("AMAZON", "7");
      writePendingPick("COSTCO", "9");
      expect(() => prunePendingPicks(["COSTCO"])).not.toThrow();
      expect(readPendingPick("AMAZON")).toBeNull();
      expect(readPendingPick("COSTCO")).toBe("9");
      expect(onChange).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("says so once, so 'my picks keep vanishing' is answerable", async () => {
    // A fresh module instance for the same reason the write-throwing case
    // needs one: the once-only flag is module scope, so the statically
    // imported copy has already spent its single warning.
    vi.resetModules();
    const freshWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.stubGlobal("window", { sessionStorage: new ReadThrowingStorage() });
      const fresh = await import("./_pending-pick");
      expect(fresh.readPendingPick("AMAZON")).toBeNull();
      expect(freshWarn).toHaveBeenCalledTimes(1);
    } finally {
      freshWarn.mockRestore();
      vi.resetModules();
    }
  });
});
