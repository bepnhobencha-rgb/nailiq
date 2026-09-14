import { committedCardRecoveryHref } from "@/shared/booking/committedCardRecovery";
import {
  parsePublicBookingPricingQuote,
  type PublicBookingPricingQuote,
} from "@/shared/booking/publicBookingPricing";
import type { PublicBookingRequestMaterial } from "@/shared/booking/publicBookingRequestId";
import type { BookingParams, BookingResult } from "@/shared/booking/submitPublicBooking";
import { v1AllowsNoShowCardOnFile } from "@/shared/release/v1IntegrationScope";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{64}$/i;
const RECOVERY_REQUIRED = "deposit_booking_recovery_required";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameInstant(left: string, right: string): boolean {
  return Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
}

function matchesRetainedQuote(
  material: PublicBookingRequestMaterial,
  quote: PublicBookingPricingQuote,
): boolean {
  return [material.salonId, material.serviceId, material.staffId].every(id => UUID.test(id)) &&
    [material.resourceId, material.comboId, material.voucherId].every(id => id === null || UUID.test(id)) &&
    typeof material.clientName === "string" && material.clientName.trim().length > 0 &&
    typeof material.clientPhone === "string" && /^\d{8,15}$/.test(material.clientPhone) &&
    (material.clientNotes === null || typeof material.clientNotes === "string") &&
    (material.clientEmail === null || typeof material.clientEmail === "string") &&
    typeof material.applyEmailDiscount === "boolean" &&
    FINGERPRINT.test(material.expectedPricingFingerprint) &&
    material.expectedPricingFingerprint === quote.pricingFingerprint &&
    material.salonId === quote.salonId && material.serviceId === quote.serviceId &&
    material.staffId === quote.resolvedStaffId && material.comboId === quote.comboId &&
    material.voucherId === quote.voucherId &&
    sameInstant(material.startTimeUtc, quote.startTimeUtc) &&
    sameInstant(material.endTimeUtc, quote.endTimeUtc) &&
    Date.parse(material.endTimeUtc) > Date.parse(material.startTimeUtc) &&
    Array.isArray(material.addonServiceIds) && material.addonServiceIds.every(id => UUID.test(id)) &&
    Array.isArray(quote.addonLines) &&
    JSON.stringify(material.addonServiceIds) === JSON.stringify(quote.addonLines.map(line => line.serviceId));
}

/** Display labels derived from caller context are excluded. Every receipt
 * amount, identity, interval and persisted pricing line must match the quote. */
function comparablePricing(quote: PublicBookingPricingQuote): string {
  return JSON.stringify([
    quote.pricingFingerprint, quote.salonId, quote.serviceId, quote.resolvedStaffId,
    Date.parse(quote.startTimeUtc), Date.parse(quote.endTimeUtc), quote.comboId,
    quote.voucherId, quote.currency, quote.serviceOriginalCents, quote.serviceNetCents,
    quote.serviceFinalCents, quote.addonPreVoucherCents, quote.addonCents, quote.promoId,
    quote.promoName, quote.promoDiscountCents, quote.emailDiscountCents,
    quote.voucherDiscountCents, quote.preVoucherSubtotalCents, quote.subtotalCents,
    quote.taxCents, quote.totalCents,
    quote.taxBreakdown.map(line => [line.name, line.rate, line.amountCents]),
    quote.addonLines.map(line => [line.serviceId, line.name, line.priceCents,
      line.durationMinutes, line.bufferMinutes, line.addonTiming]),
  ]);
}

/** Recover only an already-bound paid booking. Never re-read mutable booking
 * eligibility, create a fresh appointment, reuse a card source or resend any
 * post-commit work. The service-only replay RPC validates full fingerprints. */
