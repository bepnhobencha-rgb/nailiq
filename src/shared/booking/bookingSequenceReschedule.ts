import "server-only";

import {
  canonicalizeUtcInstant,
  parseSequenceTimingSegments,
} from "@/shared/booking/bookingSequence";
import {
  parseBookingSequenceReceipt,
  type BookingSequenceReceipt,
} from "@/shared/booking/bookingSequenceReceipt";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

type SequenceRescheduleSegment = {
  lineId: string;
  position: number;
  serviceId: string;
  staffId: string;
  staffName: string;
  resourceId: string | null;
  customerStartUtc: string;
  customerEndUtc: string;
  occupiedStartUtc: string;
  occupiedEndUtc: string;
  prepMinutes: number;
  serviceDurationMinutes: number;
  sequentialAddonMinutes: number;
  trailingBufferMinutes: number;
};

export type BookingSequenceRescheduleQuote = {
  requestId: string;
  bookingId: string;
  salonId: string;
  bookingTransitionVersion: number;
  currentSequenceFingerprint: string;
  requestedStartTimeUtc: string;
  parentStartTimeUtc: string;
  parentEndTimeUtc: string;
  sequenceFingerprint: string;
  segments: SequenceRescheduleSegment[];
};

export type BookingSequenceRescheduleResult = {
  bookingId: string;
  salonId: string;
  previousStartTimeUtc: string;
  startTimeUtc: string;
  endTimeUtc: string;
  transitionVersion: number;
  sequenceFingerprint: string;
  receipt: BookingSequenceReceipt;
  cancelPreview: { policyLockedByReschedule: boolean };
  promotedWaitlist: {
    waitlistEntryId: string;
    claimCapabilityToken: string;
    offerEpoch: number;
    expiresAt: string;
  } | null;
  idempotent: boolean;
  actorSource: "customer" | "staff";
  actorUserId: string | null;
  customerTransitionEmailRequested: boolean;
  customerTransitionSmsRequested: boolean;
};

export type BookingSequenceRescheduleFailure = {
  ok: false;
  code: string;
  quote?: BookingSequenceRescheduleQuote;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

function utc(value: unknown): string | null {
  return canonicalizeUtcInstant(value);
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)
    ? value
    : "management_unavailable";
}

