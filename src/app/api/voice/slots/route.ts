import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { salon_slug, service_id, date, staff_id } = (await req.json()) as {
    salon_slug: string;
    service_id: string;
    date: string; // YYYY-MM-DD
    staff_id?: string;
  };

  if (!salon_slug || !service_id || !date) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "invalid_date_format" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: salon } = await supabase
    .from("salons")
    .select("id, opening_hours, booking_closed_dates")
    .eq("slug", salon_slug)
    .maybeSingle();

  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const { data: service } = await supabase
    .from("services")
    .select("id, duration_minutes, buffer_minutes")
    .eq("id", service_id)
    .eq("salon_id", salon.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  // Load active staff capable of this service
  const { data: capRows } = await supabase
    .from("staff_services")
    .select("staff_id")
    .eq("service_id", service_id);

  const capableStaffIds = new Set((capRows ?? []).map((r) => String(r.staff_id)));

  const { data: staffRows } = await supabase
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", salon.id)
    .is("deleted_at", null)
    .eq("status", "active");

  const staffList = (staffRows ?? [])
    .filter((s) => capableStaffIds.size === 0 || capableStaffIds.has(String(s.id)))
    .map((s) => ({ id: String(s.id), name: String(s.name ?? ""), job_role: String(s.job_role ?? "") }));

  // Occupancy for the day
  const [year, month, day] = date.split("-").map(Number);
  const localDate = new Date(year!, month! - 1, day!, 12, 0, 0);
  const dayStart = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  const dayEnd = new Date(year!, month! - 1, day!, 23, 59, 59, 999);

  const { data: occData } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: salon.id,
    p_start: dayStart.toISOString(),
    p_end: dayEnd.toISOString(),
  });

  const occupancy = (Array.isArray(occData) ? occData : []) as {
    staff_id: string;
    start_time_utc: string;
    end_time_utc: string;
  }[];

  const resolvedStaffId =
    !staff_id || staff_id === "any" ? BOOKING_ANY_STAFF_ID : staff_id;

  const serviceDuration =
    (Number(service.duration_minutes) || 0) + (Number(service.buffer_minutes) || 0);

  const slots = computeTimeSlots({
    openingHoursRaw: salon.opening_hours,
    selectedDate: localDate,
    staffId: resolvedStaffId,
    staffList,
    serviceDurationMinutes: serviceDuration,
    occupancy,
    nowMs: Date.now(),
  });

  const available = slots.filter((s) => s.available).map((s) => s.label);
  const unavailable = slots.filter((s) => !s.available).map((s) => s.label);

  return NextResponse.json({
    date,
    available_slots: available,
    unavailable_slots: unavailable,
    total_available: available.length,
    message:
      available.length === 0
        ? "No availability on this date. Suggest another day."
        : `${available.length} slots available.`,
  });
}
