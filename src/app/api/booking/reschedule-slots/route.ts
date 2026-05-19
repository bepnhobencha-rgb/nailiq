import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getAvailableTimeSlots } from "@/shared/booking/getAvailableTimeSlots";

type QueryParams = {
  token?: string;
  date?: string; // YYYY-MM-DD
};

/** Returns available time slots for a booking (identified by reminder token) on a given date. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params: QueryParams = {
    token: url.searchParams.get("token") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
  };

  if (!params.token || !params.date) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Resolve booking from token
  const { data: tokenRow } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("booking_id, used_at, expires_at")
    .eq("id", params.token)
    .maybeSingle();

  const tr = tokenRow as { booking_id: string; used_at: string | null; expires_at: string } | null;
  if (!tr || tr.used_at !== null || new Date(tr.expires_at) < new Date()) {
    return NextResponse.json({ error: "token_invalid" }, { status: 400 });
  }

  // Load booking details
  const { data: booking } = await supabase
    .from("bookings" as never)
    .select("salon_id, service_id, staff_id, start_time_utc")
    .eq("id", tr.booking_id)
    .in("status", ["pending", "confirmed"])
    .maybeSingle();

  const b = booking as {
    salon_id: string; service_id: string; staff_id: string | null; start_time_utc: string;
  } | null;
  if (!b) return NextResponse.json({ error: "booking_not_found" }, { status: 404 });

  // Load salon + service data
  const [{ data: salon }, { data: service }, { data: staffRows }] = await Promise.all([
    supabase.from("salons" as never).select("opening_hours, booking_closed_dates").eq("id", b.salon_id).maybeSingle(),
    supabase.from("services" as never).select("duration_minutes").eq("id", b.service_id).maybeSingle(),
    supabase.from("staff" as never).select("id, name").eq("salon_id", b.salon_id).is("deleted_at" as never, null),
  ]);

  const salonRow = salon as { opening_hours: unknown; booking_closed_dates?: unknown } | null;
  const serviceRow = service as { duration_minutes: number } | null;
  if (!salonRow || !serviceRow) {
    return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
  }

  const allStaff = ((staffRows ?? []) as { id: string; name: string; job_role?: string | null }[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    job_role: String(r.job_role ?? ""),
  }));

  const selectedDate = new Date(params.date + "T12:00:00");

  const slots = await getAvailableTimeSlots({
    salonId: b.salon_id,
    openingHoursRaw: salonRow.opening_hours,
    selectedDate,
    staffId: b.staff_id ?? "any",
    staffList: allStaff,
    serviceDurationMinutes: Number(serviceRow.duration_minutes),
    closedDateYmdSet: new Set<string>(),
  });

  return NextResponse.json({
    slots: slots.filter((s) => s.available).map((s) => s.label),
  });
}