export function parseBookingSequenceRescheduleQuote(
  value: unknown,
): BookingSequenceRescheduleQuote | null {
  const row = record(value);
  if (!row || row.success !== true || row.code !== "reschedule_quoted" || row.idempotent !== false) {
    return null;
  }
  const requestId = uuid(row.request_id);
  const bookingId = uuid(row.booking_id);
  const salonId = uuid(row.salon_id);
  const bookingTransitionVersion = integer(row.booking_transition_version);
  const currentSequenceFingerprint = typeof row.current_sequence_fingerprint === "string"
    ? row.current_sequence_fingerprint
    : "";
  const sequenceFingerprint = typeof row.sequence_fingerprint === "string"
    ? row.sequence_fingerprint
    : "";
  const requestedStartTimeUtc = utc(row.requested_start_time_utc);
  const parentStartTimeUtc = utc(row.parent_start_time_utc);
  const parentEndTimeUtc = utc(row.parent_end_time_utc);
  const timing = parseSequenceTimingSegments(row.timing_segments);
  if (
    !requestId || !bookingId || !salonId || bookingTransitionVersion == null ||
    !SHA256_RE.test(currentSequenceFingerprint) || !SHA256_RE.test(sequenceFingerprint) ||
    !requestedStartTimeUtc || !parentStartTimeUtc || !parentEndTimeUtc ||
    requestedStartTimeUtc !== parentStartTimeUtc || !timing ||
    Date.parse(parentEndTimeUtc) <= Date.parse(parentStartTimeUtc) ||
    !Array.isArray(row.schedule_segments) || row.schedule_segments.length !== timing.length
  ) return null;

  const segments: SequenceRescheduleSegment[] = [];
  for (let position = 0; position < row.schedule_segments.length; position += 1) {
    const raw = record(row.schedule_segments[position]);
    const lineId = uuid(raw?.line_id);
    const serviceId = uuid(raw?.service_id);
    const staffId = uuid(raw?.staff_id);
    const staffName = typeof raw?.staff_name === "string" && raw.staff_name.trim().length <= 160
      ? raw.staff_name.trim()
      : "";
    const resourceId = raw?.resource_id == null ? null : uuid(raw.resource_id);
    const customerStartUtc = utc(raw?.customer_start_utc);
    const customerEndUtc = utc(raw?.customer_end_utc);
    const occupiedStartUtc = utc(raw?.occupied_start_utc);
    const occupiedEndUtc = utc(raw?.occupied_end_utc);
    const prepMinutes = integer(raw?.prep_minutes, 0, 180);
    const serviceDurationMinutes = integer(raw?.service_duration_minutes, 1, 1440);
    const sequentialAddonMinutes = integer(raw?.sequential_addon_minutes, 0, 1440);
    const trailingBufferMinutes = integer(raw?.trailing_buffer_minutes, 0, 720);
    const projected = timing[position];
    if (
      !raw || raw.position !== position || !lineId || !serviceId || !staffId || !staffName ||
      (raw.resource_id != null && !resourceId) || !customerStartUtc || !customerEndUtc ||
      !occupiedStartUtc || !occupiedEndUtc || prepMinutes == null ||
      serviceDurationMinutes == null || sequentialAddonMinutes == null ||
      trailingBufferMinutes == null || !projected || projected.position !== position ||
      projected.lineId !== lineId || projected.serviceId !== serviceId ||
      projected.resolvedStaffId !== staffId || projected.resolvedResourceId !== resourceId ||
      projected.serviceStartUtc !== customerStartUtc || projected.serviceEndUtc !== customerEndUtc ||
      projected.occupiedStartUtc !== occupiedStartUtc || projected.occupiedEndUtc !== occupiedEndUtc ||
      projected.prepMinutes !== prepMinutes ||
      projected.durationMinutes !== serviceDurationMinutes + sequentialAddonMinutes ||
      projected.bufferMinutes !== trailingBufferMinutes
    ) return null;
    segments.push({
      lineId,
      position,
      serviceId,
      staffId,
      staffName,
      resourceId,
      customerStartUtc,
      customerEndUtc,
      occupiedStartUtc,
      occupiedEndUtc,
      prepMinutes,
      serviceDurationMinutes,
      sequentialAddonMinutes,
      trailingBufferMinutes,
    });
  }
  if (
    new Set(segments.map((segment) => segment.lineId)).size !== segments.length ||
    segments[0]?.customerStartUtc !== parentStartTimeUtc ||
    segments.at(-1)?.customerEndUtc !== parentEndTimeUtc ||
    segments.some((segment, index) => index > 0 &&
      Date.parse(segment.customerStartUtc) < Date.parse(segments[index - 1].customerEndUtc))
  ) return null;
  return {
    requestId,
    bookingId,
    salonId,
    bookingTransitionVersion,
    currentSequenceFingerprint,
    requestedStartTimeUtc,
    parentStartTimeUtc,
    parentEndTimeUtc,
    sequenceFingerprint,
    segments,
  };
}

function parsePromotedWaitlist(value: unknown): BookingSequenceRescheduleResult["promotedWaitlist"] | undefined {
  if (value == null) return null;
  const row = record(value);
  const waitlistEntryId = uuid(row?.waitlist_entry_id);
  const claimCapabilityToken = uuid(row?.claim_capability_token);
  const offerEpoch = integer(row?.offer_epoch, 1);
  const expiresAt = utc(row?.expires_at);
  return row && waitlistEntryId && claimCapabilityToken && offerEpoch != null && expiresAt
    ? { waitlistEntryId, claimCapabilityToken, offerEpoch, expiresAt }
    : undefined;
}

