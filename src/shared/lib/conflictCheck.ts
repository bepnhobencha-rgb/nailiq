export interface ConflictCheckBooking {
  staff_id: string | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
  status: string;
  id: string;
  client_name: string;
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
