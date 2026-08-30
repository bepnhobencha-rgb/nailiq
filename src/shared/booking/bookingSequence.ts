import { isValidPhoneE164 } from "@/shared/lib/phoneFormat";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";

export const BOOKING_SEQUENCE_MIN_LINES = 1;
export const BOOKING_SEQUENCE_MAX_LINES = 5;
export const BOOKING_SEQUENCE_MAX_ADDONS_PER_LINE = 8;
export const BOOKING_SEQUENCE_MAX_BUFFER_MINUTES = 720;
export const BOOKING_SEQUENCE_CONTRACT_VERSION = 1;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Browser input normally arrives with `Z`, while PostgreSQL `jsonb_build_object`
// serializes timestamptz using the current session offset (for example
// `2026-08-20T05:34:56-07:00`). Both are the same kind of explicit instant.
// Normalize every accepted representation before comparing or fingerprinting it.
const UTC_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FORBIDDEN_CUSTOMER_NAME_RE = /[<>{}=&;]/;

export type SequenceStaffPreference = "any" | string;
export type SequenceTimingPreference = "sequential" | "parallel";

export type SequenceLineIntent = {
  lineId: string;
  position: number;
  serviceId: string;
  staffPreference: SequenceStaffPreference;
  preferredResourceId: string | null;
  addOnServiceIds: string[];
  timingPreference?: SequenceTimingPreference;
};

export type SequenceBookingIntent = {
  salonId: string;
  requestId: string;
  requestedStartTimeUtc: string;
  lines: SequenceLineIntent[];
  sameStaffForAll: boolean;
  voucherCode: string | null;
  applyEmailDiscount: boolean;
  customer: {
    name: string;
    phone: string;
    email: string | null;
  };
};

export type SequenceTimingSegment = {
  lineId: string;
  position: number;
  serviceId: string;
  resolvedStaffId: string;
  resolvedResourceId: string | null;
  requestedTimingPreference: SequenceTimingPreference;
  resolvedTimingMode: SequenceTimingPreference;
  prepMinutes: number;
  durationMinutes: number;
  bufferMinutes: number;
  occupiedStartUtc: string;
  serviceStartUtc: string;
  serviceEndUtc: string;
  occupiedEndUtc: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function uuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

export function canonicalizeUtcInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!UTC_INSTANT_RE.test(normalized)) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function isValidSequenceEmail(value: string): boolean {
  const at = value.lastIndexOf("@");
  return isValidEmailFormat(value) && at > 0 && value.slice(at + 1).includes(".");
}

function parseLine(raw: unknown, expectedPosition: number): SequenceLineIntent | null {
  if (
    !record(raw) ||
    !exactKeys(
      raw,
      ["lineId", "position", "serviceId", "staffPreference", "addOnServiceIds"],
      ["preferredResourceId", "timingPreference"],
    )
  ) {
    return null;
  }
  const lineId = uuid(raw.lineId);
  const serviceId = uuid(raw.serviceId);
  const staffPreference =
    raw.staffPreference === "any" ? "any" : uuid(raw.staffPreference);
  const preferredResourceId =
    raw.preferredResourceId == null ? null : uuid(raw.preferredResourceId);
  const timingPreference = raw.timingPreference ?? "sequential";
  if (
    !lineId ||
    !serviceId ||
    !staffPreference ||
    !Number.isSafeInteger(raw.position) ||
    raw.position !== expectedPosition ||
    !Array.isArray(raw.addOnServiceIds) ||
    raw.addOnServiceIds.length > BOOKING_SEQUENCE_MAX_ADDONS_PER_LINE ||
    (timingPreference !== "sequential" && timingPreference !== "parallel") ||
    (expectedPosition === 0 && timingPreference !== "sequential") ||
    (expectedPosition > 1 && timingPreference === "parallel") ||
    (raw.preferredResourceId != null && !preferredResourceId)
  ) {
    return null;
  }
  const addOnServiceIds = raw.addOnServiceIds.map(uuid);
  if (
    addOnServiceIds.some((id) => id == null) ||
    new Set(addOnServiceIds).size !== addOnServiceIds.length
  ) {
    return null;
  }
  return {
    lineId,
    position: expectedPosition,
    serviceId,
    staffPreference,
    preferredResourceId,
    addOnServiceIds: addOnServiceIds as string[],
    timingPreference,
  };
}

/**
 * Strict browser-boundary parser. Unknown keys (including caller money,
 * duration, prep, buffer, tax or discounts) fail closed.
 */
