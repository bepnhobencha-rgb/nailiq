import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isValidIanaTimeZone } from "@/shared/booking/bookingManagementTime";
import {
  parseBookingSequenceReceipt,
  type BookingSequenceReceipt,
} from "@/shared/booking/bookingSequenceReceipt";

export type IndividualBookingManagementAction =
  | "status"
  | "confirm"
  | "reschedule"
  | "cancel"
  | "card_manage";

export type BookingManagementScopeKind =
  | "booking_own"
  | "organizer_own"
  | "member_own"
  | "organizer_whole_party";
export type BookingAttendanceStatus = "pending" | "confirmed" | "declined" | null;

export type MintedBookingManagementCapability = {
  tokenId: string;
  action: IndividualBookingManagementAction;
  scopeKind: BookingManagementScopeKind;
  epoch: number;
  expiresAt: string;
  reused: boolean;
};

export type BookingManagementSnapshot = {
  status: string;
  attendanceStatus: BookingAttendanceStatus;
  startTimeUtc: string;
  endTimeUtc: string;
  serviceName: string | null;
  staffName: string | null;
  salonSlug: string;
  salonName: string;
  salonTimezone: string;
  scheduleModel: "single" | "segments_v1";
  sequenceReceipt: BookingSequenceReceipt | null;
};

export type BookingManagementInspection = {
  action: IndividualBookingManagementAction;
  scopeKind: BookingManagementScopeKind;
  epoch: number;
  expiresAt: string;
  booking: BookingManagementSnapshot;
  context: {
    bookingId: string;
    salonId: string;
    serviceId: string;
    staffId: string | null;
    durationMinutes: number;
    timezone: string;
    currentStartTimeUtc: string;
    currentEndTimeUtc: string;
    groupId: string | null;
    isGroupOrganizer: boolean;
  };
  cancelPreview: {
    startPast: boolean;
    withinWindow: boolean;
    willCharge: boolean;
    policyLockedByReschedule: boolean;
    feeCents: number;
    cardLast4: string | null;
    cardBrand: string | null;
    currency: string;
  };
  cardManage: {
    hasCard: boolean;
    cardFingerprint: string;
    cardLast4: string | null;
    cardBrand: string | null;
    chargeStatus: string | null;
  };
  group: Record<string, unknown> | null;
};

export type BookingManagementMutationResult = {
  code: string;
  action: IndividualBookingManagementAction;
  bookingId: string;
  salonId: string;
  serviceId: string;
  staffId: string | null;
  serviceName: string | null;
  staffName: string | null;
  salonSlug: string;
  salonName: string;
  salonTimezone: string;
  status: string;
  groupId: string | null;
  scopeKind: BookingManagementScopeKind;
  rsvpSemantic: "confirm" | "decline" | null;
  attendanceStatus: BookingAttendanceStatus;
  actionEpoch: number;
  transitionVersion: number | null;
  previousStartTimeUtc: string;
  startTimeUtc: string;
  endTimeUtc: string;
  idempotent: boolean;
  cancelPreview: BookingManagementInspection["cancelPreview"] | null;
  promotedWaitlist: {
    waitlistEntryId: string;
    claimCapabilityToken: string;
    offerEpoch: number;
    expiresAt: string;
  } | null;
};

