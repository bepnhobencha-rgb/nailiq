import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import {
  parseGroupBookingPricingQuote,
  type GroupBookingPricingQuote,
} from "@/shared/booking/groupBookingPricing";

const UUID = z.string().uuid();
const UTC = z.string().datetime({ offset: true });
const memberSchema = z
  .object({
    serviceId: UUID,
    staffId: UUID,
    startTimeUtc: UTC,
    endTimeUtc: UTC,
    addonServiceIds: z.array(UUID).max(8).default([]),
    clientName: z.string().trim().min(1).max(120),
    clientPhone: z.string().regex(/^\d{7,15}$/).nullable().optional(),
    clientEmail: z.string().email().max(254).nullable().optional(),
    clientNotes: z.string().trim().max(500).nullable().optional(),
    staffRequestedByClient: z.boolean().optional().default(true),
    waveNumber: z.number().int().min(1).max(20).optional().default(1),
    seatTogether: z.boolean().optional().default(false),
    clientLocale: z.enum(["en", "vi"]).nullable().optional(),
    resourceId: UUID.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.addonServiceIds).size !== value.addonServiceIds.length) {
      ctx.addIssue({ code: "custom", path: ["addonServiceIds"], message: "duplicate add-on" });
    }
    const start = Date.parse(value.startTimeUtc);
    const end = Date.parse(value.endTimeUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 12 * 60 * 60 * 1000) {
      ctx.addIssue({ code: "custom", path: ["endTimeUtc"], message: "invalid interval" });
    }
  });

const groupBookingRequestObject = z.object({
    salonId: UUID,
    bookings: z.array(memberSchema).min(2).max(20),
    voucherCode: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
    applyEmailDiscount: z.boolean().default(false),
  })
  .strict();

function validateOrganizer(
  value: z.infer<typeof groupBookingRequestObject>,
  ctx: z.RefinementCtx,
) {
  const organizer = value.bookings[0];
  if (!organizer.clientName) {
    ctx.addIssue({ code: "custom", path: ["bookings", 0, "clientName"], message: "organizer name required" });
  }
  if (!organizer.clientPhone) {
    ctx.addIssue({ code: "custom", path: ["bookings", 0, "clientPhone"], message: "organizer phone required" });
  }
}

export const groupBookingQuoteRequestSchema = groupBookingRequestObject.superRefine(validateOrganizer);

export const groupBookingCreateRequestSchema = groupBookingRequestObject
  .extend({
    idempotencyKey: UUID,
    expectedPricingFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
    otpSessionId: UUID.nullable().optional(),
    cardSourceId: z.string().trim().min(1).max(2048).optional(),
    cardVerificationToken: z.string().trim().min(1).max(2048).optional(),
    noShowConsent: z.boolean().optional(),
  })
  .superRefine(validateOrganizer);

export type GroupBookingQuoteServerRequest = z.infer<typeof groupBookingQuoteRequestSchema>;
export type GroupBookingCreateServerRequest = z.infer<typeof groupBookingCreateRequestSchema>;

type GroupQuoteResult =
  | { ok: true; quote: GroupBookingPricingQuote }
  | { ok: false; code: "invalid_request" | "voucher_invalid" | "quote_unavailable" | "pricing_invalid" };

export type GroupCreateResult =
  | {
      ok: true;
      groupId: string;
      bookingIds: string[];
      idempotent: boolean;
      pricing: GroupBookingPricingQuote;
    }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "voucher_invalid"
        | "pricing_changed"
        | "idempotency_conflict"
        | "slot_conflict"
        | "monthly_booking_limit_reached"
        | "create_unavailable"
        | "pricing_invalid";
      quote?: GroupBookingPricingQuote;
    };

