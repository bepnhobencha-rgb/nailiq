"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  type EditBookingInput,
  type EditBookingResult,
  performEditBooking,
} from "@/shared/dashboard/editBookingCore";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAFF_NOTE_MAX_LEN = 200;
const CLIENT_NOTES_MAX_LEN = 2000;

function isUuidLike(value: string): boolean {
  return UUID_RE.test(value.trim());
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

type OkBooking = { ok: true; bookingId: string };

/**
 * Receptionist mutations: demo cookie (`nailiq-demo-slug` + service role) vs
 * logged-in salon member (user JWT + RLS), via `getDashboardWriteClient`.
 */
export async function addWalkinToQueue(
  slug: string,
  input: {
    salonId: string;
    clientName: string;
    clientPhone?: string | null;
    serviceId: string;
    staffRequestNote?: string | null;
  },
): Promise<OkBooking | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const clientName = String(input.clientName ?? "").trim();
  if (!clientName) return fail("invalid_name");
  if (clientName.length > BOOKING_GUEST_NAME_MAX) return fail("invalid_name");
  if (!isValidCustomerName(clientName)) return fail("invalid_name_chars");

  const serviceId = String(input.serviceId ?? "").trim();
  if (!serviceId || !isUuidLike(serviceId)) return fail("invalid_service");

  const phoneRaw = String(input.clientPhone ?? "").trim();
  if (!phoneRaw) return fail("invalid_phone");

  const phoneOk = validateGuestPhone(phoneRaw);
  if (!phoneOk.ok) return fail("invalid_phone");

  const clientPhoneClean: string | null = phoneOk.digits;

  let note: string | null = null;
  if (
    input.staffRequestNote !== undefined &&
    input.staffRequestNote !== null &&
    String(input.staffRequestNote).trim() !== ""
  ) {
    const t = String(input.staffRequestNote).trim();
    if (t.length > STAFF_NOTE_MAX_LEN) return fail("note_too_long");
    note = t;
  }

  const supabase = ctx.supabase;

  const { data: svc, error: svcErr } = await supabase
    .from("services")
    .select("id, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();

  if (svcErr) {
    console.error("[addWalkinToQueue] service", svcErr);
    return fail("server_error");
  }
  if (!svc?.id) return fail("service_not_found");

  const joinedAt = new Date().toISOString();
  const price =
    svc.price_cents != null ? Math.round(Number(svc.price_cents)) : null;

  const { data: inserted, error: insErr } = await supabase
    .from("bookings")
    .insert({
      salon_id: ctx.salon.id,
      service_id: serviceId,
      client_name: clientName,
      client_phone: clientPhoneClean,
      client_notes: null,
      staff_id: null,
      start_time_utc: null,
      end_time_utc: null,
      status: "waiting",
      source: "walkin",
      joined_queue_at: joinedAt,
      staff_request_note: note,
      price_cents: Number.isFinite(price ?? NaN) ? price : null,
    })
    .select("id")
    .maybeSingle();

  if (insErr) {
    console.error("[addWalkinToQueue] insert", insErr);
    return fail("server_error");
  }
  const bid = inserted && "id" in inserted ? String(inserted.id) : "";
  if (!bid) return fail("server_error");

  return { ok: true, bookingId: bid };
}

export async function assignWalkinToSlot(
  slug: string,
  input: {
    salonId: string;
    bookingId: string;
    staffId: string;
    slotStartUtc: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  const staffId = String(input.staffId ?? "").trim();
  const slotStartUtc = String(input.slotStartUtc ?? "").trim();

  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");
  if (!staffId || !isUuidLike(staffId)) return fail("invalid_staff");
  const startMs = Date.parse(slotStartUtc);
  if (Number.isNaN(startMs)) return fail("invalid_time");

  const supabase = ctx.supabase;

  const { data: staffRow } = await supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();

  if (!staffRow?.id) return fail("staff_not_found");

  const { data: booking, error: bkErr } = await supabase
    .from("bookings")
    .select(`
      id,
      salon_id,
      status,
      source,
      service_id,
      services!bookings_service_id_fkey ( duration_minutes, buffer_minutes )
    `)
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();

  if (bkErr) {
    console.error("[assignWalkinToSlot] booking", bkErr);
    return fail("server_error");
  }
  if (
    !booking?.id ||
    String(booking.source) !== "walkin" ||
    String(booking.status) !== "waiting"
  ) {
    return fail("invalid_state");
  }

  type SvcDur = {
    duration_minutes?: unknown;
    buffer_minutes?: unknown;
  };
  const join = booking.services as SvcDur | SvcDur[] | null | undefined;
  const serviceRow = Array.isArray(join) ? join[0] : join;
  const duration = Math.round(
    Number(serviceRow?.duration_minutes ?? 0),
  );
  const buffer = Math.round(Number(serviceRow?.buffer_minutes ?? 0));
  if (!Number.isFinite(duration) || duration < 1) {
    return fail("invalid_duration");
  }
  if (!Number.isFinite(buffer) || buffer < 0) return fail("invalid_buffer");

  const totalMin = duration + buffer;
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

  const { data: existing, error: exErr } = await supabase
    .from("bookings")
    .select(
      "id, staff_id, start_time_utc, end_time_utc, status, client_name",
    )
    .eq("salon_id", ctx.salon.id)
    .eq("staff_id", staffId)
    .in("status", ["pending", "confirmed", "in_progress", "completed"]);

  if (exErr) {
    console.error("[assignWalkinToSlot] overlap load", exErr);
    return fail("server_error");
  }

  const conflict = checkBookingConflict({
    staffId,
    startUtcIso: slotStartUtc,
    endUtcIso: slotEndUtc,
    existingBookings: (existing ?? []) as ConflictCheckBooking[],
  });
  if (conflict !== null) {
    return fail("slot_conflict");
  }

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      staff_id: staffId,
      start_time_utc: slotStartUtc,
      end_time_utc: slotEndUtc,
      status: "confirmed",
    })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[assignWalkinToSlot] update", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("lost_race");
  }

  return { ok: true };
}