export function parseSequenceBookingIntent(value: unknown): SequenceBookingIntent | null {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "salonId",
        "requestId",
        "requestedStartTimeUtc",
        "lines",
        "sameStaffForAll",
        "applyEmailDiscount",
        "customer",
      ],
      ["voucherCode"],
    ) ||
    !Array.isArray(value.lines) ||
    value.lines.length < BOOKING_SEQUENCE_MIN_LINES ||
    value.lines.length > BOOKING_SEQUENCE_MAX_LINES ||
    typeof value.sameStaffForAll !== "boolean" ||
    typeof value.applyEmailDiscount !== "boolean" ||
    !record(value.customer) ||
    !exactKeys(value.customer, ["name", "phone"], ["email"])
  ) {
    return null;
  }
  const salonId = uuid(value.salonId);
  const requestId = uuid(value.requestId);
  const requestedStartTimeUtc = canonicalizeUtcInstant(value.requestedStartTimeUtc);
  const name = boundedText(value.customer.name, 120);
  const phone = boundedText(value.customer.phone, 32);
  const email =
    value.customer.email == null
      ? null
      : boundedText(value.customer.email, 254)?.toLowerCase() ?? null;
  const voucherCode =
    value.voucherCode == null
      ? null
      : boundedText(value.voucherCode, 64)?.toUpperCase() ?? null;
  if (
    !salonId ||
    !requestId ||
    !requestedStartTimeUtc ||
    !name ||
    FORBIDDEN_CUSTOMER_NAME_RE.test(name) ||
    !phone ||
    !isValidPhoneE164(phone) ||
    (value.customer.email != null && (!email || !isValidSequenceEmail(email))) ||
    (value.voucherCode != null && !voucherCode)
  ) {
    return null;
  }
  const lines = value.lines.map(parseLine);
  if (
    lines.some((line) => line == null) ||
    new Set(lines.map((line) => line?.lineId)).size !== lines.length
  ) {
    return null;
  }
  return {
    salonId,
    requestId,
    requestedStartTimeUtc,
    lines: lines as SequenceLineIntent[],
    sameStaffForAll: value.sameStaffForAll,
    voucherCode,
    applyEmailDiscount: value.applyEmailDiscount,
    customer: { name, phone, email },
  };
}

/** Fixed-key RPC material; no browser monetary or timing-derived fields. */
export function serializeSequenceBookingIntent(intent: SequenceBookingIntent) {
  return {
    contract_version: BOOKING_SEQUENCE_CONTRACT_VERSION,
    salon_id: intent.salonId,
    request_id: intent.requestId,
    requested_start_time_utc: intent.requestedStartTimeUtc,
    same_staff_for_all: intent.sameStaffForAll,
    voucher_code: intent.voucherCode,
    apply_email_discount: intent.applyEmailDiscount,
    customer: {
      name: intent.customer.name,
      phone: intent.customer.phone,
      email: intent.customer.email,
    },
    lines: intent.lines.map((line) => ({
      line_id: line.lineId,
      position: line.position,
      service_id: line.serviceId,
      staff_preference: line.staffPreference,
      preferred_resource_id: line.preferredResourceId,
      addon_service_ids: [...line.addOnServiceIds],
      timing_preference: line.timingPreference ?? "sequential",
    })),
  };
}

function minutes(value: unknown, min: number, max: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : null;
}

export function parseServicePrepMinutes(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 180
    ? parsed
    : null;
}

function addMinutes(iso: string, amount: number): number {
  return Date.parse(iso) + amount * 60_000;
}