export type BookingManagementFailure = { ok: false; code: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function action(value: unknown): IndividualBookingManagementAction | null {
  return value === "status" || value === "confirm" || value === "reschedule" ||
    value === "cancel" || value === "card_manage"
    ? value
    : null;
}

function scopeKind(value: unknown): BookingManagementScopeKind | null {
  return value === "booking_own" || value === "organizer_own" ||
    value === "member_own" || value === "organizer_whole_party"
    ? value
    : null;
}

function attendanceStatus(value: unknown): BookingAttendanceStatus | undefined {
  return value == null || value === "pending" || value === "confirmed" || value === "declined"
    ? value as BookingAttendanceStatus
    : undefined;
}

function nullableCardField(value: unknown): string | null | undefined {
  return value == null ? null : string(value) ?? undefined;
}

function safeCode(value: unknown): string {
  const code = string(value);
  return code && /^[a-z0-9_]{1,64}$/.test(code) ? code : "management_unavailable";
}

export function isBookingManagementToken(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function parseMintedBookingManagementCapability(
  value: unknown,
  expectedAction: IndividualBookingManagementAction,
): { ok: true; capability: MintedBookingManagementCapability } | BookingManagementFailure {
  const row = record(value);
  if (!row || row.ok !== true) return { ok: false, code: safeCode(row?.code) };
  const parsedAction = action(row.action);
  const tokenId = string(row.token_id);
  const parsedScopeKind = scopeKind(row.scope_kind);
  const epoch = integer(row.epoch);
  const expiresAt = string(row.expires_at);
  if (
    (row.code !== "minted" && row.code !== "reused") || parsedAction !== expectedAction ||
    !tokenId || !isBookingManagementToken(tokenId) || !parsedScopeKind || epoch === null ||
    !expiresAt || !Number.isFinite(Date.parse(expiresAt))
  ) return { ok: false, code: "invalid_management_response" };
  return {
    ok: true,
    capability: {
      tokenId,
      action: parsedAction,
      scopeKind: parsedScopeKind,
      epoch,
      expiresAt,
      reused: row.code === "reused",
    },
  };
}

export async function mintBookingManagementCapability(input: {
  salonId: string;
  bookingId: string;
  action: IndividualBookingManagementAction;
  minExpiresAt: string;
}, db = createServiceRoleClient()): Promise<{ ok: true; capability: MintedBookingManagementCapability } | BookingManagementFailure> {
  if (
    !isBookingManagementToken(input.salonId) || !isBookingManagementToken(input.bookingId) ||
    !Number.isFinite(Date.parse(input.minExpiresAt)) || Date.parse(input.minExpiresAt) <= Date.now()
  ) return { ok: false, code: "invalid_request" };

  const { data, error } = await db.rpc(
    "mint_booking_management_capability" as never,
    {
      p_salon_id: input.salonId,
      p_booking_id: input.bookingId,
      p_action: input.action,
      p_min_expires_at: input.minExpiresAt,
    } as never,
  );
  if (error) return { ok: false, code: "management_unavailable" };
  return parseMintedBookingManagementCapability(data, input.action);
}

/**
 * Exchanges the exact canonical public-create binding for a short-lived card
 * capability. This is service-role only and is not a mint-by-booking-id path.
 */
export async function exchangePublicBookingCardManagementCapability(input: {
  salonId: string;
  bookingId: string;
  idempotencyKey: string;
  pricingFingerprint: string;
}): Promise<{ ok: true; capability: MintedBookingManagementCapability } | BookingManagementFailure> {
  if (!isBookingManagementToken(input.salonId) || !isBookingManagementToken(input.bookingId) ||
      !isBookingManagementToken(input.idempotencyKey) ||
      !/^[0-9a-f]{64}$/.test(input.pricingFingerprint)) {
    return { ok: false, code: "invalid_request" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "exchange_public_booking_card_management_capability" as never,
    {
      p_salon_id: input.salonId,
      p_booking_id: input.bookingId,
      p_idempotency_key: input.idempotencyKey,
      p_pricing_fingerprint: input.pricingFingerprint,
    } as never,
  );
  if (error) return { ok: false, code: "management_unavailable" };
  const parsed = parseMintedBookingManagementCapability(data, "card_manage");
  if (parsed.ok) return parsed;
  const response = record(data);
  if (response?.ok === true && response.code === "exchanged") {
    return parseMintedBookingManagementCapability({ ...response, code: "minted" }, "card_manage");
  }
  return parsed;
}

export function parseBookingManagementInspection(
  value: unknown,
  expectedAction: IndividualBookingManagementAction,
): { ok: true; inspection: BookingManagementInspection } | BookingManagementFailure {
  const row = record(value);
  if (!row || row.ok !== true) return { ok: false, code: safeCode(row?.code) };

  const parsedAction = action(row.action);
  const parsedScopeKind = scopeKind(row.scope_kind);
  const epoch = integer(row.epoch);
  const expiresAt = string(row.expires_at);
  const booking = record(row.booking);
  const context = record(row.context);
  const cancelPreview = record(row.cancel_preview);
  const cardManage = record(row.card_manage);
  const status = string(booking?.status);
  const parsedAttendanceStatus = attendanceStatus(booking?.attendance_status);
  const startTimeUtc = string(booking?.start_time_utc);
  const endTimeUtc = string(booking?.end_time_utc);
  const salonSlug = string(booking?.salon_slug);
  const salonName = string(booking?.salon_name);
  const salonTimezone = string(booking?.salon_timezone);
  const scheduleModel = booking?.schedule_model === "single" || booking?.schedule_model === "segments_v1"
    ? booking.schedule_model
    : null;
  const sequenceReceipt = booking?.sequence_receipt == null
    ? null
    : parseBookingSequenceReceipt(booking.sequence_receipt);
  const bookingId = string(context?.booking_id);
  const salonId = string(context?.salon_id);
  const serviceId = string(context?.service_id);
  const staffId = context?.staff_id == null ? null : string(context.staff_id);
  const durationMinutes = typeof context?.duration_minutes === "number" &&
    Number.isFinite(context.duration_minutes) && context.duration_minutes > 0
    ? context.duration_minutes
    : null;
  const timezone = string(context?.timezone);
  const currentStartTimeUtc = string(context?.current_start_time_utc);
  const currentEndTimeUtc = string(context?.current_end_time_utc);
  const groupId = context?.group_id == null ? null : string(context.group_id);

  if (
    row.code !== "valid" || parsedAction !== expectedAction || !parsedScopeKind || epoch === null ||
    !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || !booking || !status ||
    !startTimeUtc || !endTimeUtc || !salonSlug || !salonName || !salonTimezone || !scheduleModel ||
    (scheduleModel === "single" && booking.sequence_receipt != null) ||
    (scheduleModel === "segments_v1" && !sequenceReceipt) ||
    !isValidIanaTimeZone(salonTimezone) || salonTimezone !== timezone || !context || !bookingId ||
    !isBookingManagementToken(bookingId) || !salonId || !isBookingManagementToken(salonId) ||
    !serviceId || !isBookingManagementToken(serviceId) ||
    (context.staff_id != null && (!staffId || !isBookingManagementToken(staffId))) ||
    durationMinutes === null || !timezone || !isValidIanaTimeZone(timezone) ||
    !currentStartTimeUtc || !currentEndTimeUtc ||
    !Number.isFinite(Date.parse(currentStartTimeUtc)) || !Number.isFinite(Date.parse(currentEndTimeUtc)) ||
    (context.group_id != null && (!groupId || !isBookingManagementToken(groupId))) ||
    typeof context.is_group_organizer !== "boolean" || !cancelPreview || !cardManage ||
    typeof cancelPreview.start_past !== "boolean" || typeof cancelPreview.within_window !== "boolean" ||
    typeof cancelPreview.will_charge !== "boolean" ||
    typeof cancelPreview.policy_locked_by_reschedule !== "boolean" ||
    integer(cancelPreview.fee_cents) === null || !string(cancelPreview.currency) ||
    parsedAttendanceStatus === undefined || typeof cardManage.has_card !== "boolean" ||
    !string(cardManage.card_fingerprint) || !/^[0-9a-f]{64}$/.test(string(cardManage.card_fingerprint)!) ||
    nullableCardField(cardManage.card_last4) === undefined ||
    nullableCardField(cardManage.card_brand) === undefined ||
    nullableCardField(cardManage.charge_status) === undefined ||
    !Number.isFinite(Date.parse(startTimeUtc)) || !Number.isFinite(Date.parse(endTimeUtc))
  ) return { ok: false, code: "invalid_management_response" };
  if (
    sequenceReceipt && (
      sequenceReceipt.bookingId !== bookingId ||
      sequenceReceipt.salonId !== salonId ||
      sequenceReceipt.status !== status ||
      sequenceReceipt.parentStartTimeUtc !== startTimeUtc ||
      sequenceReceipt.parentEndTimeUtc !== endTimeUtc
    )
  ) return { ok: false, code: "invalid_management_response" };

  return {
    ok: true,
    inspection: {
      action: parsedAction,
      scopeKind: parsedScopeKind,
      epoch,
      expiresAt,
      booking: {
        status,
        attendanceStatus: parsedAttendanceStatus,
        startTimeUtc,
        endTimeUtc,
        serviceName: string(booking.service_name),
        staffName: string(booking.staff_name),
        salonSlug,
        salonName,
        salonTimezone,
        scheduleModel,
        sequenceReceipt,
      },
      context: {
        bookingId,
        salonId,
        serviceId,
        staffId,
        durationMinutes,
        timezone,
        currentStartTimeUtc,
        currentEndTimeUtc,
        groupId,
        isGroupOrganizer: context.is_group_organizer,
      },
      cancelPreview: {
        startPast: cancelPreview.start_past,
        withinWindow: cancelPreview.within_window,
        willCharge: cancelPreview.will_charge,
        policyLockedByReschedule: cancelPreview.policy_locked_by_reschedule,
        feeCents: integer(cancelPreview.fee_cents)!,
        cardLast4: string(cancelPreview.card_last4),
        cardBrand: string(cancelPreview.card_brand),
        currency: string(cancelPreview.currency)!,
      },
      cardManage: {
        hasCard: cardManage.has_card,
        cardFingerprint: string(cardManage.card_fingerprint)!,
        cardLast4: nullableCardField(cardManage.card_last4)!,
        cardBrand: nullableCardField(cardManage.card_brand)!,
        chargeStatus: nullableCardField(cardManage.charge_status)!,
      },
      group: record(row.group),
    },
  };
}

export function parseBookingManagementMutation(
  value: unknown,
  expectedAction: IndividualBookingManagementAction,
): { ok: true; result: BookingManagementMutationResult } | BookingManagementFailure {
  const row = record(value);
  if (!row || row.ok !== true) return { ok: false, code: safeCode(row?.code) };

  const parsedAction = action(row.action);
  const bookingId = string(row.booking_id);
  const salonId = string(row.salon_id);
  const serviceId = string(row.service_id);
  const staffId = row.staff_id == null ? null : string(row.staff_id);
  const serviceName = string(row.service_name);
  const staffName = string(row.staff_name);
  const salonSlug = string(row.salon_slug);
  const salonName = string(row.salon_name);
  const salonTimezone = string(row.salon_timezone);
  const status = string(row.status);
  const groupId = row.group_id == null ? null : string(row.group_id);
  const parsedScopeKind = scopeKind(row.scope_kind);
  const rsvpSemantic = row.rsvp_semantic == null
    ? null
    : row.rsvp_semantic === "confirm" || row.rsvp_semantic === "decline"
      ? row.rsvp_semantic
      : undefined;
  const parsedAttendanceStatus = attendanceStatus(row.attendance_status);
  const actionEpoch = integer(row.action_epoch);
  const transitionVersion = row.customer_transition_version == null
    ? null
    : integer(row.customer_transition_version);
  const previousStartTimeUtc = string(row.previous_start_time_utc);
  const startTimeUtc = string(row.start_time_utc);
  const endTimeUtc = string(row.end_time_utc);
  const cancelPreview = row.cancel_preview == null ? null : record(row.cancel_preview);
  const promotedWaitlist = row.promoted_waitlist == null ? null : record(row.promoted_waitlist);

  if (
    parsedAction !== expectedAction || !bookingId || !isBookingManagementToken(bookingId) ||
    !salonId || !isBookingManagementToken(salonId) || !serviceId || !isBookingManagementToken(serviceId) ||
    (row.staff_id != null && (!staffId || !isBookingManagementToken(staffId))) ||
    !salonSlug || !salonName || !salonTimezone || !isValidIanaTimeZone(salonTimezone) ||
    !status || !parsedScopeKind ||
    (row.group_id != null && (!groupId || !isBookingManagementToken(groupId))) ||
    ((parsedScopeKind === "member_own" || parsedScopeKind === "organizer_own" ||
      parsedScopeKind === "organizer_whole_party") && groupId === null) ||
    (parsedScopeKind === "booking_own" && groupId !== null) ||
    rsvpSemantic === undefined || parsedAttendanceStatus === undefined || actionEpoch === null ||
    ((parsedScopeKind === "member_own" || parsedScopeKind === "organizer_own") &&
      (expectedAction === "confirm" || expectedAction === "cancel") &&
      (rsvpSemantic !== (expectedAction === "confirm" ? "confirm" : "decline") ||
        parsedAttendanceStatus !== (expectedAction === "confirm" ? "confirmed" : "declined"))) ||
    (parsedScopeKind === "booking_own" && rsvpSemantic !== null) ||
    (row.customer_transition_version != null && transitionVersion === null) ||
    !previousStartTimeUtc || !Number.isFinite(Date.parse(previousStartTimeUtc)) ||
    !startTimeUtc || !endTimeUtc || !Number.isFinite(Date.parse(startTimeUtc)) ||
    !Number.isFinite(Date.parse(endTimeUtc)) || typeof row.idempotent !== "boolean" ||
    ((expectedAction === "reschedule" || expectedAction === "cancel") && cancelPreview === null) ||
    (cancelPreview !== null && (
      typeof cancelPreview.start_past !== "boolean" ||
      typeof cancelPreview.within_window !== "boolean" ||
      typeof cancelPreview.will_charge !== "boolean" ||
      typeof cancelPreview.policy_locked_by_reschedule !== "boolean" ||
      integer(cancelPreview.fee_cents) === null || !string(cancelPreview.currency)
    )) ||
    (promotedWaitlist !== null && (
      !string(promotedWaitlist.waitlist_entry_id) ||
      !isBookingManagementToken(string(promotedWaitlist.waitlist_entry_id)!) ||
      !string(promotedWaitlist.claim_capability_token) ||
      !isBookingManagementToken(string(promotedWaitlist.claim_capability_token)!) ||
      integer(promotedWaitlist.offer_epoch) === null || integer(promotedWaitlist.offer_epoch) === 0 ||
      !string(promotedWaitlist.expires_at) ||
      !Number.isFinite(Date.parse(string(promotedWaitlist.expires_at)!))
    ))
  ) return { ok: false, code: "invalid_management_response" };

  return {
    ok: true,
    result: {
      code: safeCode(row.code),
      action: parsedAction,
      bookingId,
      salonId,
      serviceId,
      staffId,
      serviceName,
      staffName,
      salonSlug,
      salonName,
      salonTimezone,
      status,
      groupId,
      scopeKind: parsedScopeKind,
      rsvpSemantic,
      attendanceStatus: parsedAttendanceStatus,
      actionEpoch,
      transitionVersion,
      previousStartTimeUtc,
      startTimeUtc,
      endTimeUtc,
      idempotent: row.idempotent,
      cancelPreview: cancelPreview ? {
        startPast: cancelPreview.start_past as boolean,
        withinWindow: cancelPreview.within_window as boolean,
        willCharge: cancelPreview.will_charge as boolean,
        policyLockedByReschedule: cancelPreview.policy_locked_by_reschedule as boolean,
        feeCents: integer(cancelPreview.fee_cents)!,
        cardLast4: string(cancelPreview.card_last4),
        cardBrand: string(cancelPreview.card_brand),
        currency: string(cancelPreview.currency)!,
      } : null,
      promotedWaitlist: promotedWaitlist ? {
        waitlistEntryId: string(promotedWaitlist.waitlist_entry_id)!,
        claimCapabilityToken: string(promotedWaitlist.claim_capability_token)!,
        offerEpoch: integer(promotedWaitlist.offer_epoch)!,
        expiresAt: string(promotedWaitlist.expires_at)!,
      } : null,
    },
  };
}

export async function inspectBookingManagementCapability(input: {
  tokenId: string;
  expectedAction: IndividualBookingManagementAction;
}): Promise<{ ok: true; inspection: BookingManagementInspection } | BookingManagementFailure> {
  if (!isBookingManagementToken(input.tokenId)) return { ok: false, code: "invalid_request" };
  const { data, error } = await createServiceRoleClient().rpc(
    "inspect_booking_management_capability_with_sequence" as never,
    { p_token_id: input.tokenId, p_expected_action: input.expectedAction } as never,
  );
  if (error) return { ok: false, code: "management_unavailable" };
  return parseBookingManagementInspection(data, input.expectedAction);
}

export async function confirmBookingWithManagementCapability(input: {
  tokenId: string;
  requestId: string;
}): Promise<{ ok: true; result: BookingManagementMutationResult } | BookingManagementFailure> {
  if (!isBookingManagementToken(input.tokenId) || !isBookingManagementToken(input.requestId)) {
    return { ok: false, code: "invalid_request" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "confirm_booking_with_management_capability" as never,
    { p_token_id: input.tokenId, p_request_id: input.requestId } as never,
  );
  if (error) return { ok: false, code: "management_unavailable" };
  return parseBookingManagementMutation(data, "confirm");
}

export async function rescheduleBookingWithManagementCapability(input: {
  tokenId: string;
  requestId: string;
  newStartTimeUtc: string;
  newEndTimeUtc: string;
}): Promise<{ ok: true; result: BookingManagementMutationResult } | BookingManagementFailure> {
  if (
    !isBookingManagementToken(input.tokenId) || !isBookingManagementToken(input.requestId) ||
    !Number.isFinite(Date.parse(input.newStartTimeUtc)) || !Number.isFinite(Date.parse(input.newEndTimeUtc))
  ) return { ok: false, code: "invalid_request" };
  const { data, error } = await createServiceRoleClient().rpc(
    "reschedule_booking_with_management_capability" as never,
    {
      p_token_id: input.tokenId,
      p_request_id: input.requestId,
      p_new_start_utc: input.newStartTimeUtc,
      p_new_end_utc: input.newEndTimeUtc,
    } as never,
  );
  if (error) return { ok: false, code: "management_unavailable" };
  return parseBookingManagementMutation(data, "reschedule");
}

export async function cancelBookingWithManagementCapability(input: {
  tokenId: string;
  requestId: string;
}, db = createServiceRoleClient()): Promise<{ ok: true; result: BookingManagementMutationResult } | BookingManagementFailure> {
  if (!isBookingManagementToken(input.tokenId) || !isBookingManagementToken(input.requestId)) {
    return { ok: false, code: "invalid_request" };
  }
  const { data, error } = await db.rpc(
    "cancel_booking_with_management_capability" as never,
    { p_token_id: input.tokenId, p_request_id: input.requestId } as never,
  );
  if (error) return { ok: false, code: "management_unavailable" };
  return parseBookingManagementMutation(data, "cancel");
}
