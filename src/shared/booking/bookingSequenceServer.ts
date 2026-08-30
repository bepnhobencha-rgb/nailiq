import "server-only";

import { createHash } from "node:crypto";

import {
  canonicalizeUtcInstant,
  parseSequenceBookingIntent,
  parseSequenceTimingSegments,
  serializeSequenceBookingIntent,
  type SequenceBookingIntent,
  type SequenceTimingSegment,
} from "@/shared/booking/bookingSequence";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  isSupportedCurrency,
  type Currency,
} from "@/shared/lib/currencyFormat";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

type TaxLine = { name: string; rate: number; amountCents: number };
type AddonLine = {
  serviceId: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
};

export type BookingSequenceQuoteLine = SequenceTimingSegment & {
  serviceName: string;
  staffName: string;
  addonLines: AddonLine[];
  originalServicePriceCents: number;
  servicePreVoucherCents: number;
  addonPreVoucherCents: number;
  promoDiscountCents: number;
  emailDiscountCents: number;
  voucherDiscountCents: number;
  servicePriceCents: number;
  addonPriceCents: number;
  preVoucherSubtotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBreakdown: TaxLine[];
};

export type BookingSequenceQuote = {
  requestId: string;
  salonId: string;
  pricingFingerprint: string;
  currency: Currency;
  requestedStartTimeUtc: string;
  parentStartTimeUtc: string;
  parentEndTimeUtc: string;
  sameStaffForAll: boolean;
  originalPriceCents: number;
  promoDiscountCents: number;
  emailDiscountCents: number;
  voucherDiscountCents: number;
  preVoucherSubtotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBreakdown: TaxLine[];
  lines: BookingSequenceQuoteLine[];
};

