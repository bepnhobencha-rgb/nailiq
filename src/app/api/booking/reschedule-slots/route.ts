import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { salonWallTimeToUtcIso, salonYmdOfUtc } from "@/shared/lib/salonTime";
import { inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

type QueryParams = {
  token?: string;
  date?: string; // YYYY-MM-DD, optional — omit to resolve salon-local "today" only
};

/**
 * Returns available time slots for a booking (identified by reminder token) on a given date.
 * `date` may be omitted: the page uses this to resolve the salon's own "today"
 * (and timezone) before it has any date selected, instead of trusting the
 * customer's device clock/timezone for the initial date-picker default.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params: QueryParams = {
    token: url.searchParams.get("token") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
  };

  if (!params.token) {
    return json({ error: "missing_params" }, 400);
  }

  let dateYmd: string | null = null;
  if (params.date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.date);
    if (!m) return json({ error: "invalid_date_format" }, 400);
    dateYmd = params.date;
  }

  const supabase = createServiceRoleClient();

  const rate = await consumeBookingManagementRateLimit({
    request: req,
    tokenId: params.token,
    action: "reschedule",
    phase: "inspect",
  });
  if (rate !== "allowed") {
    return json({ error: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  }
  const inspected = await inspectBookingManagementCapability({
    tokenId: params.token,
    expectedAction: "reschedule",
  });
  if (!inspected.ok) return json({ error: inspected.code }, inspected.code === "management_unavailable" ? 503 : 404);
  const context = inspected.inspection.context;

  // Load salon + active staff. Service duration/tenant/staff IDs come from the
  // capability's service-only authoritative context and are never returned.
  const [salonResult, staffResult] = await Promise.all([
    supabase.from("salons" as never).select("timezone, opening_hours, booking_closed_dates").eq("id", context.salonId).maybeSingle(),
    supabase.from("staff" as never).select("id, name, job_role").eq("salon_id", context.salonId).eq("status" as never, "active").is("deleted_at" as never, null),
  ]);
  if (salonResult.error || staffResult.error) {
    return json({ error: "management_unavailable" }, 503);
  }

  const salonRow = salonResult.data as { timezone?: string; opening_hours: unknown; booking_closed_dates?: unknown } | null;
  if (!salonRow) {
    return json({ error: "salon_not_found" }, 404);
  }

  const allStaff = ((staffResult.data ?? []) as { id: string; name: string; job_role?: string | null }[]).map((r) => ({
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

  // No date requested yet — the reschedule page uses this to resolve the
  // salon's own "today" before it has picked a date, instead of trusting the
  // customer's device clock/timezone.
  if (!dateYmd) {
    return json({
      timezone,
      todayYmd: salonYmdOfUtc(new Date().toISOString(), timezone),
      slots: [],
    });
  }

  const [dy, dm, dd] = dateYmd.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(dy, dm - 1, dd));
  if (calendarDate.toISOString().slice(0, 10) !== dateYmd) {
    return json({ error: "invalid_date_format" }, 400);
  }
  const salonMidnightUtcMs = Date.parse(salonWallTimeToUtcIso(dateYmd, 0, timezone));
  const utcMidnightMs = Date.UTC(dy, dm - 1, dd);
  const tzOffsetMs = salonMidnightUtcMs - utcMidnightMs;

  // Occupancy query: cover exact salon midnights; UTC duration may be 23/25 h on DST days.
  const dayStart = new Date(salonMidnightUtcMs);
  const nextDateYmd = new Date(Date.UTC(dy, dm - 1, dd + 1)).toISOString().slice(0, 10);
  const dayEnd = new Date(Date.parse(salonWallTimeToUtcIso(nextDateYmd, 0, timezone)) - 1);

  const { data: occData, error: occupancyError } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: context.salonId,
    p_start:    dayStart.toISOString(),
    p_end:      dayEnd.toISOString(),
  });
  if (occupancyError) return json({ error: "management_unavailable" }, 503);

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
    staffId:                context.staffId ?? BOOKING_ANY_STAFF_ID,
    staffList:              allStaff,
    serviceDurationMinutes: context.durationMinutes,
    occupancy:              adjustedOccupancy,
    nowMs:                  Date.now() - tzOffsetMs,
    closedDateYmdSet:       parseBookingClosedDateSet(salonRow.booking_closed_dates),
  });

  const slotOptions = slots.flatMap((slot) => {
    if (!slot.available) return [];
    try {
      const startUtc = salonWallTimeToUtcIso(
        dateYmd!,
        parseTimeSlotToMinutes(slot.label),
        timezone,
      );
      return [{
        label: slot.label,
        startUtc,
        endUtc: new Date(Date.parse(startUtc) + context.durationMinutes * 60_000).toISOString(),
      }];
    } catch {
      // Fake-UTC slot layout can name a spring-forward minute that is absent
      // in the salon zone. Omit it rather than returning a shifted instant or
      // failing the entire day's availability response.
      return [];
    }
  });
  return json({ slots: slotOptions.map((slot) => slot.label), slotOptions });
}
