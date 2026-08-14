import { NextResponse } from "next/server";

import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { minutesToLabel } from "@/shared/booking/getAvailableTimeSlots";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import {
  buildCapabilityMap,
  isStaffCapableForService,
} from "@/shared/booking/staffCapability";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  salonDayRangeUtc,
  salonToday,
  salonTimezoneAbbreviation,
  salonWallTimeToUtcCandidates,
  salonYmdOfUtc,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";

type QueryParams = {
  token?: string;
  date?: string;
};

type BookingRow = {
  salon_id: string;
  service_id: string;
  staff_id: string | null;
  start_time_utc: string;
  end_time_utc: string;
};

type OccupancyRow = {
  staff_id: string | null;
  resource_id: string | null;
  status: string;
  start_time_utc: string;
  end_time_utc: string;
};

type RescheduleSlotOption = {
  label: string;
  displayLabel: string;
  startUtc: string;
};

const MS_PER_MINUTE = 60_000;

function addUtcDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Read-only availability preview for customer rescheduling.
 *
 * This endpoint deliberately mirrors the authoritative RPC's policy inputs.
 * The final write still re-locks the booking and re-checks every constraint,
 * so a stale preview can only become a typed conflict, never an overbooking.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params: QueryParams = {
    token: url.searchParams.get("token") ?? undefined,
    date: url.searchParams.get("date") ?? undefined,
  };

  if (!params.token || !params.date) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  const dateYmd = params.date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return NextResponse.json({ error: "invalid_date_format" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: tokenData, error: tokenErr } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("booking_id, salon_id, used_at, expires_at")
    .eq("id", params.token)
    .maybeSingle();
  if (tokenErr) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const token = tokenData as {
    booking_id: string;
    salon_id: string;
    used_at: string | null;
    expires_at: string;
  } | null;
  if (
    !token ||
    token.used_at !== null ||
    !Number.isFinite(Date.parse(token.expires_at)) ||
    Date.parse(token.expires_at) <= Date.now()
  ) {
    return NextResponse.json({ error: "token_invalid" }, { status: 410 });
  }

  const { data: bookingData, error: bookingErr } = await supabase
    .from("bookings" as never)
    .select("salon_id, service_id, staff_id, start_time_utc, end_time_utc")
    .eq("id", token.booking_id)
    .eq("salon_id", token.salon_id)
    .in("status", ["pending", "confirmed"])
    .is("deleted_at", null)
    .maybeSingle();
  if (bookingErr) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const booking = bookingData as BookingRow | null;
  if (!booking) {
    return NextResponse.json({ error: "booking_not_found" }, { status: 404 });
  }
  if (!booking.staff_id) {
    return NextResponse.json({ error: "staff_unavailable" }, { status: 409 });
  }

  const oldStartMs = Date.parse(booking.start_time_utc);
  const oldEndMs = Date.parse(booking.end_time_utc);
  const occupiedMs = oldEndMs - oldStartMs;
  const invalidOccupiedMs =
    !Number.isFinite(oldStartMs) ||
    !Number.isFinite(oldEndMs) ||
    occupiedMs <= 0;
  if (invalidOccupiedMs || oldStartMs <= Date.now()) {
    return NextResponse.json(
      {
        error:
          invalidOccupiedMs
            ? "booking_time_invalid"
            : "booking_not_reschedulable",
      },
      { status: 409 },
    );
  }

  const [salonRes, staffRes, addOnRes] = await Promise.all([
    supabase
      .from("salons" as never)
      .select(
        "timezone, opening_hours, booking_closed_dates, booking_lead_minutes, resources_enabled, staff_capability_mode",
      )
      .eq("id", booking.salon_id)
      .maybeSingle(),
    supabase
      .from("staff" as never)
      .select("id")
      .eq("id", booking.staff_id)
      .eq("salon_id", booking.salon_id)
      .eq("status" as never, "active")
      .is("deleted_at" as never, null)
      .maybeSingle(),
    supabase
      .from("booking_addons" as never)
      .select("service_id")
      .eq("booking_id", token.booking_id),
  ]);
  if (salonRes.error || staffRes.error || addOnRes.error) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  const salon = salonRes.data as {
    timezone?: string | null;
    opening_hours: unknown;
    booking_closed_dates?: unknown;
    booking_lead_minutes?: number | null;
    resources_enabled?: boolean | null;
    staff_capability_mode?: "legacy_all" | "whitelist" | null;
  } | null;
  const staff = staffRes.data as { id: string } | null;
  if (!salon) {
    return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
  }
  if (!staff) {
    return NextResponse.json({ error: "staff_unavailable" }, { status: 409 });
  }

  const timezone = typeof salon.timezone === "string" ? salon.timezone.trim() : "";
  if (!timezone) {
    return NextResponse.json({ error: "timezone_not_set" }, { status: 409 });
  }
  const todayYmd = salonToday(timezone);
  if (dateYmd < todayYmd || dateYmd > addUtcDays(todayYmd, 365)) {
    return NextResponse.json({ slots: [] });
  }

  const requiredServiceIds = [
    booking.service_id,
    ...((addOnRes.data ?? []) as { service_id: string | null }[]).flatMap((row) =>
      row.service_id ? [String(row.service_id)] : [],
    ),
  ];
  const { data: capabilityData, error: capabilityErr } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .eq("staff_id", booking.staff_id)
    .in("service_id", requiredServiceIds);
  if (capabilityErr) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  const capability = buildCapabilityMap(
    ((capabilityData ?? []) as { staff_id: string; service_id: string }[]).map(
      (row) => ({ staff_id: String(row.staff_id), service_id: String(row.service_id) }),
    ),
    salon.staff_capability_mode,
  );
  if (
    requiredServiceIds.some(
      (serviceId) =>
        !isStaffCapableForService(capability, booking.staff_id as string, serviceId),
    )
  ) {
    return NextResponse.json({ error: "staff_incapable" }, { status: 409 });
  }

  const selectedDate = new Date(`${dateYmd}T12:00:00.000Z`);
  const dayKey = dayKeyFromLocalDate(selectedDate);
  const { startUtc, endUtc } = salonDayRangeUtc(dateYmd, timezone);
  const [occupancyRes, shiftRes, unavailableRes] = await Promise.all([
    supabase
      .from("bookings" as never)
      .select("staff_id, resource_id, status, start_time_utc, end_time_utc")
      .eq("salon_id", booking.salon_id)
      .neq("id", token.booking_id)
      // Mirror the database conflict boundary. `checked_in`/`in_service` are
      // UI concepts; persisted active states are `in_progress`/`waiting`.
      .in("status", [
        "pending",
        "confirmed",
        "in_progress",
        "waiting",
        // Staff is free after completion, but the resource exclusion
        // constraint intentionally holds a completed booking through its
        // scheduled end. Keep the row so the resource check below matches DB.
        "completed",
      ])
      .is("deleted_at", null)
      .lt("start_time_utc", endUtc)
      .gt("end_time_utc", startUtc),
    supabase
      .from("public_staff_shifts")
      .select("staff_id, start_time, end_time, break_start_time, break_end_time")
      .eq("salon_id", booking.salon_id)
      .eq("day_of_week", dayKey)
      .eq("is_active", true),
    supabase
      .from("public_staff_unavailability")
      .select("staff_id")
      .eq("salon_id", booking.salon_id)
      .eq("date", dateYmd),
  ]);
  if (occupancyRes.error || shiftRes.error || unavailableRes.error) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  const occupancy = (occupancyRes.data ?? []) as OccupancyRow[];
  const staffShiftWindows = new Map<
    string,
    {
      startMin: number;
      endMin: number;
      breakStartMin: number | null;
      breakEndMin: number | null;
    }
  >();
  for (const row of (shiftRes.data ?? []) as {
    staff_id: string;
    start_time: string;
    end_time: string;
    break_start_time: string | null;
    break_end_time: string | null;
  }[]) {
    staffShiftWindows.set(String(row.staff_id), {
      startMin: hmToMinutes(row.start_time),
      endMin: hmToMinutes(row.end_time),
      breakStartMin: row.break_start_time ? hmToMinutes(row.break_start_time) : null,
      breakEndMin: row.break_end_time ? hmToMinutes(row.break_end_time) : null,
    });
  }
  const unavailableIds = new Set(
    ((unavailableRes.data ?? []) as { staff_id: string }[]).map((row) =>
      String(row.staff_id),
    ),
  );

  let resourceIds: string[] | null = null;
  if (salon.resources_enabled) {
    const { data: resourceData, error: resourceErr } = await supabase
      .from("salon_resources" as never)
      .select("id")
      .eq("salon_id", booking.salon_id)
      .eq("status", "active")
      .is("deleted_at", null);
    if (resourceErr) {
      return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
    resourceIds = ((resourceData ?? []) as { id: string }[]).map((row) =>
      String(row.id),
    );
  }

  const openingWeek = parseOpeningHours(salon.opening_hours);
  const dayConfig = openingWeek?.[dayKey];
  const closedDates = parseBookingClosedDateSet(salon.booking_closed_dates);
  if (
    !dayConfig ||
    dayConfig.closed ||
    closedDates.has(dateYmd) ||
    unavailableIds.has(booking.staff_id) ||
    (resourceIds !== null && resourceIds.length === 0)
  ) {
    return NextResponse.json({ slots: [], slotOptions: [], timezone });
  }

  const openMin = hmToMinutes(dayConfig.open);
  const closeMin = hmToMinutes(dayConfig.close);
  if (closeMin <= openMin) {
    return NextResponse.json({ slots: [], slotOptions: [], timezone });
  }

  const shift = staffShiftWindows.get(booking.staff_id) ?? null;
  const minuteCandidates = new Set<number>();
  for (let minute = openMin; minute < closeMin; minute += 15) {
    minuteCandidates.add(minute);
  }
  // Keep the existing gap-filling behavior: an appointment ending off-grid
  // can still become the next exact start, including on a 23/25-hour day.
  for (const row of occupancy) {
    if (salonYmdOfUtc(row.end_time_utc, timezone) !== dateYmd) continue;
    const minute = Math.round(
      utcIsoToSalonMinutesFromMidnight(row.end_time_utc, timezone),
    );
    if (minute >= openMin && minute < closeMin) minuteCandidates.add(minute);
  }

  const nowMs = Date.now();
  const leadMinutes = Math.max(
    0,
    salon.booking_lead_minutes == null
      ? 15
      : Number(salon.booking_lead_minutes),
  );
  const horizonMs = nowMs + 365 * 24 * 60 * MS_PER_MINUTE;
  const wallCache = new Map<number, { ymd: string; minute: number }>();
  const wallAt = (instantMs: number) => {
    const normalizedMs = Math.floor(instantMs / MS_PER_MINUTE) * MS_PER_MINUTE;
    const cached = wallCache.get(normalizedMs);
    if (cached) return cached;
    const iso = new Date(normalizedMs).toISOString();
    const value = {
      ymd: salonYmdOfUtc(iso, timezone),
      minute: utcIsoToSalonMinutesFromMidnight(iso, timezone),
    };
    wallCache.set(normalizedMs, value);
    return value;
  };

  const blockFitsWallPolicy = (slotStartMs: number, slotEndMs: number) => {
    for (
      let instantMs = slotStartMs;
      instantMs < slotEndMs;
      instantMs += MS_PER_MINUTE
    ) {
      const wall = wallAt(instantMs);
      if (
        wall.ymd !== dateYmd ||
        wall.minute < openMin ||
        wall.minute >= closeMin
      ) {
        return false;
      }
      if (shift) {
        if (wall.minute < shift.startMin || wall.minute >= shift.endMin) {
          return false;
        }
        if (
          shift.breakStartMin != null &&
          shift.breakEndMin != null &&
          wall.minute >= shift.breakStartMin &&
          wall.minute < shift.breakEndMin
        ) {
          return false;
        }
      }
    }
    return true;
  };

  const options: RescheduleSlotOption[] = [];
  for (const minute of Array.from(minuteCandidates).sort((a, b) => a - b)) {
    const label = minutesToLabel(minute);
    const candidates = salonWallTimeToUtcCandidates(dateYmd, minute, timezone);
    for (const startUtc of candidates) {
      const slotStartMs = Date.parse(startUtc);
      const slotEndMs = slotStartMs + occupiedMs;
      if (
        slotStartMs < nowMs + leadMinutes * MS_PER_MINUTE ||
        slotStartMs > horizonMs ||
        !blockFitsWallPolicy(slotStartMs, slotEndMs)
      ) {
        continue;
      }
      if (
        occupancy.some(
          (row) =>
            row.status !== "completed" &&
            row.staff_id === booking.staff_id &&
            intervalsOverlapMs(
              slotStartMs,
              slotEndMs,
              Date.parse(row.start_time_utc),
              Date.parse(row.end_time_utc),
            ),
        )
      ) {
        continue;
      }
      if (
        resourceIds !== null &&
        !resourceIds.some((resourceId) =>
          occupancy.every(
            (row) =>
              row.resource_id !== resourceId ||
              !intervalsOverlapMs(
                slotStartMs,
                slotEndMs,
                Date.parse(row.start_time_utc),
                Date.parse(row.end_time_utc),
              ),
          ),
        )
      ) {
        continue;
      }

      const abbreviation = salonTimezoneAbbreviation(timezone, startUtc);
      options.push({
        label,
        displayLabel:
          candidates.length > 1 && abbreviation
            ? `${label} ${abbreviation}`
            : label,
        startUtc,
      });
    }
  }
  options.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));

  // Keep `slots` for old clients while the structured options carry the exact
  // UTC occurrence required to distinguish a repeated fall-back wall time.
  return NextResponse.json({
    slots: Array.from(new Set(options.map((slot) => slot.label))),
    slotOptions: options,
    timezone,
  });
}
