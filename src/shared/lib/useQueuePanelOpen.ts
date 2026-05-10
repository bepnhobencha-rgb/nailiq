"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Persistence key for the receptionist queue slide-over open state —
 * see `docs/DASHBOARD_LAYOUT_RULES.md` §11.2. `"1"` means open;
 * anything else (including absence) means collapsed.
 */
export const QUEUE_PANEL_OPEN_STORAGE_KEY = "nailiq-queue-panel-open";

function readPersistedPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(QUEUE_PANEL_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Queue slide-over open state with the §11.2 auto-open contract:
 *
 * - Cross-session: persisted in `localStorage`. Default closed.
 * - Auto-open: when `waitingCount > 0`, the panel opens IF the user
 *   has not explicitly closed it during this session.
 * - Manual close (toggle button) sets a session-scoped suppression
 *   flag so the auto-open doesn't immediately re-open the panel
 *   under the user's hand. The flag clears on the next page reload —
 *   the auto-open contract resumes for the next session.
 *
 * `setOpen(true)` clears the suppression flag (the user's intent is
 * unambiguous when they explicitly open).
 */
export function useQueuePanelOpen(waitingCount: number) {
  const [open, setOpenState] = useState(false);

  // Session-scoped suppression: if the user manually closed the panel
  // while waitingCount > 0, don't auto-re-open until the next reload.
  const suppressedRef = useRef(false);

  // Hydrate from localStorage AFTER mount so SSR + client render match.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot localStorage hydration
    setOpenState(readPersistedPreference());
  }, []);

  // Auto-open when queue has pressure, unless suppressed this session.
  useEffect(() => {
    if (waitingCount <= 0) return;
    if (suppressedRef.current) return;
    setOpenState((cur) => (cur ? cur : true));
  }, [waitingCount]);

  const persist = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(
        QUEUE_PANEL_OPEN_STORAGE_KEY,
        next ? "1" : "0",
      );
    } catch {
      /* ignore quota / private mode */
    }
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      persist(next);
      if (next) {
        // Explicit open clears any prior session suppression.
        suppressedRef.current = false;
      }
    },
    [persist],
  );

  const toggle = useCallback(() => {
    setOpenState((cur) => {
      const next = !cur;
      persist(next);
      // Manual close while there's queue pressure → suppress the
      // auto-open for the rest of this session so we don't fight the
      // user's intent.
      suppressedRef.current = !next && waitingCount > 0;
      return next;
    });
  }, [persist, waitingCount]);

  return { open, setOpen, toggle };
}
