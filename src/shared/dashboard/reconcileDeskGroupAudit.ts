import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  type ActorRole,
  type BookingEventType,
} from "@/shared/dashboard/auditLog";
import { stableBookingIdempotencyKey } from "@/shared/booking/stableBookingIdempotencyKey";

/** Reconcile the one creation audit fact for each committed group member.
 * A response-loss retry fills a missing event but does not append another
 * booking_created event for the same logical request. */
export async function reconcileDeskGroupCreationAudit(args: {
  bookingIds: string[];
  salonId: string;
  actorUserId: string | null;
  actorRole: ActorRole;
  requestId: string;
  afterHours: boolean;
  staffIds: string[];
}): Promise<void> {
  const db = createServiceRoleClient();
  const eventType: BookingEventType = args.afterHours
    ? "booking_after_hours_created"
    : "booking_created";
  for (const bookingId of args.bookingIds) {
    // Deterministic primary key makes the append atomic under concurrent
    // response-loss retries: one INSERT wins and 23505 means already recorded.
    const eventId = stableBookingIdempotencyKey({
      channel: "desk_group_audit",
      salonId: args.salonId,
      bookingId,
      eventType,
      requestId: args.requestId,
    });
    const { error } = await db
      .from("booking_events" as never)
      .insert({
        id: eventId,
        booking_id: bookingId,
        salon_id: args.salonId,
        actor_user_id: args.actorUserId,
        actor_role: args.actorRole,
        event_type: eventType,
        payload: {
          source: "desk_group",
          memberCount: args.bookingIds.length,
          group_request_id: args.requestId,
          ...(args.afterHours
            ? {
                staffConsentConfirmed: true,
                approvedBy: args.actorUserId,
                staffIds: args.staffIds,
              }
            : {}),
        },
      } as never);
    if (error) {
      if ((error as { code?: string }).code === "23505") continue;
      console.error("[reconcileDeskGroupCreationAudit] insert", error);
    }
  }
}
