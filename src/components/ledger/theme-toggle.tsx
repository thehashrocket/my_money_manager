"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "ledger-theme";

type Mode = "light" | "dark";

function applyTheme(mode: Mode) {
  const root = document.documentElement;
  if (mode === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

function readMode(): Mode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Ignore localStorage errors (private mode, disabled storage).
  }
  try {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  } catch {
    // matchMedia unavailable in some test envs.
  }
  return "light";
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * Mini light/dark pill toggle in the Spine footer.
 *
 * Persists to `localStorage` under `ledger-theme`. Defaults to the system
 * preference on first visit. The actual `.dark` class is set before first
 * paint by <ThemeInit /> in the <head> to avoid a flash.
 *
 * `useSyncExternalStore` keeps React in lock-step with the DOM without a
 * state-setting effect.
 */
export function ThemeToggle() {
  const mode = useSyncExternalStore(
    subscribe,
    readMode,
    () => "light" as Mode,
  );

  function choose(next: Mode) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage errors.
    }
    applyTheme(next);
    // Nudge the external store: useSyncExternalStore only re-renders when
    // `subscribe` fires, so we dispatch a synthetic storage event for the
    // current tab (native "storage" only fires in *other* tabs).
    try {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: next }),
      );
    } catch {
      // StorageEvent constructor unavailable in rare envs.
    }
  }

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button
        type="button"
        className={mode === "light" ? "active" : ""}
        onClick={() => choose("light")}
        aria-pressed={mode === "light"}
        aria-label="Light mode"
      >
        ☀
      </button>
      <button
        type="button"
        className={mode === "dark" ? "active" : ""}
        onClick={() => choose("dark")}
        aria-pressed={mode === "dark"}
        aria-label="Dark mode"
      >
        ☾
      </button>
    </div>
  );
}