export function parseSequenceTimingSegments(value: unknown): SequenceTimingSegment[] | null {
  if (
    !Array.isArray(value) ||
    value.length < BOOKING_SEQUENCE_MIN_LINES ||
    value.length > BOOKING_SEQUENCE_MAX_LINES
  ) {
    return null;
  }
  const segments: SequenceTimingSegment[] = [];
  for (let position = 0; position < value.length; position += 1) {
    const raw = value[position];
    if (
      !record(raw) ||
      !exactKeys(raw, [
        "line_id",
        "position",
        "service_id",
        "resolved_staff_id",
        "resolved_resource_id",
        "prep_minutes",
        "duration_minutes",
        "buffer_minutes",
        "occupied_start_utc",
        "service_start_utc",
        "service_end_utc",
        "occupied_end_utc",
      ], ["requested_timing_preference", "resolved_timing_mode"])
    ) {
      return null;
    }
    const lineId = uuid(raw.line_id);
    const serviceId = uuid(raw.service_id);
    const resolvedStaffId = uuid(raw.resolved_staff_id);
    const resolvedResourceId =
      raw.resolved_resource_id == null ? null : uuid(raw.resolved_resource_id);
    const requestedTimingPreference =
      raw.requested_timing_preference ?? "sequential";
    const resolvedTimingMode = raw.resolved_timing_mode ?? "sequential";
    const prepMinutes = minutes(raw.prep_minutes, 0, 180);
    const durationMinutes = minutes(raw.duration_minutes, 1, 1440);
    const bufferMinutes = minutes(
      raw.buffer_minutes,
      0,
      BOOKING_SEQUENCE_MAX_BUFFER_MINUTES,
    );
    const occupiedStartUtc = canonicalizeUtcInstant(raw.occupied_start_utc);
    const serviceStartUtc = canonicalizeUtcInstant(raw.service_start_utc);
    const serviceEndUtc = canonicalizeUtcInstant(raw.service_end_utc);
    const occupiedEndUtc = canonicalizeUtcInstant(raw.occupied_end_utc);
    if (
      raw.position !== position ||
      !lineId ||
      !serviceId ||
      !resolvedStaffId ||
      (raw.resolved_resource_id != null && !resolvedResourceId) ||
      (requestedTimingPreference !== "sequential" &&
        requestedTimingPreference !== "parallel") ||
      (resolvedTimingMode !== "sequential" && resolvedTimingMode !== "parallel") ||
      (position === 0 && resolvedTimingMode !== "sequential") ||
      (position > 1 && resolvedTimingMode === "parallel") ||
      prepMinutes == null ||
      durationMinutes == null ||
      bufferMinutes == null ||
      !occupiedStartUtc ||
      !serviceStartUtc ||
      !serviceEndUtc ||
      !occupiedEndUtc ||
      addMinutes(serviceStartUtc, -prepMinutes) !== Date.parse(occupiedStartUtc) ||
      addMinutes(serviceStartUtc, durationMinutes) !== Date.parse(serviceEndUtc) ||
      addMinutes(serviceEndUtc, bufferMinutes) !== Date.parse(occupiedEndUtc) ||
      (position > 0 && resolvedTimingMode === "sequential" &&
        Date.parse(serviceStartUtc) < Math.max(
          ...segments.map((segment) => Date.parse(segment.serviceEndUtc)),
        )) ||
      (position > 0 && resolvedTimingMode === "parallel" && (
        serviceStartUtc !== segments[position - 1].serviceStartUtc ||
        resolvedStaffId === segments[position - 1].resolvedStaffId
      ))
    ) {
      return null;
    }
    segments.push({
      lineId,
      position,
      serviceId,
      resolvedStaffId,
      resolvedResourceId,
      requestedTimingPreference,
      resolvedTimingMode,
      prepMinutes,
      durationMinutes,
      bufferMinutes,
      occupiedStartUtc,
      serviceStartUtc,
      serviceEndUtc,
      occupiedEndUtc,
    });
  }
  if (new Set(segments.map((segment) => segment.lineId)).size !== segments.length) {
    return null;
  }
  return segments;
}

/**
 * Compatibility proof seam for the historical one-service path. At prep=0,
 * occupied start remains the service start and the block is duration+buffer.
 */
export function singleServiceSequenceTiming(input: {
  serviceStartUtc: string;
  prepMinutes?: number;
  durationMinutes: number;
  bufferMinutes: number;
}) {
  const start = canonicalizeUtcInstant(input.serviceStartUtc);
  const prep = minutes(input.prepMinutes ?? 0, 0, 180);
  const duration = minutes(input.durationMinutes, 1, 1440);
  const buffer = minutes(
    input.bufferMinutes,
    0,
    BOOKING_SEQUENCE_MAX_BUFFER_MINUTES,
  );
  if (!start || prep == null || duration == null || buffer == null) return null;
  return {
    occupiedStartUtc: new Date(addMinutes(start, -prep)).toISOString(),
    serviceStartUtc: new Date(Date.parse(start)).toISOString(),
    serviceEndUtc: new Date(addMinutes(start, duration)).toISOString(),
    occupiedEndUtc: new Date(addMinutes(start, duration + buffer)).toISOString(),
    blockMinutes: prep + duration + buffer,
    customerServiceMinutes: duration,
  };
}