export function parseBookingSequenceRescheduleResult(
  value: unknown,
  expectedActor: {
    source: "customer" | "staff";
    userId: string | null;
    notifyEmail: boolean;
    notifySms: boolean;
  } = { source: "customer", userId: null, notifyEmail: true, notifySms: false },
): { ok: true; result: BookingSequenceRescheduleResult } | BookingSequenceRescheduleFailure {
  const row = record(value);
  if (!row || row.success !== true || row.ok !== true) {
    if (row?.code === "pricing_changed") {
      const quote = parseBookingSequenceRescheduleQuote(row.quote);
      return quote
        ? { ok: false, code: "pricing_changed", quote }
        : { ok: false, code: "management_unavailable" };
    }
    return { ok: false, code: safeCode(row?.code) };
  }
  const bookingId = uuid(row.booking_id);
  const salonId = uuid(row.salon_id);
  const previousStartTimeUtc = utc(row.previous_start_time_utc);
  const startTimeUtc = utc(row.start_time_utc);
  const endTimeUtc = utc(row.end_time_utc);
  const transitionVersion = integer(row.customer_transition_version, 1);
  const sequenceFingerprint = typeof row.sequence_fingerprint === "string"
    ? row.sequence_fingerprint
    : "";
  const receipt = parseBookingSequenceReceipt(row.sequence_receipt);
  const cancelPreview = record(row.cancel_preview);
  const promotedWaitlist = parsePromotedWaitlist(row.promoted_waitlist);
  const actorUserId = row.actor_user_id == null ? null : uuid(row.actor_user_id);
  if (
    row.code !== "rescheduled" || row.action !== "reschedule" || row.scope_kind !== "booking_own" ||
    row.status !== "confirmed" || typeof row.idempotent !== "boolean" || !bookingId || !salonId ||
    !previousStartTimeUtc || !startTimeUtc || !endTimeUtc || transitionVersion == null ||
    !SHA256_RE.test(sequenceFingerprint) || !receipt || receipt.bookingId !== bookingId ||
    receipt.salonId !== salonId || receipt.status !== "confirmed" ||
    receipt.parentStartTimeUtc !== startTimeUtc || receipt.parentEndTimeUtc !== endTimeUtc ||
    receipt.pricingFingerprint !== sequenceFingerprint || !cancelPreview ||
    typeof cancelPreview.policy_locked_by_reschedule !== "boolean" || promotedWaitlist === undefined ||
    row.actor_source !== expectedActor.source || actorUserId !== expectedActor.userId ||
    row.customer_transition_email_requested !== expectedActor.notifyEmail ||
    row.customer_transition_sms_requested !== expectedActor.notifySms
  ) return { ok: false, code: "management_unavailable" };
  return {
    ok: true,
    result: {
      bookingId,
      salonId,
      previousStartTimeUtc,
      startTimeUtc,
      endTimeUtc,
      transitionVersion,
      sequenceFingerprint,
      receipt,
      cancelPreview: {
        policyLockedByReschedule: cancelPreview.policy_locked_by_reschedule,
      },
      promotedWaitlist,
      idempotent: row.idempotent,
      actorSource: expectedActor.source,
      actorUserId,
      customerTransitionEmailRequested: expectedActor.notifyEmail,
      customerTransitionSmsRequested: expectedActor.notifySms,
    },
  };
}

export async function quoteBookingSequenceReschedule(input: {
  tokenId: string;
  requestId: string;
  newStartTimeUtc: string;
}): Promise<{ ok: true; quote: BookingSequenceRescheduleQuote } | BookingSequenceRescheduleFailure> {
  if (!uuid(input.tokenId) || !uuid(input.requestId) || !utc(input.newStartTimeUtc)) {
    return { ok: false, code: "invalid_request" };
  }
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "quote_booking_sequence_reschedule" as never,
      {
        p_token_id: input.tokenId,
        p_request_id: input.requestId,
        p_new_start_time_utc: input.newStartTimeUtc,
      } as never,
    );
    if (error) return { ok: false, code: "management_unavailable" };
    const quote = parseBookingSequenceRescheduleQuote(data);
    return quote ? { ok: true, quote } : { ok: false, code: safeCode(record(data)?.code) };
  } catch {
    return { ok: false, code: "management_unavailable" };
  }
}

export async function rescheduleBookingSequenceWithManagementCapability(input: {
  tokenId: string;
  requestId: string;
  newStartTimeUtc: string;
  expectedSequenceFingerprint: string;
}): Promise<{ ok: true; result: BookingSequenceRescheduleResult } | BookingSequenceRescheduleFailure> {
  if (
    !uuid(input.tokenId) || !uuid(input.requestId) || !utc(input.newStartTimeUtc) ||
    !SHA256_RE.test(input.expectedSequenceFingerprint)
  ) return { ok: false, code: "invalid_request" };
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "reschedule_booking_sequence_with_management_capability" as never,
      {
        p_token_id: input.tokenId,
        p_request_id: input.requestId,
        p_new_start_time_utc: input.newStartTimeUtc,
        p_expected_sequence_fingerprint: input.expectedSequenceFingerprint,
      } as never,
    );
    if (error) return { ok: false, code: "management_unavailable" };
    return parseBookingSequenceRescheduleResult(data);
  } catch {
    return { ok: false, code: "management_unavailable" };
  }
}

