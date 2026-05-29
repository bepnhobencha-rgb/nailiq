import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";

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

  const dateYmd = params.date;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!m) return NextResponse.json({ error: "invalid_date_format" }, { status: 400 });

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

  // Load salon + service data (include timezone for correct slot computation)
  const [{ data: salon }, { data: service }, { data: staffRows }] = await Promise.all([
    supabase.from("salons" as never).select("timezone, opening_hours, booking_closed_dates").eq("id", b.salon_id).maybeSingle(),
    supabase.from("services" as never).select("duration_minutes").eq("id", b.service_id).maybeSingle(),
    supabase.from("staff" as never).select("id, name, job_role").eq("salon_id", b.salon_id).eq("status" as never, "active").is("deleted_at" as never, null),
  ]);

  const salonRow = salon as { timezone?: string; opening_hours: unknown; booking_closed_dates?: unknown } | null;
  const serviceRow = service as { duration_minutes: number } | null;
  if (!salonRow || !serviceRow) {
    return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
  }

  const allStaff = ((staffRows ?? []) as { id: string; name: string; job_role?: string | null }[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    job_role: String(r.job_role ?? ""),
  }));

  // ── Timezone-aware slot computation ─────────────────────────────────────────
  // This route runs server-side (Vercel = UTC). computeTimeSlots uses
  // setHours(0,0,0,0) = UTC midnight as base. For non-UTC salons (e.g. UTC-7),
  // all slot timestamps would be 7 h too early → past-time filter is wrong.
  //
  // Fix: same fake-UTC-frame technique as voice/tool/route.ts
  //   tzOffsetMs  = salonMidnightUtc − utcMidnight
  //   nowMs       = Date.now() − tzOffsetMs
  //   occupancy   = each timestamp shifted by −tzOffsetMs
  //
  // This aligns all comparisons inside computeTimeSlots to salon local time.
  // ────────────────────────────────────────────────────────────────────────────
  const timezone = salonRow.timezone ?? "America/Vancouver";

  const salonMidnightUtcMs = Date.parse(salonWallTimeToUtcIso(dateYmd, 0, timezone));
  const utcMidnightMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const tzOffsetMs = salonMidnightUtcMs - utcMidnightMs;

  // Occupancy query: cover the full salon local day (midnight → midnight+24 h)
  const dayStart = new Date(salonMidnightUtcMs);
  const dayEnd   = new Date(salonMidnightUtcMs + 24 * 60 * 60 * 1000 - 1);

  const { data: occData } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: b.salon_id,
    p_start:    dayStart.toISOString(),
    p_end:      dayEnd.toISOString(),
  });

  // Shift occupancy into fake-UTC frame
  type OccRow = { staff_id: string; start_time_utc: string; end_time_utc: string };
  const adjustedOccupancy: OccRow[] = (occData ?? []).map((row: OccRow) => ({
    staff_id:       row.staff_id,
    start_time_utc: new Date(Date.parse(row.start_time_utc) - tzOffsetMs).toISOString(),
    end_time_utc:   new Date(Date.parse(row.end_time_utc)   - tzOffsetMs).toISOString(),
  }));

  // selectedDate: noon UTC on the requested day → correct calendar day in UTC
  // (avoids DST boundary issues with T00:00:00)
  const selectedDate = new Date(dateYmd + "T12:00:00Z");

  const slots = computeTimeSlots({
    openingHoursRaw:        salonRow.opening_hours,
    selectedDate,
    staffId:                b.staff_id ?? BOOKING_ANY_STAFF_ID,
    staffList:              allStaff,
    serviceDurationMinutes: Number(serviceRow.duration_minutes),
    occupancy:              adjustedOccupancy,
    nowMs:                  Date.now() - tzOffsetMs,
    closedDateYmdSet:       new Set<string>(),
  });

  return NextResponse.json({
    slots: slots.filter((s) => s.available).map((s) => s.label),
  });
}
