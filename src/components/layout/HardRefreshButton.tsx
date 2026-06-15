"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

/**
 * Smart hard-refresh control for staff — a floating gold companion to the
 * Coco FAB (opposite corner). It is "smart" in two ways:
 *
 *   1. Freshness ring — a thin ring fills as the page ages (gold → amber over
 *      ~4 min) so a glance tells you how stale what you're looking at is.
 *   2. New-deploy awareness — polls /api/version and, when the build id
 *      changes, lights up gold with a dot so staff know a hard refresh will
 *      actually pull new code (a long-open PWA tab can otherwise run stale).
 *
 * Tapping it does a TRUE hard refresh: clears the Cache Storage, then reloads
 * — with a beat of spin + a haptic tick so it feels deliberate.
 */

const FRESH_WINDOW_MS = 4 * 60 * 1000;
const VERSION_POLL_MS = 90 * 1000;

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

export function HardRefreshButton() {
  const { language } = useUserLanguage();
  const [spinning, setSpinning] = useState(false);
  const [agePct, setAgePct] = useState(0);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const mountedAt = useRef(0);
  const baseVersion = useRef<string | null>(null);

  // Freshness ring — fills 0→1 across the window. Stamp the mount time inside
  // the effect (not during render) so it stays pure for the React compiler.
  useEffect(() => {
    mountedAt.current = Date.now();
    const tick = () =>
      setAgePct(
        Math.min(1, (Date.now() - mountedAt.current) / FRESH_WINDOW_MS),
      );
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  // New-deploy detection.
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
        /* offline / transient — try again next tick */
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

  const labels =
    language === "vi"
      ? {
          idle: "Làm mới",
          update: "Có bản mới — chạm để cập nhật",
        }
      : {
          idle: "Refresh",
          update: "New version — tap to update",
        };

  const hardRefresh = async () => {
    if (spinning) return;
    try {
      navigator.vibrate?.(12);
    } catch {
      /* no haptics here */
    }
    setSpinning(true);
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* cache API blocked — reload still refreshes */
    }
    // Let the spin read as intentional, then a true hard reload.
    window.setTimeout(() => window.location.reload(), 380);
  };

  const ringPct = updateAvailable ? 1 : agePct;
  const ringColor = updateAvailable
    ? "#D4AF37"
    : agePct < 0.6
      ? "#D4AF37"
      : "#D97706";

  return (
    <button
      type="button"
      onClick={hardRefresh}
      aria-label={updateAvailable ? labels.update : labels.idle}
      title={updateAvailable ? labels.update : labels.idle}
      className={cn(
        "fixed z-50 bottom-20 left-5 md:bottom-5 md:left-[calc(var(--nq-sidebar-w)+1.25rem)]",
        "flex h-14 w-14 items-center justify-center rounded-full",
        // Gold-tinted glassy disc + an always-on gold glow so it lifts off the
        // dark dashboard instead of blending in.
        "border-2 border-nq-primary/55 bg-nq-primary/15 shadow-nq-glow backdrop-blur-xl",
        "transition-[transform,box-shadow,border-color] duration-[var(--duration-nq-base)] ease-[var(--ease-nq-out)]",
        "hover:scale-110 hover:border-nq-primary/80 active:scale-95",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/55",
        updateAvailable && "animate-pulse border-nq-primary",
      )}
    >
      {/* Freshness / update ring */}
      <svg
        viewBox="0 0 52 52"
        className="absolute inset-0 h-full w-full -rotate-90"
        aria-hidden
      >
        <circle
          cx="26"
          cy="26"
          r={RING_R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-nq-border/40"
        />
        <circle
          cx="26"
          cy="26"
          r={RING_R}
          fill="none"
          stroke={ringColor}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - ringPct)}
          style={{
            transition:
              "stroke-dashoffset 600ms var(--ease-nq-out), stroke 400ms ease",
          }}
        />
      </svg>

      {/* Refresh glyph — gold so it reads as the actionable mark on the tile */}
      <svg
        viewBox="0 0 24 24"
        width={24}
        height={24}
        fill="none"
        stroke="#F5E6B8"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("relative", spinning && "animate-spin")}
        aria-hidden
      >
        <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
      </svg>

      {/* New-deploy dot */}
      {updateAvailable && !spinning ? (
        <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 animate-pulse rounded-full bg-nq-primary ring-2 ring-nq-bg" />
      ) : null}
    </button>
  );
}
