"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Persistence key for the dashboard sidebar collapse state — see
 * `docs/DASHBOARD_LAYOUT_RULES.md` §9.4. `"1"` means collapsed
 * (icon-only); anything else (including absence) means expanded.
 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "nailiq-sidebar-collapsed";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    // Default EXPANDED (labels shown) for non-technical owners; collapse only
    // sticks if the user explicitly chose it before.
    return stored === null ? false : stored === "1";
  } catch {
    return false;
  }
}

/**
 * SSR-safe collapse state for the dashboard sidebar. Default expanded so
 * the first paint matches what most users see; the post-mount sync to
 * localStorage flips to collapsed silently if the user previously
 * collapsed it. No hydration-shift on the actual layout because the
 * sidebar widths are fixed-positioned and the main padding follows the
 * same source of truth.
 */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsedState] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage unavailable on server; aligns after mount
    setCollapsedState(readInitial());
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        next ? "1" : "0",
      );
    } catch {
      /* ignore quota / private mode */
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsedState((cur) => {
      const next = !cur;
      try {
        window.localStorage.setItem(
          SIDEBAR_COLLAPSED_STORAGE_KEY,
          next ? "1" : "0",
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return { collapsed, setCollapsed, toggle };
}