/** Remove walk-in from queue by marking cancelled (waiting only). */
export async function cancelWaitingWalkin(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[cancelWaitingWalkin]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("invalid_state");
  }

  return { ok: true };
}

/**
 * Undo assign: confirmed walk-in → back to queue (waiting, no slot).
 * Fails when no row matched (already in progress / still waiting / not walk-in).
 */
export async function undoWalkinAssignment(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      status: "waiting",
      staff_id: null,
      start_time_utc: null,
      end_time_utc: null,
    })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "confirmed")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[undoWalkinAssignment]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("already_started");
  }

  return { ok: true };
}

/**
 * Chair flow: confirmed walk-in with a slot → in_progress (+ started_at).
 * Receptionist drawer may instead call `updateBookingStatus` (`confirmed`/`pending` → `in_progress`); kept for callers that require `source = walkin` guard.
 */
export async function markWalkinInProgress(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;
  const startedAt = new Date().toISOString();

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      status: "in_progress",
      started_at: startedAt,
    })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "confirmed")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[markWalkinInProgress]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("invalid_state");
  }

  return { ok: true };
}

/** Grid / desk: pending | confirmed | in_progress → cancelled (atomic `status` guard). */
export async function cancelDeskBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .in("status", ["pending", "confirmed", "in_progress"])
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[cancelDeskBooking]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("invalid_state");
  }

  return { ok: true };
}

export type {
  EditBookingError,
  EditBookingInput,
  EditBookingResult,
} from "./editBookingCore";

/** Desk / grid: reschedule/adjust slots for pending | confirmed only (see `performEditBooking`). */
export async function editBooking(
  slug: string,
  input: EditBookingInput,
): Promise<EditBookingResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    return { ok: false, error: "server_error" };
  }
  return performEditBooking(
    ctx.supabase as SupabaseClient<Database>,
    ctx.salon.id,
    input,
  );
}
