import { createClient } from "@/shared/lib/supabase/client";

export type BookingParams = {
  shopSlug: string;
  serviceId: string;
  timeSlot: string;
  clientName: string;
  clientPhone: string;
};

export type BookingResult = {
  bookingId: string;
  serviceName: string;
  startTimeUtc: string;
  status: "pending";
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

export async function submitPublicBooking(
  params: BookingParams,
): Promise<BookingResult> {
  const { shopSlug, serviceId, timeSlot, clientName, clientPhone } = params;
  const supabase = createClient();

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salon) throw new Error("salon_not_found");

  const { data: service, error: serviceErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();

  if (serviceErr || !service) throw new Error("service_not_found");

  const { data: staffMember, error: staffErr } = await supabase
    .from("staff")
    .select("id")
    .eq("salon_id", salon.id)
    .limit(1)
    .single();

  if (staffErr || !staffMember) throw new Error("no_staff_available");

  const dateYmd = localDateYmd(new Date());
  const startLocal = parseTimeSlotOnDate(timeSlot, dateYmd);
  const durationMin =
    (Number(service.duration_minutes) || 0) +
    (Number(service.buffer_minutes) || 0);
  const endLocal = new Date(startLocal.getTime() + durationMin * 60_000);

  const { data: booking, error: insertErr } = await supabase.rpc(
    "create_public_booking",
    {
      p_salon_id: salon.id,
      p_service_id: service.id,
      p_staff_id: staffMember.id,
      p_client_name: clientName,
      p_client_phone: clientPhone,
      p_start_time_utc: startLocal.toISOString(),
      p_end_time_utc: endLocal.toISOString(),
      p_status: "pending",
    },
  );

  if (insertErr) {
    if (insertErr.code === "23505") throw new BookingConflictError();
    throw new Error(insertErr.message);
  }

  const row = Array.isArray(booking) ? booking[0] : booking;
  if (!row?.id) throw new Error("booking_insert_failed");

  return {
    bookingId: row.id as string,
    serviceName: service.name,
    startTimeUtc: startLocal.toISOString(),
    status: "pending",
  };
}
