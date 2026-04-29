import { assertSlotWithinOpeningHours } from "@/shared/booking/assertSlotWithinOpeningHours";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { parseTimeSlotOnDate } from "@/shared/booking/parseBookingTimeSlot";
import { pickBestStaffAmongFree } from "@/shared/booking/pickBestStaffAmongFree";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { createClient } from "@/shared/lib/supabase/client";

export type BookingParams = {
  shopSlug: string;
  serviceId: string;
  /** Same localized labels produced by `getAvailableTimeSlots` (e.g. `"9:00 AM"`). */
  timeSlot: string;
  /** Local calendar day `YYYY-MM-DD` for the appointment (guest timezone). */
  bookingDateYmd: string;
  /** `"any"` or the salon staff UUID. */
  staffId: string;
  clientName: string;
  clientPhone: string;
  clientNotes?: string;
  /** Optional add-on booked into the same row (pre-confirm upsell with real float only). */
  addonServiceId?: string | null;
};

export type BookingResult = {
  bookingId: string;
  serviceName: string;
  startTimeUtc: string;
  endTimeUtc: string;
  status: "pending";
  price_cents: number;
  staffName: string;
  addonServiceName: string | null;
};

export class BookingConflictError extends Error {
  constructor() {
    super("time_slot_taken");
    this.name = "BookingConflictError";
  }
}

function localDateYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDayBoundsFromYmd(dateYmd: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
  const end = new Date(y, mo - 1, d, 23, 59, 59, 999);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end };
}

type OccInterval = {
  staffId: string;
  startMs: number;
  endMs: number;
};

