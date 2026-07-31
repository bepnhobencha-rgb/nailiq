/**
 * Elapsed seconds for a voice session, safe to call before the session starts.
 *
 * The modal only stamps its start time when the realtime session reports
 * `session.updated` (connecting → connected). A caller who closes the modal,
 * denies the microphone, or loses the network during connect ends the session
 * with that stamp still at its initial 0 — and `Date.now() - 0` is the Unix
 * epoch in milliseconds, which became a ~56-year duration once divided by 1000.
 *
 * Production 2026-07-31: 6 of 107 voice sessions carried
 * `duration_seconds ≈ 1.78e9`; `to_timestamp(duration_seconds)` reproduced each
 * row's `ended_at` exactly, and all six were `status = 'abandoned'`. The owner's
 * activity feed rendered them as "29756345p40s".
 *
 * A session that never started lasted no measurable time, so report 0.
 */
export function elapsedSessionSeconds(startTs: number, now: number): number {
  if (!startTs || startTs <= 0 || !Number.isFinite(startTs)) return 0;
  if (!Number.isFinite(now) || now <= startTs) return 0;
  return Math.round((now - startTs) / 1000);
}
