/**
 * The single source of truth for how long a service occupies the schedule.
 *
 * A booking's block = the service's own duration PLUS its per-service
 * `buffer_minutes` (the reset/cleanup gap reserved after the service before the
 * next booking on the same staff can start). Every booking source — public
 * online booking, Square/Wix sync, Voice AI, chat, the receptionist desk,
 * group booking, reschedule, and quick-rebook — MUST compute its block through
 * this helper so the buffer is applied identically no matter who wrote the row.
 *
 * Why this matters: the DB `bookings_no_overlap` GIST constraint excludes
 * overlapping `tstzrange(start_time_utc, end_time_utc)` per (salon, staff). It
 * does NOT add the buffer itself — it trusts each writer to have baked the
 * buffer into `end_time_utc`. Funnelling that arithmetic through one function
 * keeps the constraint's guarantee honest across every source and means a new
 * booking path can't silently forget the buffer.
 *
 * Inputs are intentionally loose: DB columns arrive as `number | null` (and
 * sometimes `unknown` after an `as never` select). Any non-finite value
 * coerces to 0, so a missing/garbage buffer can never NaN an end-time
 * computation — it just contributes no extra time.
 */
export function serviceBlockMinutes(
  durationMinutes: unknown,
  bufferMinutes: unknown,
): number {
  const duration = Number(durationMinutes);
  const buffer = Number(bufferMinutes);
  return (
    (Number.isFinite(duration) ? duration : 0) +
    (Number.isFinite(buffer) ? buffer : 0)
  );
}
