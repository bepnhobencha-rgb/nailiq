import {
  isSupportedCurrency,
  type Currency,
} from "@/shared/lib/currencyFormat";

import {
  BOOKING_SEQUENCE_MAX_BUFFER_MINUTES,
  BOOKING_SEQUENCE_MAX_LINES,
  BOOKING_SEQUENCE_MIN_LINES,
  canonicalizeUtcInstant,
} from "@/shared/booking/bookingSequence";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export type BookingSequenceTaxLine = {
  name: string;
  rate: number;
  amountCents: number;
};

export type BookingSequenceAddonLine = {
  serviceId: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
  bufferMinutes: number;
  addonTiming: string | null;
};

export type BookingSequenceDiscountLine = {
  kind: "promotion" | "email_incentive" | "voucher";
  label: string;
  amountCents: number;
};

export type BookingSequenceReceiptSegment = {
  segmentId: string;
  lineId: string;
  position: number;
  serviceId: string;
  serviceName: string;
  staffName: string;
  resolvedStaffId: string;
  resolvedResourceId: string | null;
  prepMinutes: number;
  durationMinutes: number;
  bufferMinutes: number;
  occupiedStartUtc: string;
  serviceStartUtc: string;
  serviceEndUtc: string;
  occupiedEndUtc: string;
  serviceOriginalCents: number;
  serviceNetCents: number;
  addonPreVoucherCents: number;
  promoDiscountCents: number;
  emailDiscountCents: number;
  voucherDiscountCents: number;
  serviceFinalCents: number;
  addonFinalCents: number;
  preVoucherSubtotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  promoId: string | null;
  promoName: string | null;
  addonLines: BookingSequenceAddonLine[];
  taxBreakdown: BookingSequenceTaxLine[];
  discountLines: BookingSequenceDiscountLine[];
  reservationStatus: string;
};

export type BookingSequenceReceipt = {
  bookingId: string;
  salonId: string;
  status: string;
  scheduleModel: "segments_v1";
  sequenceVersion: 1;
  pricingFingerprint: string;
  currency: Currency;
  parentStartTimeUtc: string;
  parentEndTimeUtc: string;
  serviceOriginalCents: number;
  promoDiscountCents: number;
  emailDiscountCents: number;
  voucherDiscountCents: number;
  preVoucherSubtotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBreakdown: BookingSequenceTaxLine[];
  segments: BookingSequenceReceiptSegment[];
};

type ParsedSnapshotSegment = Omit<BookingSequenceReceiptSegment, "segmentId" | "reservationStatus">;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function uuid(value: unknown): string | null {
  const parsed = text(value, 36)?.toLowerCase() ?? null;
  return parsed && UUID_RE.test(parsed) ? parsed : null;
}

