"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

/**
 * Shared dashboard chrome — one consistent top-right cluster on EVERY dashboard
 * page (replaces the lone Owner-Pulse buttons + the floating hard-refresh disc):
 *
 *   ⟳ Refresh  — soft `router.refresh()` (re-fetch data). Polls /api/version and,
 *                when a new build is deployed, lights up gold + a dot; tapping it
 *                then does a TRUE hard refresh (clears Cache Storage + reloads),
 *                so it absorbs the old HardRefreshButton's deploy-awareness.
 *   ⛶ Fullscreen — toggles the page content (#nq-dashboard-content) into a clean
 *                TV/kiosk view via the Fullscreen API (sidebar/nav drop away).
 */

const VERSION_POLL_MS = 90 * 1000;

export function DashboardViewControls() {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const router = useRouter();

  const [, startSoft] = useTransition();
  const [hardSpinning, setHardSpinning] = useState(false);
  // A soft router.refresh() resolves almost instantly, so the bare transition
  // pending flag flickered for a few ms and the tap felt dead. Drive the spin
  // off our own timer so it ALWAYS reads as a deliberate ≥650ms turn, then a
  // brief gold "done" flash confirms it happened.
  const [softSpinning, setSoftSpinning] = useState(false);
  const [flash, setFlash] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const baseVersion = useRef<string | null>(null);

  // New-deploy detection (same contract as the old HardRefreshButton).
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const { id } = (await r.json()) as { id?: string };
        if (!alive || !id) return;
        if (baseVersion.current == null) baseVersion.current = id;
        else if (id !== baseVersion.current) setUpdateAvailable(true);
      } catch {
        /* offline / transient */
      }
    };
    void check();
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, VERSION_POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // Fullscreen the whole document (not a sub-element) so ALL UI keeps working
  // in fullscreen — portaled drawers/forms/toasts (createPortal → document.body)
  // AND the sidebar/nav. Fullscreen just hides the browser chrome (address bar)
  // for an immersive view; the sidebar stays (it collapses for more room).
  useEffect(() => {
    const onChange = () =>
      setIsFs(document.fullscreenElement === document.documentElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const hardRefresh = useCallback(async () => {
    if (hardSpinning) return;
    try {
      navigator.vibrate?.(12);
    } catch {
      /* no haptics */
    }
    setHardSpinning(true);
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* cache API blocked — reload still refreshes */
    }
    window.setTimeout(() => window.location.reload(), 380);
  }, [hardSpinning]);

  const onRefresh = useCallback(() => {
    if (updateAvailable) {
      void hardRefresh();
      return;
    }
    try {
      navigator.vibrate?.(10);
    } catch {
      /* no haptics */
    }
    setFlash(false);
    setSoftSpinning(true);
    startSoft(() => router.refresh());
    // Guaranteed-visible spin, then a short success flash.
    window.setTimeout(() => {
      setSoftSpinning(false);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 900);
    }, 650);
  }, [updateAvailable, hardRefresh, router]);

  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  const spinning = softSpinning || hardSpinning;
  const refreshLabel = updateAvailable
    ? vi
      ? "Có bản mới — chạm để cập nhật"
      : "New version — tap to update"
    : vi
      ? "Làm mới"
      : "Refresh";
  const fsLabel = isFs
    ? vi
      ? "Thoát toàn màn hình"
      : "Exit fullscreen"
    : vi
      ? "Toàn màn hình"
      : "Fullscreen";

  return (
    <div
      data-testid="dashboard-view-controls"
      className="fixed right-2 top-2 z-40 flex items-center gap-1 rounded-full border border-nq-border/60 bg-nq-surface/80 p-1 shadow-sm backdrop-blur md:right-3 md:top-3"
    >
      <button
        type="button"
        onClick={onRefresh}
        aria-label={refreshLabel}
        title={refreshLabel}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-full transition-[color,box-shadow] duration-200",
          "text-nq-foreground/75 hover:text-nq-primary",
          spinning && "animate-spin",
          (spinning || flash || updateAvailable) && "text-nq-primary",
          (flash || updateAvailable) && "ring-2 ring-nq-primary/50",
        )}
      >
        <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
        </svg>
        {updateAvailable ? (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-nq-primary" />
        ) : null}
      </button>
      <button
        type="button"
        onClick={toggleFs}
        aria-label={fsLabel}
        title={fsLabel}
        className="flex h-9 w-9 items-center justify-center rounded-full text-nq-foreground/75 transition-colors hover:text-nq-primary"
      >
        <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {isFs ? (
            <path d="M9 4v3a2 2 0 01-2 2H4M20 9h-3a2 2 0 01-2-2V4M15 20v-3a2 2 0 012-2h3M4 15h3a2 2 0 012 2v3" />
          ) : (
            <path d="M8 4H5a1 1 0 00-1 1v3M16 4h3a1 1 0 011 1v3M8 20H5a1 1 0 01-1-1v-3M16 20h3a1 1 0 001-1v-3" />
          )}
        </svg>
      </button>
    </div>
  );
}
