"use server";

import { logBookingEvent } from "@/shared/dashboard/auditLog";

/**
 * Salon-scoped rush-hour event. Wraps `logBookingEvent` with a null
 * `bookingId` so the same `booking_events` table can carry both
 * per-booking transitions and desk-wide operational signals.
 *
 * This call is fire-and-forget from the client (the rush hook in
 * `ReceptionistCenter` invokes it without awaiting). Failures are
 * swallowed by `logBookingEvent`.
 */
export async function logSalonRushEvent(
  _slug: string,
  salonId: string,
  eventType: "rush_hour_started" | "rush_hour_ended",
  payload: Record<string, unknown>,
): Promise<void> {
  await logBookingEvent({
    bookingId: null,
    salonId,
    actorUserId: null,
    actorRole: "system",
    eventType,
    payload,
  });
}
