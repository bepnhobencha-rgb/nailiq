export interface ConflictCheckBooking {
  staff_id: string | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
  status: string;
  id: string;
  client_name: string;
  /** Optional resource dimension (beds/chairs/stations). Present only when the
   *  caller selected it for resource-mode salons. */
  resource_id?: string | null;
}

function isSkippedStatus(status: string): boolean {
  return status === "cancelled" || status === "waiting";
}

function parseIsoMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Returns the first conflicting booking, or null if no conflict.
 * Conflict = same staff, overlapping interval, status not cancelled, status not waiting.
 * Standard overlap rule: a.start < b.end AND a.end > b.start.
 * Bookings with null staff_id, null start_time_utc, or null end_time_utc are skipped.
 *
 * **DB constraint is now the primary guard.**
 * `bookings_no_overlap` (GIST EXCLUDE on `salon_id`, `staff_id`,
 * `tstzrange(start_time_utc, end_time_utc, '[)')` WHERE status !=
 * 'cancelled', defined in migration `20260430230000_bookings_no_overlap_gist.sql`)
 * rejects any concurrent INSERT or UPDATE that would create overlapping
 * non-cancelled bookings on the same staff. App-level check below
 * remains as **early UX feedback** (synchronous, pre-network) so the
 * receptionist sees the conflict highlighted on the timeline before
 * submitting; the DB raises `23P01` (exclusion_violation) on a true
 * race, which server actions translate to `slot_conflict`.
 *
 * Note on `no_show`: not yet present in the live `bookings_status_check`
 * enum (`STATE_MACHINE.md` lists it; DB does not). When the schema
 * adds it, the GIST WHERE clause should be widened to also exclude
 * `no_show` from the overlap check. Tracked as a follow-up to the
 * state-machine reconciliation.
 */
export function checkBookingConflict(args: {
  staffId: string;
  startUtcIso: string;
  endUtcIso: string;
  existingBookings: ConflictCheckBooking[];
  excludeBookingId?: string;
}): ConflictCheckBooking | null {
  const newStart = parseIsoMs(args.startUtcIso);
  const newEnd = parseIsoMs(args.endUtcIso);
  if (newStart === null || newEnd === null) {
    return null;
  }

  for (const b of args.existingBookings) {
    if (args.excludeBookingId !== undefined && b.id === args.excludeBookingId) {
      continue;
    }
    if (b.staff_id !== args.staffId) {
      continue;
    }
    if (b.staff_id === null) {
      continue;
    }
    if (isSkippedStatus(b.status)) {
      continue;
    }
    const exStart = parseIsoMs(b.start_time_utc);
    const exEnd = parseIsoMs(b.end_time_utc);
    if (exStart === null || exEnd === null) {
      continue;
    }
    if (newStart < exEnd && newEnd > exStart) {
      return b;
    }
  }

  return null;
}

/**
 * Resource-dimension twin of `checkBookingConflict`: returns the first booking
 * occupying the same resource (bed/chair) in an overlapping interval. Mirrors
 * the `bookings_resource_no_overlap` GIST (excludes cancelled / waiting /
 * no_show). App-level UX pre-flight only — the DB constraint is the real guard.
 */
export function checkResourceConflict(args: {
  resourceId: string;
  startUtcIso: string;
  endUtcIso: string;
  existingBookings: ConflictCheckBooking[];
  excludeBookingId?: string;
}): ConflictCheckBooking | null {
  const newStart = parseIsoMs(args.startUtcIso);
  const newEnd = parseIsoMs(args.endUtcIso);
  if (newStart === null || newEnd === null) return null;

  for (const b of args.existingBookings) {
    if (args.excludeBookingId !== undefined && b.id === args.excludeBookingId) continue;
    if (!b.resource_id || b.resource_id !== args.resourceId) continue;
    if (b.status === "cancelled" || b.status === "waiting" || b.status === "no_show") continue;
    const exStart = parseIsoMs(b.start_time_utc);
    const exEnd = parseIsoMs(b.end_time_utc);
    if (exStart === null || exEnd === null) continue;
    if (newStart < exEnd && newEnd > exStart) return b;
  }

  return null;
}
