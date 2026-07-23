"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { upsertPresence } from "@/shared/dashboard/presenceActions";

const INTERVAL_MS = 30_000;

type Props = {
  salonId: string;
};

/**
 * Invisible component mounted once in DashboardShell.
 * Sends a presence heartbeat on mount and every 30s.
 * Reads battery level from the browser Battery API (Chrome/Android only).
 */
export function PresenceHeartbeat({ salonId }: Props) {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;

    async function beat() {
      if (cancelled) return;
      let batteryLevel: number | null = null;
      try {
        // Battery Status API — Chrome/Android only; Safari/Firefox throw or return undefined.
        const nav = navigator as Navigator & {
          getBattery?: () => Promise<{ level: number; charging: boolean }>;
        };
        if (typeof nav.getBattery === "function") {
          const battery = await nav.getBattery();
          batteryLevel = Math.round(battery.level * 100);
        }
      } catch {
        // not supported — ignore
      }
      await upsertPresence({
        salonId,
        currentPath: pathnameRef.current ?? "",
        batteryLevel,
        userAgent: navigator.userAgent,
      });
    }

    void beat();
    const timer = setInterval(() => void beat(), INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [salonId]);

  return null;
}
