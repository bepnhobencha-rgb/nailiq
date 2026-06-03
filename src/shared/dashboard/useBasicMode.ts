"use client";

import { useCallback, useEffect, useState } from "react";

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
 * SSR-safe: starts `false` on the server + first client paint, then hydrates
 * from localStorage in an effect to avoid a hydration mismatch.
 */
const STORAGE_KEY = "nailiq-basic-mode";

export function useBasicMode(basicModeForced?: boolean): {
  basicMode: boolean;
  setBasicMode: (on: boolean) => void;
  toggleBasicMode: () => void;
  /** True once the localStorage value has been read (post-mount). */
  hydrated: boolean;
  /** True if basic mode cannot be toggled (forced by salon config). */
  isForced: boolean;
} {
  const [basicMode, setBasicModeState] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const isForced = basicModeForced ?? false;

  useEffect(() => {
    try {
      // If forced, always enable
      if (isForced) {
        setBasicModeState(true);
        window.localStorage.setItem(STORAGE_KEY, "1");
      } else {
        setBasicModeState(window.localStorage.getItem(STORAGE_KEY) === "1");
      }
    } catch {
      /* localStorage unavailable (private mode) — stay off */
    }
    setHydrated(true);
  }, [isForced]);

  const setBasicMode = useCallback(
    (on: boolean) => {
      // If forced, prevent toggle off
      if (isForced && !on) {
        return;
      }
      setBasicModeState(on);
      try {
        window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
      } catch {
        /* ignore persistence failure */
      }
    },
    [isForced],
  );

  const toggleBasicMode = useCallback(() => {
    // If forced, don't allow toggle
    if (isForced) {
      return;
    }
    setBasicModeState((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [isForced]);

  return { basicMode, setBasicMode, toggleBasicMode, hydrated, isForced };
}