export function groupBookingRateKey(kind: "ip" | "phone", value: string): string {
  return `public-group-booking:${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

export type GroupBookingBoundaryAuthorization =
  | { ok: true; phoneOtpEnabled: boolean }
  | { ok: false; code: "booking_unavailable" | "otp_required" | "otp_invalid" };

/** Server-only feature/tenant gate. It never returns salon metadata. */
export async function authorizeGroupBookingBoundary(args: {
  salonId: string;
  organizerPhone: string;
  otpSessionId?: string | null;
  requireOtp: boolean;
}): Promise<GroupBookingBoundaryAuthorization> {
  try {
    const client = createServiceRoleClient();
    const { data, error } = await client
      .from("salons" as never)
      .select("id, profile_complete, feature_flags, phone_otp_enabled")
      .eq("id" as never, args.salonId)
      .maybeSingle();
    if (error || !data) return { ok: false, code: "booking_unavailable" };
    const salon = data as unknown as {
      profile_complete?: unknown;
      feature_flags?: Record<string, unknown> | null;
      phone_otp_enabled?: unknown;
    };
    if (
      salon.profile_complete !== true ||
      !isReleaseFeatureEnabled({ feature_flags: salon.feature_flags }, "group_booking")
    ) return { ok: false, code: "booking_unavailable" };
    const phoneOtpEnabled = salon.phone_otp_enabled === true;
    if (!args.requireOtp || !phoneOtpEnabled) return { ok: true, phoneOtpEnabled };
    const sessionId = args.otpSessionId?.trim();
    if (!sessionId) return { ok: false, code: "otp_required" };
    const { data: valid, error: otpError } = await client.rpc(
      "validate_phone_otp_session" as never,
      {
        p_session_id: sessionId,
        p_salon_id: args.salonId,
        p_phone: args.organizerPhone,
      } as never,
    );
    if (otpError || valid !== true) return { ok: false, code: "otp_invalid" };
    return { ok: true, phoneOtpEnabled };
  } catch {
    return { ok: false, code: "booking_unavailable" };
  }
}

function toRpcBookings(bookings: GroupBookingQuoteServerRequest["bookings"]) {
  return bookings.map((booking) => ({
    service_id: booking.serviceId,
    staff_id: booking.staffId,
    start_time_utc: booking.startTimeUtc,
    end_time_utc: booking.endTimeUtc,
    addon_service_ids: booking.addonServiceIds,
    client_name: booking.clientName ?? null,
    client_phone: booking.clientPhone ?? null,
    client_email: booking.clientEmail ?? null,
    client_notes: booking.clientNotes ?? null,
    staff_requested_by_client: booking.staffRequestedByClient,
    wave_number: booking.waveNumber,
    seat_together: booking.seatTogether,
    client_locale: booking.clientLocale ?? null,
    resource_id: booking.resourceId ?? null,
  }));
}

async function resolveVoucher(
  salonId: string,
  voucherCode: string | null | undefined,
): Promise<{ ok: true; id: string | null; code: string | null } | { ok: false; code: "voucher_invalid" | "quote_unavailable" }> {
  if (!voucherCode) return { ok: true, id: null, code: null };
  const code = voucherCode.trim().toUpperCase();
  const { data, error } = await createServiceRoleClient()
    .from("vouchers" as never)
    .select("id")
    .eq("salon_id" as never, salonId)
    .eq("code" as never, code)
    .maybeSingle();
  if (error) return { ok: false, code: "quote_unavailable" };
  if (!data) return { ok: false, code: "voucher_invalid" };
  return { ok: true, id: String((data as { id: string }).id), code };
}

export async function resolveGroupBookingQuote(input: unknown): Promise<GroupQuoteResult> {
  const parsed = groupBookingQuoteRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_request" };
  const request = parsed.data;
  const organizer = request.bookings[0];
  const voucher = await resolveVoucher(request.salonId, request.voucherCode);
  if (!voucher.ok) return voucher;
  const { data, error } = await createServiceRoleClient().rpc(
    "quote_group_booking" as never,
    {
      p_salon_id: request.salonId,
      p_bookings: toRpcBookings(request.bookings),
      p_voucher_id: voucher.id,
      p_client_phone: organizer.clientPhone!,
      p_client_email: organizer.clientEmail ?? null,
      p_apply_email_discount: request.applyEmailDiscount && Boolean(organizer.clientEmail),
    } as never,
  );
  if (error || data == null) return { ok: false, code: "quote_unavailable" };
  const raw = Array.isArray(data) ? data[0] : data;
  if (raw && typeof raw === "object" && (raw as { success?: unknown }).success === false) {
    return {
      ok: false,
      code: (raw as { code?: unknown }).code === "voucher_invalid"
        ? "voucher_invalid"
        : "quote_unavailable",
    };
  }
  const quote = parseGroupBookingPricingQuote(raw, { voucherCode: voucher.code });
  return quote ? { ok: true, quote } : { ok: false, code: "pricing_invalid" };
}

export async function createGroupBookingsAuthoritative(input: unknown): Promise<GroupCreateResult> {
  const parsed = groupBookingCreateRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_request" };
  const request = parsed.data;
  const organizer = request.bookings[0];
  const voucher = await resolveVoucher(request.salonId, request.voucherCode);
  if (!voucher.ok) {
    return { ok: false, code: voucher.code === "voucher_invalid" ? "voucher_invalid" : "create_unavailable" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "create_group_bookings" as never,
    {
      p_salon_id: request.salonId,
      p_bookings: toRpcBookings(request.bookings),
      p_voucher_id: voucher.id,
      p_client_phone: organizer.clientPhone!,
      p_client_email: organizer.clientEmail ?? null,
      p_apply_email_discount: request.applyEmailDiscount && Boolean(organizer.clientEmail),
      p_group_idempotency_key: request.idempotencyKey,
      p_expected_pricing_fingerprint: request.expectedPricingFingerprint,
    } as never,
  );
  if (error || data == null) return { ok: false, code: "create_unavailable" };
  const raw = Array.isArray(data) ? data[0] : data;
  if (!raw || typeof raw !== "object") return { ok: false, code: "create_unavailable" };
  const response = raw as Record<string, unknown>;
  if (response.success === false) {
    if (response.code === "pricing_changed") {
      const quote = parseGroupBookingPricingQuote(response.quote, { voucherCode: voucher.code });
      return quote
        ? { ok: false, code: "pricing_changed", quote }
        : { ok: false, code: "pricing_invalid" };
    }
    if (response.code === "idempotency_conflict") return { ok: false, code: "idempotency_conflict" };
    if (response.code === "slot_conflict") return { ok: false, code: "slot_conflict" };
    if (response.code === "monthly_booking_limit_reached") {
      return { ok: false, code: "monthly_booking_limit_reached" };
    }
    if (response.code === "voucher_invalid") return { ok: false, code: "voucher_invalid" };
    return { ok: false, code: "create_unavailable" };
  }
  const pricing = parseGroupBookingPricingQuote(response, { voucherCode: voucher.code });
  const groupId = typeof response.group_id === "string" ? response.group_id : "";
  const bookingIds = Array.isArray(response.booking_ids)
    ? response.booking_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (
    !pricing ||
    !groupId ||
    bookingIds.length !== request.bookings.length ||
    bookingIds.length !== pricing.groupSize
  ) return { ok: false, code: "pricing_invalid" };
  return {
    ok: true,
    groupId,
    bookingIds,
    idempotent: response.idempotent === true,
    pricing,
  };
}
