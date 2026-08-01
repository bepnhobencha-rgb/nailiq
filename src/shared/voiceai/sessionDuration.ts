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

/**
 * Owner-facing duration suffix for an already-persisted voice session.
 *
 * The write path now clamps untrusted reports, but a handful of historical
 * rows contain an epoch timestamp instead of elapsed seconds. Do not silently
 * clamp those records to 30 minutes: that would replace one false value with
 * another. Keep zero/missing duration quiet and label an impossible positive
 * duration honestly.
 */
export function voiceSessionDurationSuffix(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return "";

  const seconds = Math.round(value);
  if (seconds > SESSION_TTL_SECONDS) return " · thời lượng không xác định";

  return ` · ${Math.floor(seconds / 60)}p${seconds % 60}s`;
}
