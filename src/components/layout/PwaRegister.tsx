"use client";

import { useEffect } from "react";

/**
 * Registers the minimal service worker so the dashboard is installable as a
 * PWA on Android/Chrome (iOS installs via the apple-* meta tags without a
 * SW). Fire-and-forget on mount; failures are non-fatal (the app still works,
 * it just won't show the install prompt).
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const register = () => {
      navigator.serviceWorker.register("/nailiq-sw.js").catch(() => {
        /* install prompt unavailable — non-fatal */
      });
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
