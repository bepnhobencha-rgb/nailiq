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
 * SSR-safe: starts `false` on the server + first client paint, then hydrates
 * from localStorage in an effect to avoid a hydration mismatch.
 */
const STORAGE_KEY = "nailiq-basic-mode";

export function useBasicMode(): {
  basicMode: boolean;
  setBasicMode: (on: boolean) => void;
  toggleBasicMode: () => void;
  /** True once the localStorage value has been read (post-mount). */
  hydrated: boolean;
} {
  const [basicMode, setBasicModeState] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setBasicModeState(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* localStorage unavailable (private mode) — stay off */
    }
    setHydrated(true);
  }, []);

  const setBasicMode = useCallback((on: boolean) => {
    setBasicModeState(on);
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      /* ignore persistence failure */
    }
  }, []);

  const toggleBasicMode = useCallback(() => {
    setBasicModeState((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return { basicMode, setBasicMode, toggleBasicMode, hydrated };
}
