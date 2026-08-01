import { SESSION_TTL_SECONDS } from "./config";

/**
 * Normalize an untrusted duration before it is persisted.
 *
 * Both the browser and phone bridge report elapsed time to the session-end
 * route. Keep the server authoritative by refusing non-numeric values and
 * clamping reports to the same 30-minute lifetime enforced by the realtime
 * session and browser hard cap.
 */
export function normalizeVoiceSessionSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return 0;
  return Math.min(SESSION_TTL_SECONDS, Math.round(value));
}

/** Elapsed seconds, safe before the realtime session has connected. */
export function elapsedSessionSeconds(startTs: number, now: number): number {
  if (!Number.isFinite(startTs) || startTs <= 0) return 0;
  if (!Number.isFinite(now) || now <= startTs) return 0;
  return normalizeVoiceSessionSeconds((now - startTs) / 1000);
}
