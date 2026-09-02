"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker and warms the generic TurnIQ offline shell.
 * Authenticated dashboard HTML and API/Server Action responses are never sent
 * to the cache. Failures remain non-fatal and offline writes stay fail-closed.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const register = () => {
      void navigator.serviceWorker.register("/nailiq-sw.js", {
        scope: "/",
        updateViaCache: "none",
      }).then(async () => {
        const registration = await navigator.serviceWorker.ready;
        const response = await fetch("/turniq/offline", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const html = await response.text();
        const document = new DOMParser().parseFromString(html, "text/html");
        const assets = Array.from(
          document.querySelectorAll("script[src],link[rel='stylesheet'][href]"),
        )
          .map((node) => node.getAttribute("src") ?? node.getAttribute("href"))
          .filter((url): url is string => Boolean(url));
        registration.active?.postMessage({
          type: "WARM_TURNIQ_OFFLINE_SHELL",
          urls: ["/turniq/offline", ...assets],
        });
      }).catch(() => {
        /* install/offline shell unavailable — mutation stays locked */
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
