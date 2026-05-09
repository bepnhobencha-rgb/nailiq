"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonDayRangeUtc, salonToday } from "@/shared/lib/salonTime";

export type ReportsDateRange = "today" | "week" | "month";

export type ReportsSnapshot = {
  totalRevenueCents: number;
  appointmentCount: number;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
  avgServiceDurationMinutes: number;
  topServices: Array<{
    name: string;
    count: number;
    revenueCents: number;
  }>;
  topStaff: Array<{
    name: string;
    appointmentCount: number;
    revenueCents: number;
  }>;
  /** Per-hour booking counts (0-23). Always exactly 24 entries. */
  busyHours: Array<{ hour: number; count: number }>;
};

export type LoadSalonReportsResult =
  | { ok: true; data: ReportsSnapshot }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

const TOP_LIMIT = 5;

/**
 * Owner-only salon analytics for today / this week / this month.
 *
 * Date ranges resolve in the salon timezone so "today" matches what the
 * desk sees. Week range is Mon-Sun containing today; month range is the
 * first → last day of the calendar month containing today.
 *
 * `revenueCents` excludes walk-in addons that lack a stored price (the
 * Receptionist KPI bar follows the same convention). `busyHours` uses
 * `start_time_utc` formatted in the salon timezone — receptionists
 * read time in the salon's local clock, not UTC.
 */
export async function loadSalonReports(
  slug: string,
  range: ReportsDateRange,
): Promise<LoadSalonReportsResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (resolved.role !== "owner") return { ok: false, error: "forbidden" };

  // Resolve the timezone for date math.
  const supabase = createServiceRoleClient();
  const { data: salonRow, error: salonErr } = await supabase
    .from("salons")
    .select("timezone")
    .eq("id", resolved.salon.id)
    .maybeSingle();

  if (salonErr) {
    console.error("[loadSalonReports] salons", salonErr);
    return { ok: false, error: "server_error" };
  }
  const tz =
    typeof salonRow?.timezone === "string" && salonRow.timezone.trim()
      ? salonRow.timezone.trim()
      : "America/Los_Angeles";

  const today = salonToday(tz);
  const { startUtc, endUtc } = computeRangeUtc(today, range, tz);

  // Pull bookings + the joined service name for top-services aggregation.
  // Cast: addon_price_cents not yet in auto-generated types in some
  // schema slices; the column is live since 20260430200000.
  const { data: rows, error: rowsErr } = await supabase
    .from("bookings")
    .select(
      `
      id, status, staff_id, service_id, start_time_utc, end_time_utc,
      price_cents, addon_price_cents,
      services!bookings_service_id_fkey ( name, duration_minutes )
    `,
    )
    .eq("salon_id", resolved.salon.id)
    .gte("start_time_utc", startUtc)
    .lt("start_time_utc", endUtc);

  if (rowsErr) {
    console.error("[loadSalonReports] bookings", rowsErr);
    return { ok: false, error: "server_error" };
  }

  // Pull staff names in one go to label topStaff aggregates without
  // forcing a per-row join in the bookings query.
  const { data: staffRows, error: staffErr } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", resolved.salon.id);

  if (staffErr) {
    console.error("[loadSalonReports] staff", staffErr);
    return { ok: false, error: "server_error" };
  }

  type ServiceJoin = { name: string; duration_minutes: number };
  type BookingRow = {
    id: string;
    status: string;
    staff_id: string | null;
    service_id: string;
    start_time_utc: string | null;
    end_time_utc: string | null;
    price_cents: number | null;
    addon_price_cents: number | null;
    services: ServiceJoin | ServiceJoin[] | null;
  };
  const bookings = (rows ?? []) as BookingRow[];

  const staffNameById = new Map<string, string>();
  for (const s of staffRows ?? []) {
    staffNameById.set(String(s.id), String(s.name ?? ""));
  }

  const data = aggregate(bookings, staffNameById, tz);
  return { ok: true, data };
}

function computeRangeUtc(
  todayYmd: string,
  range: ReportsDateRange,
  timezone: string,
): { startUtc: string; endUtc: string } {
  if (range === "today") {
    return salonDayRangeUtc(todayYmd, timezone);
  }
  // Local YYYY-MM-DD math — independent of timezone so the calendar
  // boundary lines up with the salon's local week/month even though
  // we then convert each YMD to UTC via salonDayRangeUtc.
  const [y, m, d] = todayYmd.split("-").map(Number);
  const local = new Date(y, (m ?? 1) - 1, d ?? 1);
  const ymd = (date: Date) => {
    const yy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  };
  if (range === "week") {
    // Mon–Sun containing today.
    const monIdx = (local.getDay() + 6) % 7; // Mon=0
    const monday = new Date(local);
    monday.setDate(local.getDate() - monIdx);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const { startUtc } = salonDayRangeUtc(ymd(monday), timezone);
    const { endUtc } = salonDayRangeUtc(ymd(sunday), timezone);
    return { startUtc, endUtc };
  }
  // month: first → last calendar day of this month.
  const first = new Date(local.getFullYear(), local.getMonth(), 1);
  const last = new Date(local.getFullYear(), local.getMonth() + 1, 0);
  const { startUtc } = salonDayRangeUtc(ymd(first), timezone);
  const { endUtc } = salonDayRangeUtc(ymd(last), timezone);
  return { startUtc, endUtc };
}

