"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Per-device Basic Mode toggle for the Receptionist board.
 *
 * Stored in localStorage (NOT salon config) so it's a lightweight per-device
 * preference — a front-desk iPad can run Basic Mode without changing the
 * owner's salon-wide density/preset. Safe: no DB write, no server round-trip,
 * defaults to OFF so Balanced/Advanced behavior is unchanged for everyone who
 * never opts in.
 *
 * However, if salon.basic_mode_forced = true (e.g., Tech Nails receptionist),
 * Basic Mode is automatically ON and cannot be toggled off.
 *
 * SSR-safe: localStorage is exposed through a module-level external store, so
 * the server snapshot is always `false` and React swaps in the real value after
 * hydration — no state-setting effect, no hydration mismatch.
 */
const STORAGE_KEY = "nailiq-basic-mode";

// One store shared by every hook instance on the page (sidebar + receptionist
// board), so a toggle in one re-renders the other instead of leaving it on a
// stale snapshot until it remounts.
const listeners = new Set<() => void>();

// Cached so getSnapshot stays cheap — the receptionist board re-renders on
// every realtime tick and should not hit localStorage each time.
let snapshot: boolean | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function getSnapshot(): boolean {
  if (snapshot === null) {
    try {
      snapshot = window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      /* localStorage unavailable (private mode) — stay off */
      snapshot = false;
    }
  }
  return snapshot;
}

function onStorageEvent(): void {
  // Another tab wrote the key — drop the cache and re-read on next render.
  snapshot = null;
  emit();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStorageEvent);
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorageEvent);
    }
  };
}

function writeStored(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore persistence failure */
  }
  snapshot = on;
  emit();
}

const noopSubscribe = () => () => {};
const getServerSnapshot = () => false;
const getMountedSnapshot = () => true;

export function useBasicMode(basicModeForced?: boolean): {
  basicMode: boolean;
  setBasicMode: (on: boolean) => void;
  toggleBasicMode: () => void;
  /** True once the localStorage value has been read (post-mount). */
  hydrated: boolean;
  /** True if basic mode cannot be toggled (forced by salon config). */
  isForced: boolean;
} {
  const isForced = basicModeForced ?? false;

  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    getMountedSnapshot,
    getServerSnapshot,
  );

  // Forced salons persist the flag to the device, matching the previous
  // behavior: a device that later loses basic_mode_forced keeps Basic Mode.
  // Writes storage only — no React state is set here.
  useEffect(() => {
    if (isForced && !getSnapshot()) {
      writeStored(true);
    }
  }, [isForced]);

  const basicMode = isForced || stored;

  const setBasicMode = useCallback(
    (on: boolean) => {
      // If forced, prevent toggle off
      if (isForced && !on) {
        return;
      }
      writeStored(on);
    },
    [isForced],
  );

  const toggleBasicMode = useCallback(() => {
    // If forced, don't allow toggle
    if (isForced) {
      return;
    }
    writeStored(!getSnapshot());
  }, [isForced]);

  return { basicMode, setBasicMode, toggleBasicMode, hydrated, isForced };
}