function nullableUuid(value: unknown): string | null | undefined {
  return value == null ? null : uuid(value) ?? undefined;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function rate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function parseTaxLines(value: unknown, expectedTotal: number): BookingSequenceTaxLine[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result: BookingSequenceTaxLine[] = [];
  for (const raw of value) {
    const row = record(raw);
    const name = text(row?.name, 120);
    const parsedRate = rate(row?.rate);
    const amountCents = integer(row?.amount_cents);
    if (!row || !name || parsedRate == null || amountCents == null) return null;
    result.push({ name, rate: parsedRate, amountCents });
  }
  return result.reduce((sum, line) => sum + line.amountCents, 0) === expectedTotal
    ? result
    : null;
}

function parseAddonLines(value: unknown, expectedTotal: number): BookingSequenceAddonLine[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const result: BookingSequenceAddonLine[] = [];
  for (const raw of value) {
    const row = record(raw);
    const serviceId = uuid(row?.service_id);
    const name = text(row?.name, 160);
    const priceCents = integer(row?.price_cents);
    const durationMinutes = integer(row?.duration_minutes, 0, 1440);
    const bufferMinutes = integer(row?.buffer_minutes, 0, BOOKING_SEQUENCE_MAX_BUFFER_MINUTES);
    const addonTiming = row?.addon_timing == null ? null : text(row.addon_timing, 40);
    if (
      !row || !serviceId || !name || priceCents == null || durationMinutes == null ||
      bufferMinutes == null || (row.addon_timing != null && !addonTiming)
    ) return null;
    result.push({ serviceId, name, priceCents, durationMinutes, bufferMinutes, addonTiming });
  }
  return result.reduce((sum, line) => sum + line.priceCents, 0) === expectedTotal
    ? result
    : null;
}

function sameTaxLines(left: BookingSequenceTaxLine[], right: BookingSequenceTaxLine[]): boolean {
  return left.length === right.length && left.every((line, index) => {
    const other = right[index];
    return line.name === other.name && line.rate === other.rate && line.amountCents === other.amountCents;
  });
}

function sameAddonLines(left: BookingSequenceAddonLine[], right: BookingSequenceAddonLine[]): boolean {
  return left.length === right.length && left.every((line, index) => {
    const other = right[index];
    return line.serviceId === other.serviceId && line.name === other.name &&
      line.priceCents === other.priceCents && line.durationMinutes === other.durationMinutes &&
      line.bufferMinutes === other.bufferMinutes && line.addonTiming === other.addonTiming;
  });
}

function parseSnapshotSegment(value: unknown, expectedPosition: number): ParsedSnapshotSegment | null {
  const row = record(value);
  if (!row || row.position !== expectedPosition) return null;
  const lineId = uuid(row.line_id);
  const serviceId = uuid(row.service_id);
  const serviceName = text(row.service_name, 240);
  const staffName = text(row.staff_name, 240);
  const resolvedStaffId = uuid(row.resolved_staff_id);
  const resolvedResourceId = nullableUuid(row.resolved_resource_id);
  const prepMinutes = integer(row.prep_minutes, 0, 180);
  const durationMinutes = integer(row.duration_minutes, 1, 1440);
  const bufferMinutes = integer(row.buffer_minutes, 0, BOOKING_SEQUENCE_MAX_BUFFER_MINUTES);
  const occupiedStartUtc = canonicalizeUtcInstant(row.occupied_start_utc);
  const serviceStartUtc = canonicalizeUtcInstant(row.service_start_utc);
  const serviceEndUtc = canonicalizeUtcInstant(row.service_end_utc);
  const occupiedEndUtc = canonicalizeUtcInstant(row.occupied_end_utc);
  const serviceOriginalCents = integer(row.original_service_price_cents);
  const serviceNetCents = integer(row.service_pre_voucher_cents);
  const addonPreVoucherCents = integer(row.addon_pre_voucher_cents);
  const promoDiscountCents = integer(row.promo_discount_cents);
  const emailDiscountCents = integer(row.email_discount_cents);
  const voucherDiscountCents = integer(row.voucher_discount_cents);
  const serviceFinalCents = integer(row.service_price_cents);
  const addonFinalCents = integer(row.addon_price_cents);
  const preVoucherSubtotalCents = integer(row.pre_voucher_subtotal_cents);
  const subtotalCents = integer(row.subtotal_cents);
  const taxCents = integer(row.tax_cents);
  const totalCents = integer(row.total_cents);
  const promoId = nullableUuid(row.promo_id);
  const promoName = row.promo_name == null ? null : text(row.promo_name, 160);
  if (
    !lineId || !serviceId || !serviceName || !staffName || !resolvedStaffId ||
    resolvedResourceId === undefined || prepMinutes == null || durationMinutes == null ||
    bufferMinutes == null || !occupiedStartUtc || !serviceStartUtc || !serviceEndUtc ||
    !occupiedEndUtc || serviceOriginalCents == null || serviceNetCents == null ||
    addonPreVoucherCents == null || promoDiscountCents == null || emailDiscountCents == null ||
    voucherDiscountCents == null || serviceFinalCents == null || addonFinalCents == null ||
    preVoucherSubtotalCents == null || subtotalCents == null || taxCents == null ||
    totalCents == null || promoId === undefined || (row.promo_name != null && !promoName)
  ) return null;

  const addonLines = parseAddonLines(row.addon_lines, addonPreVoucherCents);
  const taxBreakdown = parseTaxLines(row.tax_breakdown, taxCents);
  if (!addonLines || !taxBreakdown) return null;
  if (
    Date.parse(occupiedStartUtc) !== Date.parse(serviceStartUtc) - prepMinutes * 60_000 ||
    Date.parse(serviceEndUtc) !== Date.parse(serviceStartUtc) + durationMinutes * 60_000 ||
    Date.parse(occupiedEndUtc) !== Date.parse(serviceEndUtc) + bufferMinutes * 60_000 ||
    serviceOriginalCents - promoDiscountCents !== serviceNetCents ||
    serviceNetCents - emailDiscountCents + addonPreVoucherCents !== preVoucherSubtotalCents ||
    serviceFinalCents + addonFinalCents !== subtotalCents ||
    preVoucherSubtotalCents - voucherDiscountCents !== subtotalCents ||
    subtotalCents + taxCents !== totalCents
  ) return null;

  const discountLines: BookingSequenceDiscountLine[] = [
    ...(promoDiscountCents > 0 ? [{
      kind: "promotion" as const,
      label: promoName ?? "Promotion",
      amountCents: promoDiscountCents,
    }] : []),
    ...(emailDiscountCents > 0 ? [{
      kind: "email_incentive" as const,
      label: "Email incentive",
      amountCents: emailDiscountCents,
    }] : []),
    ...(voucherDiscountCents > 0 ? [{
      kind: "voucher" as const,
      label: "Voucher",
      amountCents: voucherDiscountCents,
    }] : []),
  ];

  return {
    lineId,
    position: expectedPosition,
    serviceId,
    serviceName,
    staffName,
    resolvedStaffId,
    resolvedResourceId,
    prepMinutes,
    durationMinutes,
    bufferMinutes,
    occupiedStartUtc,
    serviceStartUtc,
    serviceEndUtc,
    occupiedEndUtc,
    serviceOriginalCents,
    serviceNetCents,
    addonPreVoucherCents,
    promoDiscountCents,
    emailDiscountCents,
    voucherDiscountCents,
    serviceFinalCents,
    addonFinalCents,
    preVoucherSubtotalCents,
    subtotalCents,
    taxCents,
    totalCents,
    promoId,
    promoName,
    addonLines,
    taxBreakdown,
    discountLines,
  };
}

function segmentMatchesSnapshot(
  row: Record<string, unknown>,
  snapshot: ParsedSnapshotSegment,
  segmentId: string,
): BookingSequenceReceiptSegment | null {
  const persistedServiceNet = integer(row.service_pre_voucher_cents);
  const persistedEmail = integer(row.email_discount_cents);
  const persistedAddonPre = integer(row.addon_pre_voucher_cents);
  const derivedPreVoucher = persistedServiceNet != null && persistedEmail != null &&
      persistedAddonPre != null && persistedServiceNet >= persistedEmail
    ? persistedServiceNet - persistedEmail + persistedAddonPre
    : null;
  const persisted = parseSnapshotSegment({
    ...row,
    // The segment table stores the three operands. Older loader shapes did not
    // project their deterministic sum, so derive it without trusting the parent.
    pre_voucher_subtotal_cents: row.pre_voucher_subtotal_cents ?? derivedPreVoucher,
    // promo_name is display material in the immutable parent snapshot; promo_id
    // and promo cents remain independently reconciled against the segment row.
    promo_name: row.promo_name ?? snapshot.promoName,
  }, snapshot.position);
  const reservationStatus = text(row.reservation_status, 40);
  if (!persisted || !reservationStatus || uuid(row.segment_id) !== segmentId) return null;
  const comparableKeys: (keyof ParsedSnapshotSegment)[] = [
    "lineId", "position", "serviceId", "serviceName", "staffName", "resolvedStaffId",
    "resolvedResourceId", "prepMinutes", "durationMinutes", "bufferMinutes",
    "occupiedStartUtc", "serviceStartUtc", "serviceEndUtc", "occupiedEndUtc",
    "serviceOriginalCents", "serviceNetCents", "addonPreVoucherCents",
    "promoDiscountCents", "emailDiscountCents", "voucherDiscountCents",
    "serviceFinalCents", "addonFinalCents", "preVoucherSubtotalCents",
    "subtotalCents", "taxCents", "totalCents", "promoId", "promoName",
  ];
  if (comparableKeys.some((key) => persisted[key] !== snapshot[key]) ||
      !sameAddonLines(persisted.addonLines, snapshot.addonLines) ||
      !sameTaxLines(persisted.taxBreakdown, snapshot.taxBreakdown)) {
    return null;
  }
  return { segmentId, ...persisted, reservationStatus };
}

/**
 * Strictly reconciles the immutable parent pricing snapshot with the persisted
 * segment rows. A malformed or drifted receipt fails closed instead of falling
 * back to mutable catalog names, times, or prices.
 */
export function parseBookingSequenceReceipt(value: unknown): BookingSequenceReceipt | null {
  const row = record(value);
  const snapshot = record(row?.pricing_snapshot);
  if (
    !row || row.success !== true || row.code !== "loaded" || !snapshot ||
    row.schedule_model !== "segments_v1" || row.sequence_version !== 1 ||
    snapshot.schedule_model !== "segments_v1" || snapshot.sequence_version !== 1
  ) return null;

  const bookingId = uuid(row.booking_id);
  const salonId = uuid(row.salon_id);
  const status = text(row.status, 40);
  const pricingFingerprint = text(row.pricing_fingerprint, 64);
  const snapshotFingerprint = text(snapshot.pricing_fingerprint, 64);
  const snapshotBookingId = uuid(snapshot.booking_id);
  const snapshotSalonId = uuid(snapshot.salon_id);
  const currencyRaw = text(snapshot.currency, 8);
  const parentStartTimeUtc = canonicalizeUtcInstant(snapshot.parent_start_time_utc);
  const parentEndTimeUtc = canonicalizeUtcInstant(snapshot.parent_end_time_utc);
  if (
    !bookingId || !salonId || !status || !pricingFingerprint ||
    !SHA256_RE.test(pricingFingerprint) || snapshotFingerprint !== pricingFingerprint ||
    snapshotBookingId !== bookingId || snapshotSalonId !== salonId || !currencyRaw ||
    !isSupportedCurrency(currencyRaw) || !parentStartTimeUtc || !parentEndTimeUtc
  ) return null;

  const serviceOriginalCents = integer(snapshot.original_price_cents);
  const promoDiscountCents = integer(snapshot.promo_discount_cents);
  const emailDiscountCents = integer(snapshot.email_discount_cents);
  const voucherDiscountCents = integer(snapshot.voucher_discount_cents);
  const preVoucherSubtotalCents = integer(snapshot.pre_voucher_subtotal_cents);
  const subtotalCents = integer(snapshot.subtotal_cents);
  const taxCents = integer(snapshot.tax_cents);
  const totalCents = integer(snapshot.total_cents);
  if (
    serviceOriginalCents == null || promoDiscountCents == null || emailDiscountCents == null ||
    voucherDiscountCents == null || preVoucherSubtotalCents == null || subtotalCents == null ||
    taxCents == null || totalCents == null || subtotalCents + taxCents !== totalCents
  ) return null;
  const taxBreakdown = parseTaxLines(snapshot.tax_breakdown, taxCents);
  if (!taxBreakdown || !Array.isArray(snapshot.segments) || !Array.isArray(snapshot.segment_ids) ||
      !Array.isArray(row.segments) || snapshot.segments.length < BOOKING_SEQUENCE_MIN_LINES ||
      snapshot.segments.length > BOOKING_SEQUENCE_MAX_LINES ||
      snapshot.segments.length !== snapshot.segment_ids.length ||
      snapshot.segments.length !== row.segments.length) return null;

  const segmentIds = snapshot.segment_ids.map(uuid);
  if (segmentIds.some((id) => id == null) || new Set(segmentIds).size !== segmentIds.length) return null;
  const segments: BookingSequenceReceiptSegment[] = [];
  for (let position = 0; position < snapshot.segments.length; position += 1) {
    const parsedSnapshot = parseSnapshotSegment(snapshot.segments[position], position);
    const persistedRow = record(row.segments[position]);
    const segmentId = segmentIds[position];
    if (!parsedSnapshot || !persistedRow || !segmentId) return null;
    const persisted = segmentMatchesSnapshot(persistedRow, parsedSnapshot, segmentId);
    if (!persisted || (position > 0 &&
      Date.parse(persisted.serviceStartUtc) < Date.parse(segments[position - 1].serviceEndUtc))) {
      return null;
    }
    segments.push(persisted);
  }

  const sum = (pick: (segment: BookingSequenceReceiptSegment) => number) =>
    segments.reduce((total, segment) => total + pick(segment), 0);
  if (
    segments[0].serviceStartUtc !== parentStartTimeUtc ||
    segments[segments.length - 1].serviceEndUtc !== parentEndTimeUtc ||
    new Set(segments.map((segment) => segment.lineId)).size !== segments.length ||
    sum((segment) => segment.serviceOriginalCents) !== serviceOriginalCents ||
    sum((segment) => segment.promoDiscountCents) !== promoDiscountCents ||
    sum((segment) => segment.emailDiscountCents) !== emailDiscountCents ||
    sum((segment) => segment.voucherDiscountCents) !== voucherDiscountCents ||
    sum((segment) => segment.preVoucherSubtotalCents) !== preVoucherSubtotalCents ||
    sum((segment) => segment.subtotalCents) !== subtotalCents ||
    sum((segment) => segment.taxCents) !== taxCents ||
    sum((segment) => segment.totalCents) !== totalCents
  ) return null;

  return {
    bookingId,
    salonId,
    status,
    scheduleModel: "segments_v1",
    sequenceVersion: 1,
    pricingFingerprint,
    currency: currencyRaw,
    parentStartTimeUtc,
    parentEndTimeUtc,
    serviceOriginalCents,
    promoDiscountCents,
    emailDiscountCents,
    voucherDiscountCents,
    preVoucherSubtotalCents,
    subtotalCents,
    taxCents,
    totalCents,
    taxBreakdown,
    segments,
  };
}
