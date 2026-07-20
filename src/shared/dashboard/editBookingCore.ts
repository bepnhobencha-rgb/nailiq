import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { SalonDashboardBooking } from "@/shared/types";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { type ActorRole, logBookingEvent } from "@/shared/dashboard/auditLog";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { getResourceMode, resolveFreeResource } from "@/shared/booking/resolveResource";
import {
  type BookingRowDb,
  DASHBOARD_BOOKING_SELECT,
  mapDashboardBookingRow,
} from "@/shared/dashboard/dashboardBookingMap";
import {
  type ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidLike(value: string): boolean {
  return UUID_RE.test(value.trim());
}

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
};

export type EditBookingError =
  | "not_found"
  | "invalid_status"
  | "past_date"
  | "slot_conflict"
  | "staff_cannot_perform_service"
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
  | { ok: false; error: EditBookingError; conflictWith?: string };

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

  const startMs = Date.parse(slotStartUtc);
  if (Number.isNaN(startMs)) {
    return { ok: false, error: "server_error" };
  }

  const { data: staffRow, error: staffErr } = await supabase
    .from("staff")
    .select("id")
    .eq("id", newStaffId)
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (staffErr || !(staffRow as any)?.id) {
    return { ok: false, error: "server_error" };
  }

  const { data: booking, error: bkErr } = await supabase
    .from("bookings")
    .select(
      "id, salon_id, status, staff_id, start_time_utc, end_time_utc, addon_service_id",
    )
    .eq("id", bookingId)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (bkErr) {
    console.error("[performEditBooking] booking", bkErr);
    return { ok: false, error: "server_error" };
  }

  if (!(booking as any)?.id) {
    return { ok: false, error: "not_found" };
  }

  const bookingData = booking as any;
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
  if (startMs !== Date.parse(st) && startMs < Date.now() - PAST_GRACE_MS) {
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
  const svcData = svc as any;
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
    if (!(capRow as any)?.staff_id) {
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
    const addonSvcData = addonSvc as any;
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
    addonSpanMin = serviceBlockMinutes(aDur, aBuf);
    const aPrice =
      addonSvcData.price_cents != null
        ? Math.round(Number(addonSvcData.price_cents))
        : null;
    addonPriceCents = Number.isFinite(aPrice ?? NaN) ? aPrice : null;
  }

  const totalMin = serviceBlockMinutes(duration, buffer) + addonSpanMin;
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

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
    existingBookings: (existing ?? []) as any as ConflictCheckBooking[],
    excludeBookingId: bookingId,
  });
  if (conflict !== null) {
    const name =
      conflict.client_name != null && String(conflict.client_name).trim() !== ""
        ? String(conflict.client_name).trim()
        : "";
    Sentry.captureEvent({
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

  const { data: updated, error: upErr } = await supabase
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
      Sentry.captureEvent({
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
    Sentry.captureException(upErr, {
      tags: {
        "nailiq.event": "booking_action_error",
        "nailiq.surface": "edit_booking",
      },
      extra: { salonId, bookingId, where: "update" },
    });
    return { ok: false, error: "server_error" };
  }

  if (!(updated as any)?.id) {
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
      newServiceId,
      newStartTimeUtc: slotStartUtc,
      newEndTimeUtc: slotEndUtc,
      addonChanged: input.newAddonServiceId !== undefined,
      newAddonServiceId: effectiveAddonId,
    },
  });

  // Only when the start time actually moved (a pure staff/service swap isn't a
  // reschedule) do we fire reschedule notifications. Opt-in, fire-and-forget.
  if (slotStartUtc && slotStartUtc !== st) {
    // Owner/admin "rescheduled" alert.
    after(() =>
      sendOwnerBookingNotification({
        salonId,
        bookingId,
        event: "reschedule",
        previousStartUtc: st || null,
      }),
    );

    // Customer reschedule notification → the durable queue (same path as
    // cancel): a 1-min cron delivers it via deliverStaffActionNotification, in
    // the resolved language, on the chosen channels. Legacy callers (no
    // `notify`) keep the SMS-only behavior. Service-role insert — the
    // scheduled_notifications table is RLS-locked to service-role.
    const notifySms = input.notify ? input.notify.sms === true : true;
    const notifyEmail = input.notify ? input.notify.email === true : false;
    if (notifySms || notifyEmail) {
      const sr = createServiceRoleClient();
      const { error: enqErr } = await sr
        .from("scheduled_notifications")
        .insert({
          salon_id: salonId,
          booking_id: bookingId,
          event: "reschedule",
          channels: { sms: notifySms, email: notifyEmail },
          send_after: new Date(Date.now() + 5_000).toISOString(),
        } as never);
      if (enqErr)
        console.error(
          "[performEditBooking] enqueue reschedule notify failed",
          enqErr,
        );
    }
  }

  return {
    ok: true,
    updated: mapDashboardBookingRow(row as unknown as BookingRowDb),
  };
}