export type BookingSequenceCreateResult =
  | {
      ok: true;
      bookingId: string;
      segmentIds: string[];
      idempotent: boolean;
      quote: BookingSequenceQuote;
      salonSlug: string;
      smsConsent: boolean;
      language: "en" | "vi";
    }
  | {
      ok: false;
      code:
        | "invalid_request"
        | "not_ready"
        | "payment_not_supported"
        | "otp_required"
        | "invalid_otp_session"
        | "otp_session_used"
        | "otp_not_required"
        | "health_ack_required"
        | "pricing_changed"
        | "idempotency_conflict"
        | "booking_state_changed"
        | "slot_conflict"
        | "monthly_booking_limit_reached"
        | "replay_not_found"
        | "create_unavailable";
      quote?: BookingSequenceQuote;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedText(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function parseTaxBreakdown(value: unknown, expected: number): TaxLine[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const parsed: TaxLine[] = [];
  for (const raw of value) {
    const row = record(raw);
    const name = boundedText(row?.name, 120);
    const rate = row?.rate;
    const amountCents = cents(row?.amount_cents);
    if (
      !row ||
      !name ||
      typeof rate !== "number" ||
      !Number.isFinite(rate) ||
      rate < 0 ||
      rate > 1 ||
      amountCents == null
    ) {
      return null;
    }
    parsed.push({ name, rate, amountCents });
  }
  return parsed.reduce((sum, line) => sum + line.amountCents, 0) === expected
    ? parsed
    : null;
}

function parseAddonLines(value: unknown, expected: number): AddonLine[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const parsed: AddonLine[] = [];
  for (const raw of value) {
    const row = record(raw);
    const serviceId = uuid(row?.service_id);
    const name = boundedText(row?.name, 160);
    const priceCents = cents(row?.price_cents);
    const durationMinutes = cents(row?.duration_minutes);
    if (!serviceId || !name || priceCents == null || durationMinutes == null) {
      return null;
    }
    parsed.push({ serviceId, name, priceCents, durationMinutes });
  }
  return parsed.reduce((sum, line) => sum + line.priceCents, 0) === expected
    ? parsed
    : null;
}

/** Strict parser for the only pricing material the browser may render. */
export function parseBookingSequenceQuote(
  value: unknown,
): BookingSequenceQuote | null {
  const row = record(value);
  if (
    !row ||
    row.success !== true ||
    (row.code !== "quoted" && row.code !== "booked") ||
    row.contract_version !== 1 ||
    row.schedule_model !== "segments_v1" ||
    row.sequence_version !== 1 ||
    typeof row.same_staff_for_all !== "boolean" ||
    row.tax_amount_cents !== row.tax_cents
  ) {
    return null;
  }
  const requestId = uuid(row.request_id);
  const salonId = uuid(row.salon_id);
  const pricingFingerprint = boundedText(row.pricing_fingerprint, 64);
  const requestedStartTimeUtc = canonicalizeUtcInstant(row.requested_start_time_utc);
  const parentStartTimeUtc = canonicalizeUtcInstant(row.parent_start_time_utc);
  const parentEndTimeUtc = canonicalizeUtcInstant(row.parent_end_time_utc);
  const currency = boundedText(row.currency, 8);
  const timing = parseSequenceTimingSegments(row.timing_segments);
  const readiness = record(row.readiness);
  if (
    !requestId ||
    !salonId ||
    !pricingFingerprint ||
    !SHA256_RE.test(pricingFingerprint) ||
    !requestedStartTimeUtc ||
    !parentStartTimeUtc ||
    !parentEndTimeUtc ||
    !currency ||
    !isSupportedCurrency(currency) ||
    !readiness ||
    readiness.contract_version !== 1 ||
    readiness.schedule_model !== "segments_v1" ||
    readiness.platform_enabled !== true ||
    readiness.salon_enabled !== true ||
    readiness.qa_allowlisted !== true ||
    readiness.catalog_ready !== true ||
    readiness.capacity_contract_ready !== true ||
    readiness.payment_policy_ready !== true ||
    readiness.ready !== true ||
    !timing ||
    !Array.isArray(row.segments) ||
    row.segments.length !== timing.length
  ) {
    return null;
  }

  const lines: BookingSequenceQuoteLine[] = [];
  for (let position = 0; position < timing.length; position += 1) {
    const raw = record(row.segments[position]);
    const time = timing[position];
    const originalServicePriceCents = cents(raw?.original_service_price_cents);
    const servicePreVoucherCents = cents(raw?.service_pre_voucher_cents);
    const addonPreVoucherCents = cents(raw?.addon_pre_voucher_cents);
    const promoDiscountCents = cents(raw?.promo_discount_cents);
    const emailDiscountCents = cents(raw?.email_discount_cents);
    const voucherDiscountCents = cents(raw?.voucher_discount_cents);
    const servicePriceCents = cents(raw?.service_price_cents);
    const addonPriceCents = cents(raw?.addon_price_cents);
    const preVoucherSubtotalCents = cents(raw?.pre_voucher_subtotal_cents);
    const subtotalCents = cents(raw?.subtotal_cents);
    const taxCents = cents(raw?.tax_cents);
    const totalCents = cents(raw?.total_cents);
    if (
      !raw ||
      raw.position !== position ||
      uuid(raw.line_id) !== time.lineId ||
      uuid(raw.service_id) !== time.serviceId ||
      uuid(raw.resolved_staff_id) !== time.resolvedStaffId ||
      (raw.resolved_resource_id == null
        ? null
        : uuid(raw.resolved_resource_id)) !== time.resolvedResourceId ||
      raw.prep_minutes !== time.prepMinutes ||
      raw.duration_minutes !== time.durationMinutes ||
      raw.buffer_minutes !== time.bufferMinutes ||
      canonicalizeUtcInstant(raw.occupied_start_utc) !== time.occupiedStartUtc ||
      canonicalizeUtcInstant(raw.service_start_utc) !== time.serviceStartUtc ||
      canonicalizeUtcInstant(raw.service_end_utc) !== time.serviceEndUtc ||
      canonicalizeUtcInstant(raw.occupied_end_utc) !== time.occupiedEndUtc ||
      !boundedText(raw.service_name) ||
      !boundedText(raw.staff_name) ||
      originalServicePriceCents == null ||
      servicePreVoucherCents == null ||
      addonPreVoucherCents == null ||
      promoDiscountCents == null ||
      emailDiscountCents == null ||
      voucherDiscountCents == null ||
      servicePriceCents == null ||
      addonPriceCents == null ||
      preVoucherSubtotalCents == null ||
      subtotalCents == null ||
      taxCents == null ||
      totalCents == null ||
      originalServicePriceCents - promoDiscountCents !== servicePreVoucherCents ||
      servicePreVoucherCents - emailDiscountCents + addonPreVoucherCents !==
        preVoucherSubtotalCents ||
      preVoucherSubtotalCents - voucherDiscountCents !== subtotalCents ||
      servicePriceCents + addonPriceCents !== subtotalCents ||
      subtotalCents + taxCents !== totalCents ||
      (position > 0 && emailDiscountCents !== 0)
    ) {
      return null;
    }
    const addonLines = parseAddonLines(raw.addon_lines, addonPreVoucherCents);
    const taxBreakdown = parseTaxBreakdown(raw.tax_breakdown, taxCents);
    const addonServiceIds = Array.isArray(raw.addon_service_ids)
      ? raw.addon_service_ids.map(uuid)
      : null;
    const firstAddonId = raw.first_addon_id == null ? null : uuid(raw.first_addon_id);
    if (
      !addonLines ||
      !taxBreakdown ||
      !addonServiceIds ||
      addonServiceIds.some((id) => !id) ||
      addonServiceIds.length !== addonLines.length ||
      addonServiceIds.some((id, index) => id !== addonLines[index]?.serviceId) ||
      firstAddonId !== (addonServiceIds[0] ?? null)
    ) return null;
    lines.push({
      ...time,
      serviceName: boundedText(raw.service_name)!,
      staffName: boundedText(raw.staff_name)!,
      addonLines,
      originalServicePriceCents,
      servicePreVoucherCents,
      addonPreVoucherCents,
      promoDiscountCents,
      emailDiscountCents,
      voucherDiscountCents,
      servicePriceCents,
      addonPriceCents,
      preVoucherSubtotalCents,
      subtotalCents,
      taxCents,
      totalCents,
      taxBreakdown,
    });
  }

  const originalPriceCents = cents(row.original_price_cents);
  const promoDiscountCents = cents(row.promo_discount_cents);
  const emailDiscountCents = cents(row.email_discount_cents);
  const voucherDiscountCents = cents(row.voucher_discount_cents);
  const preVoucherSubtotalCents = cents(row.pre_voucher_subtotal_cents);
  const subtotalCents = cents(row.subtotal_cents);
  const taxCents = cents(row.tax_cents);
  const totalCents = cents(row.total_cents);
  if (
    originalPriceCents == null ||
    promoDiscountCents == null ||
    emailDiscountCents == null ||
    voucherDiscountCents == null ||
    preVoucherSubtotalCents == null ||
    subtotalCents == null ||
    taxCents == null ||
    totalCents == null ||
    lines.reduce((sum, line) => sum + line.originalServicePriceCents, 0) !==
      originalPriceCents ||
    lines.reduce((sum, line) => sum + line.promoDiscountCents, 0) !==
      promoDiscountCents ||
    lines.reduce((sum, line) => sum + line.emailDiscountCents, 0) !==
      emailDiscountCents ||
    lines.reduce((sum, line) => sum + line.voucherDiscountCents, 0) !==
      voucherDiscountCents ||
    lines.reduce((sum, line) => sum + line.preVoucherSubtotalCents, 0) !==
      preVoucherSubtotalCents ||
    lines.reduce((sum, line) => sum + line.subtotalCents, 0) !== subtotalCents ||
    lines.reduce((sum, line) => sum + line.taxCents, 0) !== taxCents ||
    lines.reduce((sum, line) => sum + line.totalCents, 0) !== totalCents
  ) {
    return null;
  }
  const taxBreakdown = parseTaxBreakdown(row.tax_breakdown, taxCents);
  if (
    !taxBreakdown ||
    taxBreakdown.some((tax, index) =>
      lines.some((line) => {
        const memberTax = line.taxBreakdown[index];
        return !memberTax || memberTax.name !== tax.name || memberTax.rate !== tax.rate;
      }) ||
      lines.reduce((sum, line) => sum + line.taxBreakdown[index].amountCents, 0) !==
        tax.amountCents
    ) ||
    lines.some((line) => line.taxBreakdown.length !== taxBreakdown.length) ||
    parentStartTimeUtc !== new Date(Math.min(
      ...timing.map((line) => Date.parse(line.serviceStartUtc)),
    )).toISOString() ||
    parentEndTimeUtc !== new Date(Math.max(
      ...timing.map((line) => Date.parse(line.serviceEndUtc)),
    )).toISOString() ||
    requestedStartTimeUtc !== timing[0].serviceStartUtc
  ) return null;

  return {
    requestId,
    salonId,
    pricingFingerprint,
    currency,
    requestedStartTimeUtc,
    parentStartTimeUtc,
    parentEndTimeUtc,
    sameStaffForAll: row.same_staff_for_all,
    originalPriceCents,
    promoDiscountCents,
    emailDiscountCents,
    voucherDiscountCents,
    preVoucherSubtotalCents,
    subtotalCents,
    taxCents,
    totalCents,
    taxBreakdown,
    lines,
  };
}

export function bookingSequenceRateKey(
  kind: "ip" | "phone",
  value: string,
): string {
  return `public-booking-sequence:${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

export function bookingSequenceQuoteMatchesIntent(
  quote: BookingSequenceQuote,
  intent: SequenceBookingIntent,
): boolean {
  return quote.requestId === intent.requestId &&
    quote.salonId === intent.salonId &&
    quote.requestedStartTimeUtc === intent.requestedStartTimeUtc &&
    quote.sameStaffForAll === intent.sameStaffForAll &&
    quote.lines.length === intent.lines.length &&
    quote.lines.every((line, position) => {
      const requested = intent.lines[position];
      return line.position === position &&
        line.lineId === requested.lineId &&
        line.serviceId === requested.serviceId &&
        (requested.staffPreference === "any" ||
          requested.staffPreference === line.resolvedStaffId) &&
        (requested.preferredResourceId == null ||
          requested.preferredResourceId === line.resolvedResourceId) &&
        (requested.timingPreference ?? "sequential") === line.requestedTimingPreference &&
        (requested.timingPreference ?? "sequential") === line.resolvedTimingMode &&
        requested.addOnServiceIds.length === line.addonLines.length &&
        requested.addOnServiceIds.every(
          (addonId, addonIndex) => addonId === line.addonLines[addonIndex]?.serviceId,
        );
    });
}

export type BookingSequenceQuoteFailureCode =
  | "invalid_request"
  | "parallel_pair_not_allowed"
  | "parallel_resource_unproven"
  | "parallel_requires_distinct_staff"
  | "no_shared_parallel_resource"
  | "no_staff_available"
  | "no_resource_available"
  | "slot_conflict"
  | "quote_unavailable";

const SAFE_QUOTE_FAILURE_CODES = new Set<BookingSequenceQuoteFailureCode>([
  "parallel_pair_not_allowed",
  "parallel_resource_unproven",
  "parallel_requires_distinct_staff",
  "no_shared_parallel_resource",
  "no_staff_available",
  "no_resource_available",
  "slot_conflict",
]);

export async function quotePublicBookingSequence(
  input: unknown,
): Promise<
  | { ok: true; quote: BookingSequenceQuote }
  | { ok: false; code: BookingSequenceQuoteFailureCode }
> {
  const intent = parseSequenceBookingIntent(input);
  if (!intent) return { ok: false, code: "invalid_request" };
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "quote_public_booking_sequence" as never,
      { p_request: serializeSequenceBookingIntent(intent) } as never,
    );
    if (error || data == null) return { ok: false, code: "quote_unavailable" };
    const quote = parseBookingSequenceQuote(data);
    if (quote && bookingSequenceQuoteMatchesIntent(quote, intent)) {
      return { ok: true, quote };
    }
    const failure = record(data)?.code;
    if (
      typeof failure === "string" &&
      SAFE_QUOTE_FAILURE_CODES.has(failure as BookingSequenceQuoteFailureCode)
    ) {
      return { ok: false, code: failure as BookingSequenceQuoteFailureCode };
    }
    return { ok: false, code: "quote_unavailable" };
  } catch {
    return { ok: false, code: "quote_unavailable" };
  }
}

type BookingSequenceCreateArgs = {
  intent: SequenceBookingIntent;
  expectedPricingFingerprint: string;
  otpSessionId: string | null;
  healthAcknowledged: boolean;
  smsConsent: boolean;
  language: "en" | "vi";
};

async function runPublicBookingSequenceCreateRpc(
  rpcName: "create_public_booking_sequence" | "replay_public_booking_sequence",
  args: BookingSequenceCreateArgs,
): Promise<BookingSequenceCreateResult> {
  const intent = parseSequenceBookingIntent(args.intent);
  const expectedPricingFingerprint = args.expectedPricingFingerprint.trim();
  const otpSessionId = args.otpSessionId?.trim() || null;
  if (
    !intent ||
    !SHA256_RE.test(expectedPricingFingerprint) ||
    (otpSessionId != null && !UUID_RE.test(otpSessionId)) ||
    typeof args.healthAcknowledged !== "boolean" ||
    typeof args.smsConsent !== "boolean" ||
    (args.language !== "en" && args.language !== "vi")
  ) {
    return { ok: false, code: "invalid_request" };
  }

  try {
    const { data, error } = await createServiceRoleClient().rpc(
      rpcName as never,
      {
        p_request: {
          ...serializeSequenceBookingIntent(intent),
          expected_pricing_fingerprint: expectedPricingFingerprint,
          ...(otpSessionId ? { otp_session_id: otpSessionId } : {}),
          health_acknowledged: args.healthAcknowledged,
          sms_consent: args.smsConsent,
          notification_language: args.language,
        },
      } as never,
    );
    if (error || data == null) return { ok: false, code: "create_unavailable" };
    const row = record(data);
    if (!row) return { ok: false, code: "create_unavailable" };
    if (row.success === false) {
      if (row.code === "pricing_changed") {
        const quote = parseBookingSequenceQuote(row.quote);
        return quote && bookingSequenceQuoteMatchesIntent(quote, intent)
          ? { ok: false, code: "pricing_changed", quote }
          : { ok: false, code: "create_unavailable" };
      }
      if (
        row.code === "otp_required" ||
        row.code === "invalid_otp_session" ||
        row.code === "otp_session_used" ||
        row.code === "otp_not_required" ||
        row.code === "health_ack_required" ||
        row.code === "payment_not_supported" ||
        row.code === "idempotency_conflict" ||
        row.code === "booking_state_changed" ||
        row.code === "slot_conflict" ||
        row.code === "monthly_booking_limit_reached"
      ) {
        return { ok: false, code: row.code };
      }
      if (row.code === "replay_not_found") {
        return { ok: false, code: "replay_not_found" };
      }
      return { ok: false, code: "create_unavailable" };
    }
    const quote = parseBookingSequenceQuote(row);
    const bookingId = uuid(row.booking_id);
    const segmentIds = Array.isArray(row.segment_ids)
      ? row.segment_ids.map(uuid)
      : [];
    const persistedSnapshot = record(row.pricing_snapshot);
    const salonSlug = boundedText(row.salon_slug, 100);
    const persistedSegmentIds = Array.isArray(persistedSnapshot?.segment_ids)
      ? persistedSnapshot.segment_ids.map(uuid)
      : [];
    if (
      !quote ||
      !bookingId ||
      !persistedSnapshot ||
      !salonSlug ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(salonSlug) ||
      persistedSnapshot.salon_slug !== salonSlug ||
      uuid(persistedSnapshot.booking_id) !== bookingId ||
      persistedSnapshot.pricing_fingerprint !== quote.pricingFingerprint ||
      !bookingSequenceQuoteMatchesIntent(quote, intent) ||
      quote.pricingFingerprint !== expectedPricingFingerprint ||
      typeof row.idempotent !== "boolean" ||
      segmentIds.length !== quote.lines.length ||
      segmentIds.some((id) => !id) ||
      new Set(segmentIds).size !== segmentIds.length ||
      persistedSegmentIds.length !== segmentIds.length ||
      persistedSegmentIds.some((id, index) => id !== segmentIds[index])
      || typeof row.sms_consent !== "boolean"
      || (row.notification_language !== "en" && row.notification_language !== "vi")
      || persistedSnapshot.sms_consent !== row.sms_consent
      || persistedSnapshot.notification_language !== row.notification_language
    ) {
      return { ok: false, code: "create_unavailable" };
    }
    return {
      ok: true,
      bookingId,
      segmentIds: segmentIds as string[],
      idempotent: row.idempotent,
      quote,
      salonSlug,
      smsConsent: row.sms_consent,
      language: row.notification_language,
    };
  } catch {
    return { ok: false, code: "create_unavailable" };
  }
}

/** Read-only response-loss lookup. Call this before mutable rollout/abuse gates. */
export async function replayPublicBookingSequence(
  args: BookingSequenceCreateArgs,
): Promise<BookingSequenceCreateResult> {
  return runPublicBookingSequenceCreateRpc("replay_public_booking_sequence", args);
}

/** Fresh canonical create; the DB owns all policy/OTP/health checks atomically. */
export async function createPublicBookingSequence(
  args: BookingSequenceCreateArgs,
): Promise<BookingSequenceCreateResult> {
  return runPublicBookingSequenceCreateRpc("create_public_booking_sequence", args);
}