export async function replayPaidPublicBooking(params: BookingParams): Promise<BookingResult> {
  const material = params.paidReplayMaterial;
  const expected = params.expectedPricingQuote;
  const paid = params.paidDeposit;
  const idempotencyKey = params.idempotencyKey;
  let expectedPricing: string;
  try {
    if (!material || !expected || !paid || !UUID.test(idempotencyKey ?? "") ||
      !UUID.test(paid.operationId) || !UUID.test(paid.paymentRequestId) ||
      !FINGERPRINT.test(paid.materialFingerprint) || !matchesRetainedQuote(material, expected)) {
      throw new Error(RECOVERY_REQUIRED);
    }
    expectedPricing = comparablePricing(expected);
  } catch {
    throw new Error(RECOVERY_REQUIRED);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let envelope: Record<string, unknown>;
  let pricing: PublicBookingPricingQuote;
  try {
    const value = await Promise.race([
      (async () => {
        const response = await fetch("/api/booking/deposit-create", {
          method: "POST", headers: { "Content-Type": "application/json" },
          cache: "no-store", signal: controller.signal,
          body: JSON.stringify({
            salonId: material.salonId, serviceId: material.serviceId, staffId: material.staffId,
            clientName: material.clientName, clientPhone: material.clientPhone,
            startTimeUtc: material.startTimeUtc, endTimeUtc: material.endTimeUtc,
            clientNotes: material.clientNotes, addonServiceIds: material.addonServiceIds,
            clientEmail: material.clientEmail, resourceId: material.resourceId,
            comboId: material.comboId, voucherId: material.voucherId,
            applyEmailDiscount: material.applyEmailDiscount, idempotencyKey,
            pricingFingerprint: material.expectedPricingFingerprint,
            paymentOperationId: paid.operationId, paymentRequestId: paid.paymentRequestId,
            paymentMaterialFingerprint: paid.materialFingerprint,
            replayOnly: true,
            // Committed replay needs no new or unused OTP; never turn a fresh
            // session into permission to fall through to paid booking creation.
            otpSessionId: null,
          }),
        });
        if (!response.ok) throw new Error(RECOVERY_REQUIRED);
        return await response.json() as unknown;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(RECOVERY_REQUIRED));
        }, 12_000);
      }),
    ]);
    if (!record(value) || value.success !== true || value.idempotent !== true ||
      value.code !== "booking_payment_replay" || value.payment_status !== "succeeded" ||
      value.operation_id !== paid.operationId || value.material_fingerprint !== paid.materialFingerprint ||
      typeof value.booking_id !== "string" || !UUID.test(value.booking_id) ||
      !record(value.booking) || value.booking.booking_id !== value.booking_id ||
      value.booking.staff_id !== material.staffId) {
      throw new Error(RECOVERY_REQUIRED);
    }
    const parsed = parsePublicBookingPricingQuote(value.booking, {
      resolvedStaffId: material.staffId, resolvedStaffName: expected.resolvedStaffName,
      voucherCode: expected.voucherCode,
    });
    if (!parsed || comparablePricing(parsed) !== expectedPricing) throw new Error(RECOVERY_REQUIRED);
    envelope = value;
    pricing = parsed;
  } catch {
    // Payloads contain contact data and bearer bindings. Report only this safe
    // recovery code; a network/read failure never permits another create call.
    throw new Error(RECOVERY_REQUIRED);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const bookingId = envelope.booking_id as string;
  // A payment/booking receipt does not prove card protection. Keep recovery
  // visible when that feature is enabled, without replaying a saved source.
  const cardManagementPending = v1AllowsNoShowCardOnFile();
  return {
    bookingId,
    serviceName: params.paidReplayServiceName?.trim() ||
      (params.language === "vi" ? "Dịch vụ đã đặt" : "Reserved service"),
    startTimeUtc: pricing.startTimeUtc, endTimeUtc: pricing.endTimeUtc,
    status: "confirmed", price_cents: pricing.subtotalCents,
    staffName: pricing.resolvedStaffName,
    addonServiceName: pricing.addonLines[0]?.name ?? null,
    addonPriceCents: pricing.addonLines.length ? pricing.addonCents : null,
    addons: pricing.addonLines.map(line => ({ serviceId: line.serviceId,
      name: line.name, priceCents: line.priceCents })),
    servicePriceCents: pricing.serviceFinalCents, subtotalCents: pricing.subtotalCents,
    taxCents: pricing.taxCents, totalCents: pricing.totalCents, currency: pricing.currency,
    discountLines: pricing.discountLines, pricing,
    cardManagementToken: null,
    cardManagementRecoveryHref: cardManagementPending ? committedCardRecoveryHref({
      salonId: material.salonId, bookingId, idempotencyKey: idempotencyKey!,
      pricingFingerprint: pricing.pricingFingerprint,
    }) : null,
    cardManagementPending,
    confirmationDelivery: {
      sms: params.smsConsent === true ? "unverified" : "not_requested",
      email: material.clientEmail?.trim() ? "unverified" : "not_requested",
    },
  };
}
