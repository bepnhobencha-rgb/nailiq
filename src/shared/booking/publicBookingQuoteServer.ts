import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parsePublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";

const UUID = z.string().uuid();
const UTC_INSTANT = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));

export const publicBookingQuoteRequestSchema = z
  .object({
    salonId: UUID,
    serviceId: UUID,
    resolvedStaffId: UUID,
    resolvedStaffName: z.string().trim().max(120).optional().default(""),
    startTimeUtc: UTC_INSTANT,
    endTimeUtc: UTC_INSTANT,
    addonServiceIds: z.array(UUID).max(8).default([]),
    comboId: UUID.nullable().optional().default(null),
    voucherCode: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
      .optional()
      .default(null),
    clientPhone: z.string().regex(/^\d{7,15}$/),
    clientEmail: z.string().email().max(254).nullable().optional().default(null),
    applyEmailDiscount: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.addonServiceIds).size !== value.addonServiceIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["addonServiceIds"],
        message: "duplicate add-on",
      });
    }
    const startMs = Date.parse(value.startTimeUtc);
    const endMs = Date.parse(value.endTimeUtc);
    if (endMs <= startMs || endMs - startMs > 12 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: "custom",
        path: ["endTimeUtc"],
        message: "invalid booking interval",
      });
    }
  });

export type PublicBookingQuoteRequest = z.infer<
  typeof publicBookingQuoteRequestSchema
>;

type QuoteFailure = {
  ok: false;
  code:
    | "invalid_request"
    | "voucher_invalid"
    | "quote_unavailable"
    | "pricing_invalid";
};

type QuoteSuccess = {
  ok: true;
  quote: NonNullable<ReturnType<typeof parsePublicBookingPricingQuote>>;
};

export type PublicBookingQuoteServerResult = QuoteSuccess | QuoteFailure;

export function publicBookingQuoteRateKey(
  kind: "ip" | "phone",
  value: string,
): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `public-booking-quote:${kind}:${digest}`;
}

/** Calls only the internal service-role pricing resolver. No booking, voucher
 * redemption, email claim, notification, or provider call can occur here. */
export async function resolvePublicBookingQuote(
  input: PublicBookingQuoteRequest,
): Promise<PublicBookingQuoteServerResult> {
  const parsed = publicBookingQuoteRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_request" };
  const request = parsed.data;
  const db = createServiceRoleClient();

  let voucherId: string | null = null;
  let voucherCode: string | null = null;
  if (request.voucherCode) {
    voucherCode = request.voucherCode.toUpperCase();
    const { data: voucher, error } = await db
      .from("vouchers" as never)
      .select("id, code")
      .eq("salon_id" as never, request.salonId)
      .eq("code" as never, voucherCode)
      .maybeSingle();
    if (error) return { ok: false, code: "quote_unavailable" };
    if (!voucher) return { ok: false, code: "voucher_invalid" };
    voucherId = String((voucher as { id: string }).id);
  }

  const { data, error } = await db.rpc(
    "resolve_public_booking_pricing" as never,
    {
      p_salon_id: request.salonId,
      p_service_id: request.serviceId,
      p_staff_id: request.resolvedStaffId,
      p_start_time_utc: request.startTimeUtc,
      p_end_time_utc: request.endTimeUtc,
      p_addon_service_ids: request.addonServiceIds,
      p_combo_id: request.comboId,
      p_voucher_id: voucherId,
      p_client_phone: request.clientPhone,
      p_client_email: request.clientEmail,
      p_apply_email_discount:
        request.applyEmailDiscount && request.clientEmail !== null,
      p_lock_claims: false,
    } as never,
  );
  if (error || data == null) return { ok: false, code: "quote_unavailable" };

  const raw = Array.isArray(data) ? data[0] : data;
  if (
    raw &&
    typeof raw === "object" &&
    (raw as { success?: unknown }).success === false
  ) {
    return {
      ok: false,
      code:
        (raw as { code?: unknown }).code === "voucher_invalid"
          ? "voucher_invalid"
          : "quote_unavailable",
    };
  }
  const quote = parsePublicBookingPricingQuote(raw, {
    resolvedStaffId: request.resolvedStaffId,
    resolvedStaffName: request.resolvedStaffName,
    voucherCode,
  });
  if (!quote) return { ok: false, code: "pricing_invalid" };
  return { ok: true, quote };
}