export async function quoteBookingSequenceRescheduleForDesk(input: {
  salonId: string;
  bookingId: string;
  actorUserId: string;
  requestId: string;
  newStartTimeUtc: string;
}): Promise<{ ok: true; quote: BookingSequenceRescheduleQuote } | BookingSequenceRescheduleFailure> {
  if (
    !uuid(input.salonId) || !uuid(input.bookingId) || !uuid(input.actorUserId) ||
    !uuid(input.requestId) || !utc(input.newStartTimeUtc)
  ) return { ok: false, code: "invalid_request" };
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "quote_booking_sequence_reschedule_for_desk" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_actor_user_id: input.actorUserId,
        p_request_id: input.requestId,
        p_new_start_time_utc: input.newStartTimeUtc,
      } as never,
    );
    if (error) return { ok: false, code: "management_unavailable" };
    const quote = parseBookingSequenceRescheduleQuote(data);
    return quote && quote.salonId === input.salonId && quote.bookingId === input.bookingId
      ? { ok: true, quote }
      : { ok: false, code: safeCode(record(data)?.code) };
  } catch {
    return { ok: false, code: "management_unavailable" };
  }
}

export async function rescheduleBookingSequenceForDesk(input: {
  salonId: string;
  bookingId: string;
  actorUserId: string;
  notifyEmail: boolean;
  notifySms: boolean;
  requestId: string;
  newStartTimeUtc: string;
  expectedSequenceFingerprint: string;
}): Promise<{ ok: true; result: BookingSequenceRescheduleResult } | BookingSequenceRescheduleFailure> {
  if (
    !uuid(input.salonId) || !uuid(input.bookingId) || !uuid(input.actorUserId) ||
    !uuid(input.requestId) || !utc(input.newStartTimeUtc) ||
    typeof input.notifyEmail !== "boolean" || typeof input.notifySms !== "boolean" ||
    !SHA256_RE.test(input.expectedSequenceFingerprint)
  ) return { ok: false, code: "invalid_request" };
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "reschedule_booking_sequence_for_desk" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_actor_user_id: input.actorUserId,
        p_notify_email: input.notifyEmail,
        p_notify_sms: input.notifySms,
        p_request_id: input.requestId,
        p_new_start_time_utc: input.newStartTimeUtc,
        p_expected_sequence_fingerprint: input.expectedSequenceFingerprint,
      } as never,
    );
    if (error) return { ok: false, code: "management_unavailable" };
    return parseBookingSequenceRescheduleResult(data, {
      source: "staff",
      userId: input.actorUserId,
      notifyEmail: input.notifyEmail,
      notifySms: input.notifySms,
    });
  } catch {
    return { ok: false, code: "management_unavailable" };
  }
}

/** Read-only desk response-loss lookup; never resolves current availability. */
export async function replayBookingSequenceRescheduleForDesk(input: {
  salonId: string;
  bookingId: string;
  actorUserId: string;
  notifyEmail: boolean;
  notifySms: boolean;
  requestId: string;
  newStartTimeUtc: string;
  expectedSequenceFingerprint: string;
}): Promise<{ ok: true; result: BookingSequenceRescheduleResult } | BookingSequenceRescheduleFailure> {
  if (
    !uuid(input.salonId) || !uuid(input.bookingId) || !uuid(input.actorUserId) ||
    !uuid(input.requestId) || !utc(input.newStartTimeUtc) ||
    typeof input.notifyEmail !== "boolean" || typeof input.notifySms !== "boolean" ||
    !SHA256_RE.test(input.expectedSequenceFingerprint)
  ) return { ok: false, code: "invalid_request" };
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "replay_booking_sequence_reschedule_for_desk" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_actor_user_id: input.actorUserId,
        p_notify_email: input.notifyEmail,
        p_notify_sms: input.notifySms,
        p_request_id: input.requestId,
        p_new_start_time_utc: input.newStartTimeUtc,
        p_expected_sequence_fingerprint: input.expectedSequenceFingerprint,
      } as never,
    );
    if (error) return { ok: false, code: "management_unavailable" };
    return parseBookingSequenceRescheduleResult(data, {
      source: "staff",
      userId: input.actorUserId,
      notifyEmail: input.notifyEmail,
      notifySms: input.notifySms,
    });
  } catch {
    return { ok: false, code: "management_unavailable" };
  }
}
