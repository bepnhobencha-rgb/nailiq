import { after } from "next/server";
import * as ErrorReporter from "@/shared/observability/errorReporter";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { SalonDashboardBooking } from "@/shared/types";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { type ActorRole, logBookingEvent } from "@/shared/dashboard/auditLog";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import { checkBookingWithinOpeningHours } from "@/shared/booking/bookingWithinOpeningHours";
import {
  salonYmdOfUtc,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { compareBookingStartInstants } from "@/shared/dashboard/bookingStartComparison";
import { getResourceMode, resolveFreeResource } from "@/shared/booking/resolveResource";
import {
  type BookingRowDb,
  DASHBOARD_BOOKING_SELECT,
  mapDashboardBookingRow,
} from "@/shared/dashboard/dashboardBookingMap";
import {
  quoteBookingSequenceRescheduleForDesk,
  replayBookingSequenceRescheduleForDesk,
  rescheduleBookingSequenceForDesk,
  type BookingSequenceRescheduleQuote,
  type BookingSequenceRescheduleResult,
} from "@/shared/booking/bookingSequenceReschedule";
import { deliverPromotedWaitlistOffer } from "@/shared/noshow/deliverPromotedWaitlistOffer";
import { stableBookingIdempotencyKey } from "@/shared/booking/stableBookingIdempotencyKey";
import {
  type ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidLike(value: string): boolean {
  return UUID_RE.test(value.trim());
}

type BookingEditRow = {
  id?: unknown;
  status?: unknown;
  staff_id?: unknown;
  service_id?: unknown;
  start_time_utc?: unknown;
  end_time_utc?: unknown;
  addon_service_id?: unknown;
  resource_id?: unknown;
  schedule_model?: unknown;
};

type ServiceTimingRow = {
  id?: unknown;
  duration_minutes?: unknown;
  buffer_minutes?: unknown;
  price_cents?: unknown;
};

/** Q1 desk edit payload: time + staff + service (+ optional addon). */
export type EditBookingInput = {
  salonId: string;
  bookingId: string;
  newStartTimeUtc: string;
  newStaffId: string;
  newServiceId: string;
  /**
   * Replacement add-on service. `null` removes any existing add-on;
   * `undefined` preserves the current add-on (back-compat with callers
   * that don't yet send this field). A non-null id is validated against
   * the salon's catalog and contributes to span + price recompute.
   */
  newAddonServiceId?: string | null;
  /** Channels to notify the customer on when the START TIME changes (a
   *  reschedule). Omitted → SMS only (legacy behavior). The edit form / drag
   *  pass the receptionist's choice; an unchecked channel isn't sent. */
  notify?: { sms?: boolean; email?: boolean };
  /** Explicit bed/chair override chosen by the receptionist.
   *  `null` = release current bed and auto-assign a free one.
   *  `undefined` = keep current booking's bed as the preferred one (default). */
  newResourceId?: string | null;
  /** Stable browser-owned UUID retained through sequence quote/apply replay. */
  sequenceRequestId?: string;
  /** Present only after explicit review of the authoritative full sequence. */
  expectedSequenceFingerprint?: string;
};

export type EditBookingError =
  | "not_found"
  | "invalid_status"
  | "past_date"
  | "outside_hours"
  | "slot_conflict"
  | "staff_cannot_perform_service"
  | "sequence_reschedule_required"
  | "idempotency_mismatch"
  | "server_error"
  /** Resource-mode salon: every bed/chair is occupied for the new time. */
  | "no_resource_available"
  /** Caller's `salon_members.role` is not allowed to edit (e.g. `nail_tech`).
   * Existing `EditBookingForm` switch falls through to the generic server-
   * error message, which is fine — the UI already hides the form for that
   * role; this code path only fires if a non-permitted caller hits the
   * action directly (devtools / replayed request). */
  | "unauthorized";

export type EditBookingResult =
  | { ok: true; updated: SalonDashboardBooking }
  | {
      ok: false;
      error: "sequence_review_required";
      sequenceReview: {
        requestId: string;
        quote: BookingSequenceRescheduleQuote;
        changed: boolean;
      };
    }
  | { ok: false; error: EditBookingError; conflictWith?: string };

async function finishDeskSequenceReschedule(args: {
  salonId: string;
  bookingId: string;
  requestId: string;
  actor?: { role: ActorRole; userId: string | null };
  actorUserId: string;
  committed: BookingSequenceRescheduleResult;
}): Promise<EditBookingResult> {
  const sr = createServiceRoleClient();
  const { data: row, error: rowError } = await sr
    .from("bookings" as never)
    .select(DASHBOARD_BOOKING_SELECT as never)
    .eq("id" as never, args.bookingId)
    .eq("salon_id" as never, args.salonId)
    .maybeSingle();
  if (rowError || !row) return { ok: false, error: "server_error" };

  const auditId = stableBookingIdempotencyKey({
    channel: "desk_sequence_reschedule_audit",
    salonId: args.salonId,
    bookingId: args.bookingId,
    requestId: args.requestId,
    eventType: "booking_rescheduled",
  });
  const { error: auditError } = await sr.from("booking_events" as never).insert({
    id: auditId,
    booking_id: args.bookingId,
    salon_id: args.salonId,
    actor_user_id: args.actorUserId,
    actor_role: args.actor?.role ?? "system",
    event_type: "booking_rescheduled",
    payload: {
      management_request_id: args.requestId,
      previous_start_time_utc: args.committed.previousStartTimeUtc,
      new_start_time_utc: args.committed.startTimeUtc,
      sequence_fingerprint: args.committed.sequenceFingerprint,
    },
  } as never);
  if (auditError && (auditError as { code?: string }).code !== "23505") {
    console.error("[performEditBooking] sequence audit", auditError);
  }

  // The DB sequence wrapper captured both requested staff-action channels in
  // the same transaction as the full-sequence move.
  after(async () => {
    await sendOwnerBookingNotification({
      salonId: args.salonId,
      bookingId: args.bookingId,
      event: "reschedule",
      previousStartUtc: args.committed.previousStartTimeUtc,
      changedBy: args.actor?.role ?? "system",
      changedFields: ["time"],
    });
    if (args.committed.promotedWaitlist) {
      await deliverPromotedWaitlistOffer({
        salonId: args.salonId,
        offer: args.committed.promotedWaitlist,
      });
    }
  });
  return {
    ok: true,
    updated: mapDashboardBookingRow(row as unknown as BookingRowDb),
  };
}

/**
 * Core edit-booking mutation (desk): pending | confirmed only, slot overlap check,
 * then update staff/start/end/service/price only. Caller supplies authenticated client.
 *
 * `actor` is optional and exists only so the audit-log row can attribute the
 * change. Omitting it logs `actorRole: "system"` and `actorUserId: null` —
 * still useful for forensics.
 */
export async function performEditBooking(
  supabase: SupabaseClient<Database>,
  authorizedSalonId: string,
  input: EditBookingInput,
  actor?: { role: ActorRole; userId: string | null },
): Promise<EditBookingResult> {
  const expectedSalon = String(authorizedSalonId ?? "").trim();
  const salonIdFromInput = String(input.salonId ?? "").trim();
  if (!expectedSalon || salonIdFromInput !== expectedSalon) {
    return { ok: false, error: "server_error" };
  }
  const salonId = salonIdFromInput;

  const bookingId = String(input.bookingId ?? "").trim();
  const newStaffId = String(input.newStaffId ?? "").trim();
  const newServiceId = String(input.newServiceId ?? "").trim();
  const slotStartUtc = String(input.newStartTimeUtc ?? "").trim();

  if (!bookingId || !isUuidLike(bookingId)) {
    return { ok: false, error: "not_found" };
  }
  if (!newStaffId || !isUuidLike(newStaffId)) {
    return { ok: false, error: "server_error" };
  }
  if (!newServiceId || !isUuidLike(newServiceId)) {
    return { ok: false, error: "server_error" };
  }

  const nextStartMs = Date.parse(slotStartUtc);
  if (Number.isNaN(nextStartMs)) {
    return { ok: false, error: "server_error" };
  }

  // Older desk callers do not yet own a request UUID. Generate it once for
  // this guarded mutation; modern/sequence callers retain their UUID through
  // response-loss replay and take precedence.
  const sequenceRequestId = input.sequenceRequestId?.trim() || crypto.randomUUID();
  const sequenceExpectedFingerprint = input.expectedSequenceFingerprint?.trim() ?? "";
  const sequenceActorUserId = actor?.userId?.trim() ?? "";
  const sequenceNotifyEmail = input.notify?.email === true;
  const sequenceNotifySms = (input.notify?.sms ?? true) === true;
  if (sequenceExpectedFingerprint) {
    if (
      !isUuidLike(sequenceRequestId) || !isUuidLike(sequenceActorUserId) ||
      !/^[0-9a-f]{64}$/.test(sequenceExpectedFingerprint)
    ) return { ok: false, error: "server_error" };
    const replay = await replayBookingSequenceRescheduleForDesk({
      salonId,
      bookingId,
      actorUserId: sequenceActorUserId,
      notifyEmail: sequenceNotifyEmail,
      notifySms: sequenceNotifySms,
      requestId: sequenceRequestId,
      newStartTimeUtc: slotStartUtc,
      expectedSequenceFingerprint: sequenceExpectedFingerprint,
    });
    if (replay.ok) {
      return finishDeskSequenceReschedule({
        salonId,
        bookingId,
        requestId: sequenceRequestId,
        actor,
        actorUserId: sequenceActorUserId,
        committed: replay.result,
      });
    }
    if (replay.code !== "replay_not_found") {
      return {
        ok: false,
        error: replay.code === "idempotency_mismatch"
          ? "idempotency_mismatch"
          : "server_error",
      };
    }
  }

  const { data: booking, error: bkErr } = await supabase
    .from("bookings")
    .select(
      "id, salon_id, status, staff_id, service_id, resource_id, start_time_utc, end_time_utc, addon_service_id, schedule_model",
    )
    .eq("id", bookingId)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (bkErr) {
    console.error("[performEditBooking] booking", bkErr);
    return { ok: false, error: "server_error" };
  }

  const bookingData = booking as unknown as BookingEditRow | null;
  if (!bookingData?.id) {
    return { ok: false, error: "not_found" };
  }
  // A segments_v1 parent is only a compatibility anchor. Editing that row
  // through the legacy desk form would leave authoritative child capacity and
  // the persisted receipt at the old schedule.
  if (bookingData.schedule_model === "segments_v1") {
    const requestId = sequenceRequestId;
    const actorUserId = sequenceActorUserId;
    if (!isUuidLike(requestId) || !isUuidLike(actorUserId)) {
      return { ok: false, error: "server_error" };
    }
    const expectedFingerprint = sequenceExpectedFingerprint;
    if (expectedFingerprint) {
      if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
        return { ok: false, error: "server_error" };
      }
      // A reviewed apply is also the exact response-loss replay seam. Do not
      // compare the mutable compatibility-anchor staff/resource fields first:
      // an `any` assignment can legitimately change them at commit time. The
      // desk RPC binds the stable request, actor, notify choice, start and
      // expected sequence fingerprint before returning the stored result.
      const notifyEmail = input.notify?.email === true;
      const applied = await rescheduleBookingSequenceForDesk({
        salonId,
        bookingId,
        actorUserId,
        notifyEmail,
        notifySms: sequenceNotifySms,
        requestId,
        newStartTimeUtc: slotStartUtc,
        expectedSequenceFingerprint: expectedFingerprint,
      });
      if (!applied.ok) {
        if (applied.code === "pricing_changed" && applied.quote) {
          return {
            ok: false,
            error: "sequence_review_required",
            sequenceReview: { requestId, quote: applied.quote, changed: true },
          };
        }
        return {
          ok: false,
          error: applied.code === "slot_conflict"
            ? "slot_conflict"
            : applied.code === "idempotency_mismatch"
              ? "idempotency_mismatch"
              : "server_error",
        };
      }
      return finishDeskSequenceReschedule({
        salonId,
        bookingId,
        requestId,
        actor,
          actorUserId,
          committed: applied.result,
      });
    }

    const currentStaffId = String(bookingData.staff_id ?? "").trim();
    const currentServiceId = String(bookingData.service_id ?? "").trim();
    const currentAddonId = String(bookingData.addon_service_id ?? "").trim();
    const currentResourceId = String(bookingData.resource_id ?? "").trim();
    if (
      newStaffId !== currentStaffId || newServiceId !== currentServiceId ||
      (input.newAddonServiceId !== undefined && (input.newAddonServiceId ?? "") !== currentAddonId) ||
      (input.newResourceId !== undefined && (input.newResourceId ?? "") !== currentResourceId)
    ) return { ok: false, error: "sequence_reschedule_required" };

    const { data: staffRow, error: staffErr } = await supabase
      .from("staff")
      .select("id")
      .eq("id", newStaffId)
      .eq("salon_id", salonId)
      .is("deleted_at" as never, null)
      .maybeSingle();
    if (staffErr || !(staffRow as unknown as { id?: unknown } | null)?.id) {
      return { ok: false, error: "server_error" };
    }

    const quoted = await quoteBookingSequenceRescheduleForDesk({
      salonId,
      bookingId,
      actorUserId,
      requestId,
      newStartTimeUtc: slotStartUtc,
    });
    if (!quoted.ok) {
      return {
        ok: false,
        error: quoted.code === "slot_conflict" ? "slot_conflict" : "server_error",
      };
    }
    return {
      ok: false,
      error: "sequence_review_required",
      sequenceReview: { requestId, quote: quoted.quote, changed: false },
    };
  }

  const { data: staffRow, error: staffErr } = await supabase
    .from("staff")
    .select("id")
    .eq("id", newStaffId)
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (staffErr || !(staffRow as unknown as { id?: unknown } | null)?.id) {
    return { ok: false, error: "server_error" };
  }

  const st =
    bookingData.start_time_utc != null
      ? String(bookingData.start_time_utc).trim()
      : "";
  const en =
    bookingData.end_time_utc != null
      ? String(bookingData.end_time_utc).trim()
      : "";
  if (!st || !en) {
    return { ok: false, error: "server_error" };
  }
  const startComparison = compareBookingStartInstants(st, slotStartUtc);
  if (!startComparison.ok) {
    return { ok: false, error: "server_error" };
  }
  const startMs = startComparison.nextMs;
  const startChanged = startComparison.changed;

  const status = String(bookingData.status);
  if (status !== "pending" && status !== "confirmed") {
    return { ok: false, error: "invalid_status" };
  }

  // Don't allow rescheduling to a time in the PAST (mirrors the grid drag-drop
  // guard; the Edit form previously had no such check, so a date change could
  // land a "confirmed" booking days ago). Only a CHANGED start is checked —
  // editing staff/service while keeping an already-past time is still allowed.
  // Compare INSTANTS (not raw strings — formats differ, e.g. trailing seconds)
  // so an unchanged-time edit (staff/service only) on an already-past booking
  // isn't mis-flagged as moving to the past.
  const PAST_GRACE_MS = 2 * 60 * 1000;
  if (startChanged && startMs < Date.now() - PAST_GRACE_MS) {
    return { ok: false, error: "past_date" };
  }

  const { data: svc, error: svcErr } = await supabase
    .from("services")
    .select("id, duration_minutes, buffer_minutes, price_cents")
    .eq("id", newServiceId)
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (svcErr) {
    console.error("[performEditBooking] service", svcErr);
    return { ok: false, error: "server_error" };
  }
  const svcData = svc as unknown as ServiceTimingRow | null;
  if (!svcData?.id) {
    return { ok: false, error: "server_error" };
  }

  /* Capability gate. Empty staff_services for this salon → all-capable
     fallback (skip the per-pair check). */
  const { data: hasCap } = await supabase.rpc("salon_has_staff_services", {
    p_salon_id: salonId,
  });
  if (hasCap === true) {
    const { data: capRow } = await supabase
      .from("staff_services")
      .select("staff_id")
      .eq("staff_id", newStaffId)
      .eq("service_id", newServiceId)
      .maybeSingle();
    if (
      !(capRow as unknown as { staff_id?: unknown } | null)?.staff_id
    ) {
      return { ok: false, error: "staff_cannot_perform_service" };
    }
  }

  const duration = Math.round(Number(svcData.duration_minutes ?? 0));
  const buffer = Math.round(Number(svcData.buffer_minutes ?? 0));
  if (!Number.isFinite(duration) || duration < 1) {
    return { ok: false, error: "server_error" };
  }
  if (!Number.isFinite(buffer) || buffer < 0) {
    return { ok: false, error: "server_error" };
  }

  /* Resolve the effective addon id.
     - `newAddonServiceId === undefined` → preserve existing (back-compat).
     - `newAddonServiceId === null`      → remove the addon.
     - Otherwise                          → replace with the supplied id. */
  let effectiveAddonId: string | null;
  if (input.newAddonServiceId === undefined) {
    const existing =
      bookingData.addon_service_id != null
        ? String(bookingData.addon_service_id).trim()
        : "";
    effectiveAddonId = existing.length > 0 ? existing : null;
  } else if (input.newAddonServiceId === null) {
    effectiveAddonId = null;
  } else {
    const id = String(input.newAddonServiceId).trim();
    if (id.length === 0) {
      effectiveAddonId = null;
    } else {
      if (!isUuidLike(id)) return { ok: false, error: "server_error" };
      effectiveAddonId = id;
    }
  }

  let addonSpanMin = 0;
  let addonDurationMin = 0;
  let addonBufferMin = 0;
  let addonPriceCents: number | null = null;
  if (effectiveAddonId) {
    const { data: addonSvc, error: addonErr } = await supabase
      .from("services")
      .select("duration_minutes, buffer_minutes, price_cents")
      .eq("id", effectiveAddonId)
      .eq("salon_id", salonId)
      .is("deleted_at" as never, null)
      .maybeSingle();
    if (addonErr) {
      console.error("[performEditBooking] addon service", addonErr);
      return { ok: false, error: "server_error" };
    }
    const addonSvcData =
      addonSvc as unknown as ServiceTimingRow | null;
    if (!addonSvcData) {
      return { ok: false, error: "server_error" };
    }
    const aDur = Math.round(Number(addonSvcData.duration_minutes ?? 0));
    const aBuf = Math.round(Number(addonSvcData.buffer_minutes ?? 0));
    if (!Number.isFinite(aDur) || aDur < 1) {
      return { ok: false, error: "server_error" };
    }
    if (!Number.isFinite(aBuf) || aBuf < 0) {
      return { ok: false, error: "server_error" };
    }
    addonDurationMin = aDur;
    addonBufferMin = aBuf;
    addonSpanMin = serviceBlockMinutes(aDur, aBuf);
    const aPrice =
      addonSvcData.price_cents != null
        ? Math.round(Number(addonSvcData.price_cents))
        : null;
    addonPriceCents = Number.isFinite(aPrice ?? NaN) ? aPrice : null;
  }

  const bookingTiming = computeBookingTiming(
    { durationMinutes: duration, bufferMinutes: buffer },
    effectiveAddonId
      ? [
          {
            durationMinutes: addonDurationMin,
            bufferMinutes: addonBufferMin,
          },
        ]
      : [],
  );
  const totalMin = serviceBlockMinutes(duration, buffer) + addonSpanMin;
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

  const previousServiceId = String(bookingData.service_id ?? "").trim();
  const previousAddonId = String(bookingData.addon_service_id ?? "").trim();
  const affectsServiceWindow =
    startChanged ||
    newServiceId !== previousServiceId ||
    (effectiveAddonId ?? "") !== previousAddonId;

  // Preserve existing exceptional bookings when the receptionist only
  // reassigns staff. Changing the time, service, or add-on changes the
  // customer-facing service window and must satisfy today's opening hours.
  if (affectsServiceWindow) {
    const { data: salonRow, error: salonErr } = await supabase
      .from("salons")
      .select("opening_hours, booking_closed_dates, timezone")
      .eq("id", salonId)
      .maybeSingle();
    if (salonErr || !salonRow) {
      console.error("[performEditBooking] salon hours", salonErr);
      return { ok: false, error: "server_error" };
    }
    const timezone =
      String((salonRow as { timezone?: unknown }).timezone ?? "").trim() ||
      "America/Los_Angeles";
    const dateYmd = salonYmdOfUtc(slotStartUtc, timezone);
    const startMinutes = utcIsoToSalonMinutesFromMidnight(
      slotStartUtc,
      timezone,
    );
    const hoursCheck = checkBookingWithinOpeningHours({
      openingHoursRaw: (salonRow as { opening_hours?: unknown }).opening_hours,
      bookingClosedDatesRaw: (
        salonRow as { booking_closed_dates?: unknown }
      ).booking_closed_dates,
      dateYmd,
      startMinutes,
      serviceCompletionMinutes: bookingTiming.serviceCompletionMinutes,
    });
    if (!hoursCheck.ok) return { ok: false, error: "outside_hours" };
  }

  const price =
    svcData.price_cents != null
      ? Math.round(Number(svcData.price_cents))
      : null;
  const priceCents = Number.isFinite(price ?? NaN) ? price : null;

  const { data: existing, error: exErr } = await supabase
    .from("bookings")
    .select("id, staff_id, start_time_utc, end_time_utc, status, client_name")
    .eq("salon_id", salonId)
    .eq("staff_id", newStaffId)
    .in("status", ["pending", "confirmed", "in_progress", "completed"]);

  if (exErr) {
    console.error("[performEditBooking] overlap load", exErr);
    return { ok: false, error: "server_error" };
  }

  const conflict = checkBookingConflict({
    staffId: newStaffId,
    startUtcIso: slotStartUtc,
    endUtcIso: slotEndUtc,
    existingBookings:
      (existing ?? []) as unknown as ConflictCheckBooking[],
    excludeBookingId: bookingId,
  });
  if (conflict !== null) {
    const name =
      conflict.client_name != null && String(conflict.client_name).trim() !== ""
        ? String(conflict.client_name).trim()
        : "";
    ErrorReporter.captureEvent({
      message: "booking conflict detected (edit)",
      level: "warning",
      tags: {
        "nailiq.event": "booking_conflict",
        "nailiq.surface": "edit_booking",
      },
      extra: {
        salonId,
        bookingId,
        newStaffId,
        slotStartUtc,
        slotEndUtc,
        conflictBookingId: conflict.id,
      },
    });
    return {
      ok: false,
      error: "slot_conflict",
      conflictWith: name,
    };
  }

  // When the caller explicitly threads `newAddonServiceId` (even as
  // `null`), persist the addon swap atomically with the rest of the
  // edit. Back-compat callers that omit the field skip the addon
  // columns entirely so the existing addon survives untouched.
  const baseUpdate: Record<string, unknown> = {
    staff_id: newStaffId,
    start_time_utc: slotStartUtc,
    end_time_utc: slotEndUtc,
    service_id: newServiceId,
    price_cents: priceCents,
    // Mark this as a NailIQ-side edit so the Square reschedule sync knows NailIQ
    // owns the latest change (last-writer-wins vs the Square booking's updated_at).
    local_updated_at: new Date().toISOString(),
  };
  const notifySms = startChanged && (input.notify ? input.notify.sms === true : true);
  const notifyEmail = startChanged && (input.notify ? input.notify.email === true : false);
  const captureStaffActionNotification = notifySms || notifyEmail;
  if (captureStaffActionNotification &&
      (!isUuidLike(sequenceRequestId) ||
        !(isUuidLike(sequenceActorUserId) || actor?.role === "demo_cookie" || actor?.role === "system"))) {
    return { ok: false, error: "server_error" };
  }
  if (startChanged) {
    // A reschedule creates a new attendance window; an old no-show review flag
    // must never follow the booking to its new time.
    baseUpdate.no_show_candidate_at = null;
    if (captureStaffActionNotification) {
      baseUpdate.staff_action_notification_request_id = sequenceRequestId;
      baseUpdate.staff_action_notification_actor_user_id = actor?.userId ?? null;
      baseUpdate.staff_action_notification_actor_role = actor?.role ?? "system";
      baseUpdate.staff_action_notification_channels = {
        sms: notifySms,
        email: notifyEmail,
      };
      baseUpdate.staff_action_notification_delay_seconds = 5;
    }
  }
  if (input.newAddonServiceId !== undefined) {
    baseUpdate.addon_service_id = effectiveAddonId;
    baseUpdate.addon_price_cents = addonPriceCents;
  }

  // Resource-mode: honour the receptionist's explicit bed pick (newResourceId),
  // otherwise keep the booking's current bed as the preferred fallback.
  const editResMode = await getResourceMode(supabase, salonId);
  if (editResMode.enabled) {
    let preferred: string | null;
    if (input.newResourceId !== undefined) {
      preferred = input.newResourceId; // receptionist chose a specific bed (or null = auto)
    } else {
      const { data: cur } = await supabase
        .from("bookings")
        .select("resource_id")
        .eq("id", bookingId)
        .maybeSingle();
      preferred = (cur as { resource_id?: string | null } | null)?.resource_id ?? null;
    }
    const rr = await resolveFreeResource(supabase, salonId, slotStartUtc, slotEndUtc, preferred, bookingId);
    if (!rr.resourceId) return { ok: false, error: "no_resource_available" };
    baseUpdate.resource_id = rr.resourceId;
  }

  // The durable staff-action outbox consumes and clears these transient inputs
  // in the same transaction as the guarded booking move.
  const mutationDb = captureStaffActionNotification ? createServiceRoleClient() : supabase;
  const { data: updated, error: upErr } = await mutationDb
    .from("bookings")
    .update(baseUpdate as never)
    .eq("id", bookingId)
    .eq("salon_id", salonId)
    .in("status", ["pending", "confirmed"])
    .select("id")
    .maybeSingle();

  if (upErr) {
    // 23P01 = exclusion_violation (bookings_no_overlap GiST EXCLUDE).
    if (upErr.code === "23P01") {
      ErrorReporter.captureEvent({
        message: "DB-level slot conflict on edit (GiST EXCLUDE)",
        level: "warning",
        tags: {
          "nailiq.event": "booking_conflict",
          "nailiq.surface": "edit_booking",
          "nailiq.cause": "db_exclusion",
        },
        extra: { salonId, bookingId, newStaffId, slotStartUtc, slotEndUtc },
      });
      return { ok: false, error: "slot_conflict" };
    }
    console.error("[performEditBooking] update", upErr);
    ErrorReporter.captureException(upErr, {
      tags: {
        "nailiq.event": "booking_action_error",
        "nailiq.surface": "edit_booking",
      },
      extra: { salonId, bookingId, where: "update" },
    });
    return { ok: false, error: "server_error" };
  }

  if (!(updated as unknown as { id?: unknown } | null)?.id) {
    return { ok: false, error: "invalid_status" };
  }

  const { data: row, error: rowErr } = await supabase
    .from("bookings")
    .select(DASHBOARD_BOOKING_SELECT)
    .eq("id", bookingId)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (rowErr || !row) {
    console.error("[performEditBooking] hydrate", rowErr);
    return { ok: false, error: "server_error" };
  }

  // Audit log — fire-and-forget. The mutation already succeeded; logging
  // failures must not surface to the user or roll back the edit.
  void logBookingEvent({
    bookingId,
    salonId,
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? "system",
    eventType: "booking_edited",
    payload: {
      newStaffId,
      previousStaffId: String(bookingData.staff_id ?? "").trim() || null,
      newServiceId,
      previousServiceId: previousServiceId || null,
      previousStartTimeUtc: st,
      newStartTimeUtc: slotStartUtc,
      newEndTimeUtc: slotEndUtc,
      addonChanged: input.newAddonServiceId !== undefined,
      previousAddonServiceId: previousAddonId || null,
      newAddonServiceId: effectiveAddonId,
    },
  });

  // Only when the start time actually moved (a pure staff/service swap isn't a
  // reschedule) do we fire reschedule notifications. Opt-in, fire-and-forget.
  if (startChanged) {
    const changedFields: Array<"time" | "staff" | "service" | "addon"> = [
      "time",
    ];
    if (newStaffId !== String(bookingData.staff_id ?? "").trim()) {
      changedFields.push("staff");
    }
    if (newServiceId !== previousServiceId) changedFields.push("service");
    if ((effectiveAddonId ?? "") !== previousAddonId) changedFields.push("addon");

    // Owner/admin "rescheduled" alert.
    after(() =>
      sendOwnerBookingNotification({
        salonId,
        bookingId,
        event: "reschedule",
        previousStartUtc: st || null,
        changedBy: actor?.role ?? "system",
        changedFields,
      }),
    );

    // The booking mutation captured both requested channels atomically. The
    // worker renders only its immutable snapshot; no post-commit enqueue runs.
  }

  return {
    ok: true,
    updated: mapDashboardBookingRow(row as unknown as BookingRowDb),
  };
}
