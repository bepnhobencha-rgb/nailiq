"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { buildBookingThemeVars } from "./bookingThemeVars";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT = "nailiq-booking-appearance";
const MAX_AGE = 60 * 60 * 1000;
type Appearance = { salonId: string; brandColor: string; themeMode: "light" | "dark" };
type StorageReader = Pick<Storage, "getItem">;
const key = (salonId: string) => `nq:booking-appearance:v1:${salonId.toLowerCase()}`;

/** Cosmetic hints only. Never use this storage as booking, policy or tenant authority. */
export function rememberBookingAppearance(storage: Pick<Storage, "setItem">, value: Appearance, now = Date.now()): void {
  if (!UUID.test(value.salonId) || !/^#[0-9a-f]{6}$/i.test(value.brandColor) ||
      !["light", "dark"].includes(value.themeMode)) return;
  try {
    storage.setItem(key(value.salonId), JSON.stringify({
      salonId: value.salonId.toLowerCase(), brandColor: value.brandColor,
      themeMode: value.themeMode, expiresAt: now + MAX_AGE,
    }));
  } catch { /* A blocked cosmetic preference must never block booking or recovery. */ }
}

export function readBookingAppearance(storage: StorageReader, salonId: string, now = Date.now()): Appearance | null {
  if (!UUID.test(salonId)) return null;
  try {
    const raw = storage.getItem(key(salonId));
    if (!raw || raw.length > 512) return null;
    const v = JSON.parse(raw);
    if (!v || v.salonId !== salonId.toLowerCase() || typeof v.brandColor !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(v.brandColor) || !["light", "dark"].includes(v.themeMode) ||
        !Number.isFinite(v.expiresAt) || v.expiresAt <= now || v.expiresAt > now + MAX_AGE) return null;
    return { salonId: v.salonId, brandColor: v.brandColor, themeMode: v.themeMode };
  } catch { return null; }
}

function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", listener); };
}
const serverSnapshot = () => "";

/** Neutral SSR fallback; hydrate from this salon's hint, never the last visited salon. */
export function useBookingRecoveryTheme(salonId: string | undefined): CSSProperties {
  const snapshot = useSyncExternalStore(subscribe, () => {
    try {
      const value = salonId ? readBookingAppearance(window.sessionStorage, salonId) : null;
      return value ? JSON.stringify(value) : "";
    } catch { return ""; }
  }, serverSnapshot);
  const appearance: Appearance | null = snapshot ? JSON.parse(snapshot) : null;
  return { ...buildBookingThemeVars(appearance?.brandColor ?? "#D4AF37", appearance?.themeMode ?? "light"),
    "--salon-primary": "var(--cta-bg)" } as CSSProperties;
}