export async function submitPublicBooking(
  params: BookingParams,
): Promise<BookingResult> {
  const {
    shopSlug,
    serviceId,
    timeSlot,
    bookingDateYmd,
    staffId: requestedStaffId,
    clientName,
    clientPhone,
    clientNotes = "",
    addonServiceId = null,
  } = params;

  const phoneOk = validateGuestPhone(clientPhone);
  if (!phoneOk.ok) {
    throw new Error("invalid_phone");
  }

  const supabase = createClient();

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("id, profile_complete, opening_hours, booking_closed_dates")
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salon) throw new Error("salon_not_found");
  if (!salon.profile_complete) throw new Error("salon_not_live");

  const closedYmdSet = parseBookingClosedDateSet(
    (salon as { booking_closed_dates?: unknown }).booking_closed_dates,
  );
  if (closedYmdSet.has(bookingDateYmd.trim())) {
    throw new Error("salon_closed_day");
  }

  const week = parseOpeningHours((salon as { opening_hours?: unknown }).opening_hours);
  if (!week) throw new Error("salon_hours_invalid");

  const { data: service, error: serviceErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();

  if (serviceErr || !service) throw new Error("service_not_found");

  const dayBounds = localDayBoundsFromYmd(bookingDateYmd);
  if (!dayBounds) throw new Error("invalid_booking_date");

  const todayYmd = localDateYmd(new Date());
  if (bookingDateYmd < todayYmd) {
    throw new Error("cannot_book_past");
  }

  let startLocal: Date;
  try {
    startLocal = parseTimeSlotOnDate(timeSlot, bookingDateYmd);
  } catch {
    throw new Error("invalid_time_slot");
  }

  const now = new Date();
  const leadBufferMs = 15 * 60 * 1000;
  if (startLocal.getTime() < now.getTime() + leadBufferMs) {
    throw new Error("cannot_book_past");
  }

  const mainBlockMin =
    (Number(service.duration_minutes) || 0) +
    (Number(service.buffer_minutes) || 0);

  let addonBlockMin = 0;
  let addonRow: {
    id: string;
    name: string;
    price_cents: number | null;
  } | null = null;

  if (addonServiceId) {
    if (String(addonServiceId) === String(service.id)) {
      throw new Error("invalid_addon");
    }
    const { data: addSvc, error: addErr } = await supabase
      .from("services")
      .select("id, name, duration_minutes, buffer_minutes, price_cents")
      .eq("id", addonServiceId)
      .eq("salon_id", salon.id)
      .maybeSingle();

    if (addErr || !addSvc) throw new Error("addon_not_found");
    addonBlockMin =
      (Number(addSvc.duration_minutes) || 0) +
      (Number(addSvc.buffer_minutes) || 0);
    if (addonBlockMin <= 0) throw new Error("invalid_addon");
    addonRow = {
      id: String(addSvc.id),
      name: String(addSvc.name ?? ""),
      price_cents:
        addSvc.price_cents != null ? Number(addSvc.price_cents) : null,
    };
  }

  const totalBlockMin = mainBlockMin + addonBlockMin;
  const endLocal = new Date(startLocal.getTime() + totalBlockMin * 60_000);

  try {
    const anchor = new Date(
      startLocal.getFullYear(),
      startLocal.getMonth(),
      startLocal.getDate(),
      12,
      0,
      0,
      0,
    );
    assertSlotWithinOpeningHours(week, anchor, startLocal, endLocal);
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === "salon_closed_day") throw new Error("salon_closed_day");
      if (e.message === "outside_opening_hours")
        throw new Error("outside_opening_hours");
    }
    throw new Error("outside_opening_hours");
  }

  const priceSnapshot =
    service.price_cents != null ? Number(service.price_cents) : null;
  const addonPriceSnapshot =
    addonRow?.price_cents != null ? addonRow.price_cents : null;

  const { data: staffRows, error: staffListErr } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", salon.id)
    .order("name", { ascending: true });

  if (staffListErr) throw new Error("staff_load_failed");
  const orderedStaff = staffRows ?? [];
  if (orderedStaff.length === 0) throw new Error("no_staff_available");

  const { data: occRaw, error: occErr } = await supabase.rpc(
    "public_booking_occupancy_for_range",
    {
      p_salon_id: salon.id,
      p_start: dayBounds.start.toISOString(),
      p_end: dayBounds.end.toISOString(),
    },
  );

  let occupancy: OccInterval[] = [];
  if (!occErr && Array.isArray(occRaw)) {
    occupancy = (occRaw as { staff_id: string; start_time_utc: string; end_time_utc: string }[]).map(
      (row) => ({
        staffId: String(row.staff_id),
        startMs: new Date(row.start_time_utc).getTime(),
        endMs: new Date(row.end_time_utc).getTime(),
      }),
    );
  }

  const slotStartMs = startLocal.getTime();
  const slotEndMs = endLocal.getTime();

  function isStaffFreeForRange(
    staffUuid: string,
    rangeStartMs: number,
    rangeEndMs: number,
  ): boolean {
    for (const o of occupancy) {
      if (o.staffId !== staffUuid) continue;
      if (intervalsOverlapMs(rangeStartMs, rangeEndMs, o.startMs, o.endMs)) {
        return false;
      }
    }
    return true;
  }

  let resolvedStaffId: string | null = null;
  let resolvedStaffName = "";

  const dayStartMs = dayBounds.start.getTime();
  const dayEndMs = dayBounds.end.getTime();

  if (requestedStaffId === BOOKING_ANY_STAFF_ID) {
    const freeIds = orderedStaff
      .map((r) => String(r.id))
      .filter((id) => isStaffFreeForRange(id, slotStartMs, slotEndMs));
    if (freeIds.length === 0) throw new BookingConflictError();
    resolvedStaffId = pickBestStaffAmongFree(
      freeIds,
      orderedStaff.map((r) => ({ id: String(r.id), name: String(r.name ?? "") })),
      occupancy,
      dayStartMs,
      dayEndMs,
      slotStartMs,
    );
    const chosen = orderedStaff.find((r) => String(r.id) === resolvedStaffId);
    resolvedStaffName = String(chosen?.name ?? "");
  } else {
    const allowed = orderedStaff.some(
      (r) => String(r.id) === requestedStaffId,
    );
    if (!allowed) throw new Error("invalid_staff");

    if (!isStaffFreeForRange(requestedStaffId, slotStartMs, slotEndMs)) {
      throw new BookingConflictError();
    }

    resolvedStaffId = requestedStaffId;
    const chosen = orderedStaff.find((r) => String(r.id) === requestedStaffId);
    resolvedStaffName = String(chosen?.name ?? "");
  }

  const notesTrim = clientNotes.trim();
  const insertPayload = {
    salon_id: salon.id as string,
    service_id: service.id as string,
    staff_id: resolvedStaffId,
    client_name: clientName.trim(),
    client_phone: phoneOk.digits,
    client_notes: notesTrim.length > 0 ? notesTrim : null,
    start_time_utc: startLocal.toISOString(),
    end_time_utc: endLocal.toISOString(),
    status: "pending" as const,
    price_cents: priceSnapshot,
    addon_service_id: 
      addonRow ? addonRow.id : null,
    addon_price_cents: addonRow ? addonPriceSnapshot : null,
  };

  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    "create_public_booking",
    {
      p_salon_id: insertPayload.salon_id,
      p_service_id: insertPayload.service_id,
      p_staff_id: insertPayload.staff_id,
      p_client_name: insertPayload.client_name,
      p_client_phone: insertPayload.client_phone,
      p_start_time_utc: insertPayload.start_time_utc,
      p_end_time_utc: insertPayload.end_time_utc,
      p_status: insertPayload.status,
      p_price_cents: insertPayload.price_cents,
      p_client_notes: insertPayload.client_notes,
      p_addon_service_id: insertPayload.addon_service_id,
      p_addon_price_cents: insertPayload.addon_price_cents,
    },
  );

  let bookingId = "";

  if (!rpcErr && rpcRows != null) {
    const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    if (row && typeof row === "object" && "id" in row && row.id) {
      bookingId = String(row.id);
    }
  }

  const rpcMissing =
    rpcErr &&
    (rpcErr.code === "PGRST202" ||
      String(rpcErr.message ?? "").includes("Could not find the function"));

  if (!bookingId && rpcMissing) {
    bookingId = crypto.randomUUID();
    const { error: insertErr } = await supabase.from("bookings").insert({
      id: bookingId,
      salon_id: insertPayload.salon_id,
      service_id: insertPayload.service_id,
      staff_id: insertPayload.staff_id,
      client_name: insertPayload.client_name,
      client_phone: insertPayload.client_phone,
      client_notes: insertPayload.client_notes,
      start_time_utc: insertPayload.start_time_utc,
      end_time_utc: insertPayload.end_time_utc,
      status: insertPayload.status,
      price_cents: insertPayload.price_cents,
      addon_service_id: insertPayload.addon_service_id,
      addon_price_cents: insertPayload.addon_price_cents,
    });

    if (insertErr) {
      if (insertErr.code === "23505") throw new BookingConflictError();
      // exclusion_violation / overlap (btree_gist EXCLUDE)
      if (insertErr.code === "23P01") throw new BookingConflictError();
      throw new Error(insertErr.message);
    }
  } else if (!bookingId) {
    if (rpcErr) {
      if (rpcErr.code === "23505") throw new BookingConflictError();
      if (rpcErr.code === "23P01") throw new BookingConflictError(); // overlap / exclusion
      if (rpcErr.message?.includes("invalid_addon_service")) {
        throw new Error("invalid_addon");
      }
      throw new Error(rpcErr.message);
    }
    throw new Error("booking_rpc_empty");
  }

  const totalPriceCents =
    (priceSnapshot ?? 0) + (addonPriceSnapshot ?? 0);

  // TODO Phase 2 WOW:
  // - Check client_profiles when guest enters phone
  // - Auto-fill name if already known
  // - Suggest preferred_staff_id (favorite tech)
  // - Show "Welcome back [name]!"
  try {
    const { data: existingProfile } = await supabase
      .from("client_profiles")
      .select("visit_count")
      .eq("phone", phoneOk.digits)
      .maybeSingle();

    const nextVisits = (existingProfile?.visit_count ?? 0) + 1;

    const { error: profileUpsertErr } = await supabase
      .from("client_profiles")
      .upsert(
        {
          phone: phoneOk.digits,
          name: clientName.trim(),
          preferred_staff_id: resolvedStaffId,
          last_service_date: new Date().toISOString(),
          visit_count: nextVisits,
        },
        { onConflict: "phone" },
      );

    if (profileUpsertErr) {
      console.warn("client_profiles upsert:", profileUpsertErr.message);
    }
  } catch {
    /* booking succeeded; profile update is best-effort */
  }

  return {
    bookingId,
    serviceName: service.name as string,
    startTimeUtc: startLocal.toISOString(),
    endTimeUtc: endLocal.toISOString(),
    status: "pending",
    price_cents: totalPriceCents,
    staffName: resolvedStaffName,
    addonServiceName: addonRow?.name ?? null,
  };
}
