import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { SalonDashboardBooking } from "@/shared/types";
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

/** Q1 desk edit payload: time + staff + service only. */
export type EditBookingInput = {
  salonId: string;
  bookingId: string;
  newStartTimeUtc: string;
  newStaffId: string;
  newServiceId: string;
};

export type EditBookingError =
  | "not_found"
  | "invalid_status"
  | "slot_conflict"
  | "staff_cannot_perform_service"
  | "server_error"
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
 */
export async function performEditBooking(
  supabase: SupabaseClient<Database>,
  authorizedSalonId: string,
  input: EditBookingInput,
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

  const { data: staffRow } = await supabase
    .from("staff")
    .select("id")
    .eq("id", newStaffId)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (!staffRow?.id) {
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

  if (!booking?.id) {
    return { ok: false, error: "not_found" };
  }

  const st =
    booking.start_time_utc != null ? String(booking.start_time_utc).trim() : "";
  const en =
    booking.end_time_utc != null ? String(booking.end_time_utc).trim() : "";
  if (!st || !en) {
    return { ok: false, error: "server_error" };
  }

  const status = String(booking.status);
  if (status !== "pending" && status !== "confirmed") {
    return { ok: false, error: "invalid_status" };
  }

  const { data: svc, error: svcErr } = await supabase
    .from("services")
    .select("id, duration_minutes, buffer_minutes, price_cents")
    .eq("id", newServiceId)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (svcErr) {
    console.error("[performEditBooking] service", svcErr);
    return { ok: false, error: "server_error" };
  }
  if (!svc?.id) {
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
    if (!capRow?.staff_id) {
      return { ok: false, error: "staff_cannot_perform_service" };
    }
  }

  const duration = Math.round(Number(svc.duration_minutes ?? 0));
  const buffer = Math.round(Number(svc.buffer_minutes ?? 0));
  if (!Number.isFinite(duration) || duration < 1) {
    return { ok: false, error: "server_error" };
  }
  if (!Number.isFinite(buffer) || buffer < 0) {
    return { ok: false, error: "server_error" };
  }

  /* Existing addon contributes to span; preserved verbatim (not editable in v1).
     Without this, end_time_utc would truncate the addon block on every save —
     timeline would mis-render and overlap checks would under-protect the addon. */
  let addonSpanMin = 0;
  const existingAddonId =
    booking.addon_service_id != null
      ? String(booking.addon_service_id).trim()
      : "";
  if (existingAddonId) {
    const { data: addonSvc, error: addonErr } = await supabase
      .from("services")
      .select("duration_minutes, buffer_minutes")
      .eq("id", existingAddonId)
      .eq("salon_id", salonId)
      .maybeSingle();
    if (addonErr) {
      console.error("[performEditBooking] addon service", addonErr);
      return { ok: false, error: "server_error" };
    }
    if (!addonSvc) {
      return { ok: false, error: "server_error" };
    }
    const aDur = Math.round(Number(addonSvc.duration_minutes ?? 0));
    const aBuf = Math.round(Number(addonSvc.buffer_minutes ?? 0));
    if (!Number.isFinite(aDur) || aDur < 1) {
      return { ok: false, error: "server_error" };
    }
    if (!Number.isFinite(aBuf) || aBuf < 0) {
      return { ok: false, error: "server_error" };
    }
    addonSpanMin = aDur + aBuf;
  }

  const totalMin = duration + buffer + addonSpanMin;
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

  const price = svc.price_cents != null ? Math.round(Number(svc.price_cents)) : null;
  const priceCents = Number.isFinite(price ?? NaN) ? price : null;

  const { data: existing, error: exErr } = await supabase
    .from("bookings")
    .select(
      "id, staff_id, start_time_utc, end_time_utc, status, client_name",
    )
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
    existingBookings: (existing ?? []) as ConflictCheckBooking[],
    excludeBookingId: bookingId,
  });
  if (conflict !== null) {
    const name =
      conflict.client_name != null && String(conflict.client_name).trim() !== ""
        ? String(conflict.client_name).trim()
        : "";
    return {
      ok: false,
      error: "slot_conflict",
      conflictWith: name,
    };
  }

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      staff_id: newStaffId,
      start_time_utc: slotStartUtc,
      end_time_utc: slotEndUtc,
      service_id: newServiceId,
      price_cents: priceCents,
    })
    .eq("id", bookingId)
    .eq("salon_id", salonId)
    .in("status", ["pending", "confirmed"])
    .select("id")
    .maybeSingle();

  if (upErr) {
    // 23P01 = exclusion_violation (bookings_no_overlap GiST EXCLUDE).
    if (upErr.code === "23P01") {
      return { ok: false, error: "slot_conflict" };
    }
    console.error("[performEditBooking] update", upErr);
    return { ok: false, error: "server_error" };
  }

  if (!updated?.id) {
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

  return {
    ok: true,
    updated: mapDashboardBookingRow(row as BookingRowDb),
  };
}
