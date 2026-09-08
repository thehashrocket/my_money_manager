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

describe("_pending-pick — a storage that throws (Safari private mode)", () => {
  beforeEach(() => {
    vi.stubGlobal("window", THROWING_WINDOW);
  });

  it("degrades to no persistence instead of taking the page down", () => {
    expect(readPendingPick("AMAZON")).toBeNull();
    expect(() => writePendingPick("AMAZON", "7")).not.toThrow();
    expect(() => clearPendingPick("AMAZON")).not.toThrow();
    expect(() => prunePendingPicks(["AMAZON"])).not.toThrow();
  });

  it("still notifies subscribers so the UI stays consistent with itself", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribePendingPicks(onChange);
    try {
      writePendingPick("AMAZON", "7");
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
    writePendingPick("AMAZON", "7");
    expect(readPendingPick("AMAZON")).toBe("7");

    writePendingPick("AMAZON", "");
    expect(readPendingPick("AMAZON")).toBe("");

    clearPendingPick("AMAZON");
    expect(readPendingPick("AMAZON")).toBeNull();
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
