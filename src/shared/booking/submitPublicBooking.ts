import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
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
};

export type BookingResult = {
  bookingId: string;
  serviceName: string;
  startTimeUtc: string;
  status: "pending";
  price_cents: number;
  staffName: string;
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

/**
 * Parses booking UI labels like "9:00 AM" into a Date on the given YYYY-MM-DD (local).
 */
function parseTimeSlotOnDate(timeSlot: string, dateYmd: string): Date {
  const trimmed = timeSlot.trim();
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(trimmed);
  if (!match) {
    throw new Error("invalid_time_slot");
  }
  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) {
    hour += 12;
  } else if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const parsed = new Date(`${dateYmd}T${hh}:${mm}:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("invalid_time_slot");
  }
  return parsed;
}

type OccRow = {
  staff_id: string;
  start_time_utc: string;
  end_time_utc: string;
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
  } = params;

  const supabase = createClient();

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salon) throw new Error("salon_not_found");

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
  const bufferMs = 15 * 60 * 1000;
  if (startLocal.getTime() < now.getTime() + bufferMs) {
    throw new Error("cannot_book_past");
  }

  const durationMin =
    (Number(service.duration_minutes) || 0) +
    (Number(service.buffer_minutes) || 0);
  const endLocal = new Date(startLocal.getTime() + durationMin * 60_000);

  const priceSnapshot =
    service.price_cents != null ? Number(service.price_cents) : null;

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

  let occupancy: OccRow[] = [];
  if (!occErr && Array.isArray(occRaw)) {
    occupancy = occRaw as OccRow[];
  }

  const occIntervals = occupancy.map((row) => ({
    staffId: String(row.staff_id),
    startMs: new Date(row.start_time_utc).getTime(),
    endMs: new Date(row.end_time_utc).getTime(),
  }));

  const slotStartMs = startLocal.getTime();
  const slotEndMs = endLocal.getTime();

  function isStaffFree(staffUuid: string): boolean {
    for (const o of occIntervals) {
      if (o.staffId !== staffUuid) continue;
      if (intervalsOverlapMs(slotStartMs, slotEndMs, o.startMs, o.endMs)) {
        return false;
      }
    }
    return true;
  }

  let resolvedStaffId: string | null = null;
  let resolvedStaffName = "";

  if (requestedStaffId === BOOKING_ANY_STAFF_ID) {
    for (const row of orderedStaff) {
      const id = String(row.id);
      if (isStaffFree(id)) {
        resolvedStaffId = id;
        resolvedStaffName = String(row.name ?? "");
        break;
      }
    }
    if (!resolvedStaffId) throw new BookingConflictError();
  } else {
    const allowed = orderedStaff.some(
      (r) => String(r.id) === requestedStaffId,
    );
    if (!allowed) throw new Error("invalid_staff");

    if (!isStaffFree(requestedStaffId)) throw new BookingConflictError();

    resolvedStaffId = requestedStaffId;
    const chosen = orderedStaff.find((r) => String(r.id) === requestedStaffId);
    resolvedStaffName = String(chosen?.name ?? "");
  }

  const insertPayload = {
    salon_id: salon.id,
    service_id: service.id,
    staff_id: resolvedStaffId,
    client_name: clientName.trim(),
    client_phone: clientPhone.trim(),
    start_time_utc: startLocal.toISOString(),
    end_time_utc: endLocal.toISOString(),
    status: "pending" as const,
    price_cents: priceSnapshot,
  };

  /** Prefer RPC (SECURITY DEFINER); falls back to INSERT when RPC not deployed (PGRST202). */
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
      start_time_utc: insertPayload.start_time_utc,
      end_time_utc: insertPayload.end_time_utc,
      status: insertPayload.status,
      price_cents: insertPayload.price_cents,
    });

    if (insertErr) {
      if (insertErr.code === "23505") throw new BookingConflictError();
      if (insertErr.code === "23P01") throw new BookingConflictError();
      throw new Error(insertErr.message);
    }
  } else if (!bookingId) {
    if (rpcErr) {
      if (rpcErr.code === "23505") throw new BookingConflictError();
      if (rpcErr.code === "23P01") throw new BookingConflictError();
      throw new Error(rpcErr.message);
    }
    throw new Error("booking_rpc_empty");
  }

  return {
    bookingId,
    serviceName: service.name as string,
    startTimeUtc: startLocal.toISOString(),
    status: "pending",
    price_cents: priceSnapshot ?? 0,
    staffName: resolvedStaffName,
  };
}
