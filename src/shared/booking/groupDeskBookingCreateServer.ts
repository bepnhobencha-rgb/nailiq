import "server-only";

import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parseGroupBookingPricingQuote } from "@/shared/booking/groupBookingPricing";
import {
  groupBookingCreateRequestSchema,
  type GroupCreateResult,
} from "@/shared/booking/groupBookingPricingServer";

/** Internal desk boundary. actorUserId comes from the authenticated dashboard
 * context; the SQL wrapper independently verifies membership in this salon. */
export async function createDeskGroupBookingsAuthoritative(
  input: unknown,
  actorUserId: string,
): Promise<GroupCreateResult> {
  const parsed = groupBookingCreateRequestSchema.safeParse(input);
  if (!parsed.success || !z.string().uuid().safeParse(actorUserId).success) {
    return { ok: false, code: "invalid_request" };
  }
  const request = parsed.data;
  if (request.applyEmailDiscount || request.voucherCode || request.otpSessionId ||
    request.cardSourceId || request.cardVerificationToken || request.noShowConsent) {
    return { ok: false, code: "invalid_request" };
  }
  const organizer = request.bookings[0];
  const { data, error } = await createServiceRoleClient().rpc(
    "create_group_bookings_for_desk" as never,
    {
      p_salon_id: request.salonId,
      p_bookings: request.bookings.map((booking) => ({
        service_id: booking.serviceId, staff_id: booking.staffId,
        start_time_utc: booking.startTimeUtc, end_time_utc: booking.endTimeUtc,
        addon_service_ids: booking.addonServiceIds, client_name: booking.clientName,
        client_phone: booking.clientPhone ?? null, client_email: booking.clientEmail ?? null,
        client_notes: booking.clientNotes ?? null, staff_requested_by_client: booking.staffRequestedByClient,
        wave_number: booking.waveNumber, seat_together: booking.seatTogether,
        client_locale: booking.clientLocale ?? null, resource_id: booking.resourceId ?? null,
      })),
      p_voucher_id: null, p_client_phone: organizer.clientPhone,
      p_client_email: organizer.clientEmail ?? null, p_apply_email_discount: false,
      p_group_idempotency_key: request.idempotencyKey,
      p_expected_pricing_fingerprint: request.expectedPricingFingerprint,
      p_actor_user_id: actorUserId,
    } as never,
  );
  if (error || !data || typeof data !== "object") return { ok: false, code: "create_unavailable" };
  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw || typeof raw !== "object") return { ok: false, code: "create_unavailable" };
  const result = raw as Record<string, unknown>;
  if (result.success !== true) {
    if (result.code === "pricing_changed") {
      const quote = parseGroupBookingPricingQuote(result.quote, { voucherCode: null });
      return quote ? { ok: false, code: "pricing_changed", quote } : { ok: false, code: "pricing_invalid" };
    }
    if (result.code === "slot_conflict" || result.code === "idempotency_conflict" ||
      result.code === "monthly_booking_limit_reached") return { ok: false, code: result.code };
    return { ok: false, code: "create_unavailable" };
  }
  const pricing = parseGroupBookingPricingQuote(result, { voucherCode: null });
  const bookingIds = Array.isArray(result.booking_ids) ? result.booking_ids.filter((id): id is string => typeof id === "string" && z.string().uuid().safeParse(id).success) : [];
  if (!pricing || !z.string().uuid().safeParse(result.group_id).success ||
    bookingIds.length !== request.bookings.length || bookingIds.length !== pricing.groupSize ||
    new Set(bookingIds).size !== bookingIds.length) return { ok: false, code: "pricing_invalid" };
  return { ok: true, groupId: result.group_id as string, bookingIds, pricing, idempotent: result.idempotent === true };
}
