"use client";

import { useEffect } from "react";

/**
 * Bridges the embedded booking flow to the host page (the `embed.js` widget)
 * via postMessage. Only active when actually framed.
 *
 *  - `nailiq-embed:ready`   — flow mounted (host can fade in the iframe)
 *  - `nailiq-embed:resize`  — content height changed (host auto-sizes inline embeds)
 *  - `nailiq-embed:booked`  — a booking succeeded (host can confetti / auto-close)
 */
export function EmbedFrameBridge() {
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;

    const post = (type: string, payload: Record<string, unknown> = {}) =>
      window.parent.postMessage({ source: "nailiq-embed", type, ...payload }, "*");

    // Ensure html/body don't show a browser-default dark bg below .nq-booking-embed
    // (happens when system is in dark mode and iframe height > booking content height).
    document.documentElement.style.background = "white";
    document.body.style.background = "white";

    // Measure the CONTENT wrapper, not the document — the root layout's
    // `body.min-h-dvh` makes documentElement.scrollHeight track the iframe's own
    // height (circular), which would defeat auto-resize.
    const root =
      (document.querySelector(".nq-booking-embed") as HTMLElement | null) ??
      document.body;
    const sendHeight = () =>
      post("resize", { height: Math.ceil(root.getBoundingClientRect().height) });

    const ro = new ResizeObserver(sendHeight);
    ro.observe(root);
    sendHeight();
    post("ready");

    // Notify the host once the success screen appears so it can celebrate /
    // close the modal. The done panel renders `[data-testid="booking-success"]`.
    let booked = false;
    const checkBooked = () => {
      if (!booked && document.querySelector('[data-testid="booking-success"]')) {
        booked = true;
        post("booked");
      }
    };
    const mo = new MutationObserver(checkBooked);
    mo.observe(document.body, { childList: true, subtree: true });
    checkBooked();

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return null;
}
