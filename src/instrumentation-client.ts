import { classifyClientErrorDisposition } from "@/shared/observability/clientErrorDisposition";
import { normalizePromiseRejection } from "@/shared/observability/normalizePromiseRejection";

// Client error capture → NailIQ's own /api/errors endpoint.
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

const STALE_DEPLOY_RE =
  /was not found on the server|Failed to find Server Action|failed-to-find-server-action/i;

/**
 * Deploy skew: a new deployment changed Server Action IDs while this tab still
 * runs the old bundle, so its action calls 404 with "Server Action <hash> was
 * not found on the server". Reload ONCE to pull the matching bundle — recovers
 * the user (e.g. a receptionist mid-action) instead of a dead-end. A 15s
 * sessionStorage guard (shared with ReceptionistErrorBoundary) prevents a
 * reload loop if a reload doesn't help.
 *
 * This is the app-wide safety net: the error boundary only catches errors
 * thrown during React RENDER, but server actions invoked from event handlers /
 * transitions reject here (window error / unhandledrejection) and would
 * otherwise never auto-recover. The real root-cause fix is enabling Vercel
 * Skew Protection (pins clients to their deployment); this mitigates until then
 * and covers tabs left open past the skew-protection window.
 *
 * Returns true when handled — the caller then skips reporting (expected skew,
 * not a bug worth alerting on).
 */
function maybeRecoverFromStaleDeploy(msg: string): boolean {
  if (!STALE_DEPLOY_RE.test(msg)) return false;
  try {
    const KEY = "nq-skew-reload-at";
    const last = Number(window.sessionStorage.getItem(KEY) ?? "0");
    if (Number.isNaN(last) || Date.now() - last > 15_000) {
      window.sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    }
  } catch {
    /* storage blocked in some webviews — nothing to report either way */
  }
  return true;
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    const msg = e.message || (e.error instanceof Error ? e.error.message : "Unknown error");
    if (isSessionExpiryError(String(msg))) return;
    if (maybeRecoverFromStaleDeploy(String(msg))) return;
    const stack = e.error instanceof Error ? (e.error.stack ?? null) : null;
    const evidence = [e.filename, stack].filter(Boolean).join("\n");
    const disposition = classifyClientErrorDisposition(String(msg), evidence);
    if (disposition === "ignore") return;
    reportClientError(String(msg), stack, disposition);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const { message: msg, stack } = normalizePromiseRejection(e.reason);
    if (isSessionExpiryError(String(msg))) return;
    if (maybeRecoverFromStaleDeploy(String(msg))) return;
    const disposition = classifyClientErrorDisposition(String(msg), stack);
    if (disposition === "ignore") return;
    reportClientError(String(msg), stack, disposition);
  });
}
