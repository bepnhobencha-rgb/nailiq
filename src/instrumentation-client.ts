/**
 * App Router client instrumentation — `Sentry.init` lives in root `sentry.client.config.ts`.
 */
import * as Sentry from "@sentry/nextjs";

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

// Self-hosted client error capture → /api/errors (in addition to Sentry).
// Uses sendBeacon so the report survives even if the page is navigating away.
function reportClientError(message: string, stack: string | null, level: "error" | "warning") {
  try {
    const payload = JSON.stringify({
      message: message.slice(0, 2000),
      stack: stack?.slice(0, 8000) ?? null,
      level,
      route: typeof location !== "undefined" ? location.pathname + location.search : null,
      context: { href: typeof location !== "undefined" ? location.href : null },
    });
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon?.("/api/errors", blob)) return;
    void fetch("/api/errors", {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    });
  } catch {
    /* reporting must never throw */
  }
}

function isSessionExpiryError(msg: string): boolean {
  // "unexpected response" = server action/RSC fetch intercepted by middleware redirect
  // (e.g., to /login when JWT expired). "NEXT_REDIRECT" = same via server-thrown redirect.
  // Both are expected behaviour handled by ReceptionistErrorBoundary; logging them as bugs
  // is noise. The boundary already redirects to /login on these.
  return msg.includes("unexpected response") || msg.includes("NEXT_REDIRECT");
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    const msg = e.message || (e.error instanceof Error ? e.error.message : "Unknown error");
    if (isSessionExpiryError(String(msg))) return;
    reportClientError(String(msg), e.error instanceof Error ? (e.error.stack ?? null) : null, "error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = r instanceof Error ? r.message : typeof r === "string" ? r : "Unhandled promise rejection";
    if (isSessionExpiryError(String(msg))) return;
    reportClientError(String(msg), r instanceof Error ? (r.stack ?? null) : null, "error");
  });
}