function aggregate(
  bookings: Array<{
    id: string;
    status: string;
    staff_id: string | null;
    service_id: string;
    start_time_utc: string | null;
    end_time_utc: string | null;
    price_cents: number | null;
    addon_price_cents: number | null;
    services:
      | { name: string; duration_minutes: number }
      | { name: string; duration_minutes: number }[]
      | null;
  }>,
  staffNameById: Map<string, string>,
  timezone: string,
): ReportsSnapshot {
  let totalRevenueCents = 0;
  let appointmentCount = 0;
  let completedCount = 0;
  let cancelledCount = 0;
  let noShowCount = 0;
  let durationSumMin = 0;
  let durationSamples = 0;

  type ServiceAgg = { name: string; count: number; revenueCents: number };
  const svcAgg = new Map<string, ServiceAgg>();

  type StaffAgg = {
    name: string;
    appointmentCount: number;
    revenueCents: number;
  };
  const staffAgg = new Map<string, StaffAgg>();

  const busyHours: Array<{ hour: number; count: number }> = Array.from(
    { length: 24 },
    (_, hour) => ({ hour, count: 0 }),
  );

  for (const b of bookings) {
    appointmentCount += 1;
    if (b.status === "completed") completedCount += 1;
    if (b.status === "cancelled") cancelledCount += 1;
    if (b.status === "no_show") noShowCount += 1;

    const main =
      b.price_cents != null && Number.isFinite(Number(b.price_cents))
        ? Number(b.price_cents)
        : 0;
    const addon =
      b.addon_price_cents != null &&
      Number.isFinite(Number(b.addon_price_cents))
        ? Number(b.addon_price_cents)
        : 0;
    const rev = b.status === "completed" ? main + addon : 0;
    totalRevenueCents += rev;

    // Service aggregate uses the joined name; orphaned join falls back
    // to the service_id so the row still appears in the table.
    const svcRaw = Array.isArray(b.services) ? b.services[0] : b.services;
    const svcName = svcRaw?.name?.trim() || b.service_id;
    const svcKey = b.service_id;
    const svc = svcAgg.get(svcKey) ?? {
      name: svcName,
      count: 0,
      revenueCents: 0,
    };
    svc.count += 1;
    svc.revenueCents += rev;
    svcAgg.set(svcKey, svc);

    if (b.staff_id) {
      const sName = staffNameById.get(b.staff_id) ?? "(unknown)";
      const s = staffAgg.get(b.staff_id) ?? {
        name: sName,
        appointmentCount: 0,
        revenueCents: 0,
      };
      s.appointmentCount += 1;
      s.revenueCents += rev;
      staffAgg.set(b.staff_id, s);
    }

    // Avg service duration: prefer joined catalog duration as the
    // intent; fallback to (end - start) when join is missing.
    const dur = svcRaw?.duration_minutes;
    if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
      durationSumMin += dur;
      durationSamples += 1;
    } else if (b.start_time_utc && b.end_time_utc) {
      const startMs = Date.parse(b.start_time_utc);
      const endMs = Date.parse(b.end_time_utc);
      if (
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        endMs > startMs
      ) {
        durationSumMin += Math.round((endMs - startMs) / 60_000);
        durationSamples += 1;
      }
    }

    // Busy hours: bucket by salon-local hour-of-day from start_time_utc.
    if (b.start_time_utc) {
      const hour = hourInTz(b.start_time_utc, timezone);
      if (hour !== null) busyHours[hour].count += 1;
    }
  }

  const avgServiceDurationMinutes =
    durationSamples > 0 ? Math.round(durationSumMin / durationSamples) : 0;

  const topServices = Array.from(svcAgg.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_LIMIT);

  const topStaff = Array.from(staffAgg.values())
    .sort((a, b) => b.appointmentCount - a.appointmentCount)
    .slice(0, TOP_LIMIT);

  return {
    totalRevenueCents,
    appointmentCount,
    completedCount,
    cancelledCount,
    noShowCount,
    avgServiceDurationMinutes,
    topServices,
    topStaff,
    busyHours,
  };
}

function hourInTz(utcIso: string, timezone: string): number | null {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "");
  return Number.isFinite(h) && h >= 0 && h < 24 ? h : null;
}
