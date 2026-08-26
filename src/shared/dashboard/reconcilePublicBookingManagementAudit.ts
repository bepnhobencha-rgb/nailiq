import "server-only";

import { stableBookingIdempotencyKey } from "@/shared/booking/stableBookingIdempotencyKey";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export async function reconcilePublicBookingManagementAudit(input: {
  bookingId: string;
  salonId: string;
  requestId: string;
  action: "reschedule" | "cancel" | "rsvp_decline";
  payload: Record<string, unknown>;
}): Promise<void> {
  const eventType = input.action === "reschedule" ? "booking_rescheduled" : "booking_cancelled";
  const id = stableBookingIdempotencyKey({
    channel: "public_booking_management_audit",
    salonId: input.salonId,
    bookingId: input.bookingId,
    requestId: input.requestId,
    eventType,
  });
  try {
    const { error } = await createServiceRoleClient()
      .from("booking_events" as never)
      .insert({
        id,
        booking_id: input.bookingId,
        salon_id: input.salonId,
        actor_user_id: null,
        actor_role: "public_guest",
        event_type: eventType,
        payload: { ...input.payload, management_request_id: input.requestId },
      } as never);
    if (error && (error as { code?: string }).code !== "23505") {
      console.error("[reconcilePublicBookingManagementAudit] insert", error);
    }
  } catch (error) {
    console.error("[reconcilePublicBookingManagementAudit] threw", error);
  }
}
