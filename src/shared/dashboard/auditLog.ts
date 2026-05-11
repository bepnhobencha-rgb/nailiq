import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Append-only audit log for booking mutations. Writes go through the
 * service-role client so they bypass RLS — the table's RLS policies
 * gate **reads**, not writes (no auth.uid() context exists for some
 * writers, e.g. demo cookie or public guest paths).
 *
 * Fire-and-forget by design: callers never await an error, never
 * surface failures to the user, and a logging hiccup must not roll
 * back the underlying mutation. We log the error to the server console
 * for ops triage but always resolve `void`.
 */

export type BookingEventType =
  | "booking_created"
  | "booking_edited"
  | "booking_cancelled"
  | "booking_status_changed"
  | "walkin_added"
  | "addon_added"
  /* Operational metrics (PR #104) — feed future analytics on
   * walk-away rate, average wait acceptance, queue conversion. */
  | "queue_joined"
  | "queue_assigned"
  | "queue_left"
  | "soft_hold_set"
  | "soft_hold_expired"
  | "rush_hour_started"
  | "rush_hour_ended";

export type ActorRole =
  | "owner"
  | "senior"
  | "nail_tech"
  | "manager"
  | "trainee"
  | "viewer"
  | "accounting"
  | "public_guest"
  | "demo_cookie"
  | "system";

export type LogBookingEventInput = {
  /** Booking this event pertains to. Null for salon-scoped events
   * (`rush_hour_started`, `rush_hour_ended`) that span the desk
   * rather than a single booking. */
  bookingId: string | null;
  salonId: string;
  /** Null for public-guest / demo-cookie / system writers. */
  actorUserId: string | null;
  actorRole: ActorRole;
  eventType: BookingEventType;
  /** Free-form JSON metadata — kept small (changed fields, prior values). */
  payload?: Record<string, unknown>;
};

/**
 * Best-effort write to `booking_events`. Returns void unconditionally.
 * Callers should invoke without `await` when latency matters; otherwise
 * `await` is safe — the promise never rejects.
 */
export async function logBookingEvent(input: LogBookingEventInput): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase
      .from("booking_events")
      // Cast: `booking_events` not yet in the auto-generated types.
      // Will become a typed call after the next regeneration.
      .insert({
        booking_id: input.bookingId,
        salon_id: input.salonId,
        actor_user_id: input.actorUserId,
        actor_role: input.actorRole,
        event_type: input.eventType,
        payload: input.payload ?? {},
      } as never);

    if (error) {
      console.error("[logBookingEvent]", {
        eventType: input.eventType,
        bookingId: input.bookingId,
        salonId: input.salonId,
        error: error.message,
      });
    }
  } catch (err) {
    // serviceRole env vars missing, network blip, etc. Never propagate.
    console.error("[logBookingEvent] threw", err);
  }
}
