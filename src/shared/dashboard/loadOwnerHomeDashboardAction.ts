"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  salonDayRangeUtc,
  salonToday,
  salonYmdOfUtc,
} from "@/shared/lib/salonTime";
import { loadUnclosedBookings } from "@/shared/dashboard/loadUnclosedBookings";
import type { UnclosedBooking } from "@/shared/dashboard/unclosedBookingTypes";
import { getPendingApprovals } from "@/shared/ai/approvalRequests";
import { customerIdentityKey } from "@/shared/customer/customerIdentityKey";
import {
  buildOwnerHomeStaffSnapshot,
  type OwnerHomeStaffStatus,
} from "@/shared/dashboard/ownerHomeStaffSnapshot";

export type OwnerHomeData = {
  currencyCode: string;
  timezone: string;
  todayYmd: string;
  // Today
  todayTotal: number;
  todayConfirmed: number;
  todayCompleted: number;
  todayNoShows: number;
  todayRevenueCents: number;
  currentStaff: OwnerHomeStaffStatus[];
  // This week vs last week (Mon–Sun in salon tz)
  weekRevenueCents: number;
  lastWeekRevenueCents: number;
  weekBookings: number;
  lastWeekBookings: number;
  // This month
  monthRevenueCents: number;
  monthBookings: number;
  // 30-day daily sparkline — sorted oldest→newest, date = salon-local YYYY-MM-DD
  dailyRevenue: Array<{ date: string; revenueCents: number }>;
  // Top 5 services this month (by count)
  topServices: Array<{ name: string; count: number; revenueCents: number }>;
  // Top 5 staff this month (by appointment count)
  topStaff: Array<{
    name: string;
    appointmentCount: number;
    revenueCents: number;
  }>;
  // Customer health
  newClientsThisMonth: number;
  totalClientsThisMonth: number;
  noShowRateThisWeek: number;
  // Tomorrow
  tomorrowBookings: number;
  tomorrowRevenueCents: number;
  // Minh AI Manager
  pendingApprovalsCount: number;
  /** Past appointments the desk never closed out (still pending/confirmed/
   *  in_progress). Each drifts the revenue and no-show numbers further from
   *  reality, so the dashboard surfaces them with a link straight to the row. */
  unclosedCount: number;
  unclosedItems: UnclosedBooking[];
};

export type LoadOwnerHomeResult =
  | { ok: true; data: OwnerHomeData }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}

function weekMondayYmd(todayYmd: string): string {
  const [y, m, d] = todayYmd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const monIdx = (dow + 6) % 7; // Mon=0
  return addDays(todayYmd, -monIdx);
}

async function loadOwnerHomeProjectionBundle(input: {
  salonId: string;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  monthStart: string;
}) {
  const supabase = createServiceRoleClient();
  return Promise.all([
    supabase.rpc(
      "load_owner_home_projection" as never,
      {
        p_salon_id: input.salonId,
        p_window_start: input.windowStart,
        p_window_end: input.windowEnd,
        p_month_start: input.monthStart,
      } as never,
    ),
    getPendingApprovals(input.salonId).catch(() => []),
    loadUnclosedBookings(input.salonId, input.timezone, { limit: 4 }).catch(
      () => ({ count: 0, items: [] }),
    ),
  ] as const);
}

const ownerHomeProjectionFlights = new Map<
  string,
  ReturnType<typeof loadOwnerHomeProjectionBundle>
>();

async function loadOwnerHomeProjectionBundleInFlight(
  input: Parameters<typeof loadOwnerHomeProjectionBundle>[0],
) {
  const key = JSON.stringify([
    input.salonId,
    input.timezone,
    input.windowStart,
    input.windowEnd,
    input.monthStart,
  ]);
  const existing = ownerHomeProjectionFlights.get(key);
  if (existing) return existing;
  if (ownerHomeProjectionFlights.size >= 512) {
    return loadOwnerHomeProjectionBundle(input);
  }

  const flight = loadOwnerHomeProjectionBundle(input);
  ownerHomeProjectionFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (ownerHomeProjectionFlights.get(key) === flight) {
      ownerHomeProjectionFlights.delete(key);
    }
  }
}

export async function loadOwnerHomeDashboard(
  slug: string,
): Promise<LoadOwnerHomeResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(resolved.role)) return { ok: false, error: "forbidden" };

  const tz =
    typeof resolved.salon.timezone === "string" && resolved.salon.timezone.trim()
      ? resolved.salon.timezone.trim()
      : "America/Los_Angeles";

  const currencyCode =
    typeof resolved.salon.currency_code === "string"
      ? resolved.salon.currency_code
      : "USD";

  const today = salonToday(tz);
  const tomorrow = addDays(today, 1);
  const monday = weekMondayYmd(today);
  const lastMonday = addDays(monday, -7);
  const lastSunday = addDays(lastMonday, 6);
  const thirtyDaysAgo = addDays(today, -29);

  // Month boundaries
  const [y, mo] = today.split("-").map(Number);
  const firstOfMonth = `${y}-${String(mo).padStart(2, "0")}-01`;
  const nextMonthFirst =
    mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;

  // UTC bounds for all ranges
  const { startUtc: windowStart } = salonDayRangeUtc(thirtyDaysAgo, tz);
  const { endUtc: windowEnd } = salonDayRangeUtc(tomorrow, tz);
  const { startUtc: todayStart, endUtc: todayEnd } = salonDayRangeUtc(
    today,
    tz,
  );
  const { startUtc: weekStart } = salonDayRangeUtc(monday, tz);
  const { startUtc: weekEnd } = salonDayRangeUtc(addDays(monday, 7), tz);
  const { startUtc: lastWeekStart } = salonDayRangeUtc(lastMonday, tz);
  const { startUtc: lastWeekEnd } = salonDayRangeUtc(
    addDays(lastSunday, 1),
    tz,
  );
  const { startUtc: monthStart } = salonDayRangeUtc(firstOfMonth, tz);
  const { startUtc: monthEnd } = salonDayRangeUtc(nextMonthFirst, tz);
  const { startUtc: tomorrowStart, endUtc: tomorrowEnd } = salonDayRangeUtc(
    tomorrow,
    tz,
  );

  // Single booking query covering 30 days + tomorrow
  const [projectionResult, pendingApprovals, unclosed] =
    await loadOwnerHomeProjectionBundleInFlight({
      salonId: resolved.salon.id,
      timezone: tz,
      windowStart,
      windowEnd,
      monthStart,
    });

  if (
    projectionResult.error ||
    !projectionResult.data ||
    typeof projectionResult.data !== "object" ||
    Array.isArray(projectionResult.data)
  ) {
    console.error(
      "[loadOwnerHomeDashboard] projection",
      projectionResult.error ?? "invalid projection",
    );
    return { ok: false, error: "server_error" };
  }

  const projection = projectionResult.data as unknown as Record<string, unknown>;
  if (
    !Array.isArray(projection.bookings) ||
    !Array.isArray(projection.staff) ||
    !Array.isArray(projection.prior_clients)
  ) {
    console.error("[loadOwnerHomeDashboard] projection omitted arrays");
    return { ok: false, error: "server_error" };
  }
  const bookingRows = projection.bookings;
  const staffRows = projection.staff as Array<{
    id: unknown;
    name?: unknown;
    status?: unknown;
    deleted_at?: unknown;
  }>;
  const priorClientRows = projection.prior_clients as Array<{
    client_phone?: string | null;
    client_profile_id?: string | null;
  }>;

  const staffNameById = new Map<string, string>();
  for (const s of staffRows) {
    staffNameById.set(String(s.id), String(s.name ?? ""));
  }

  const priorClientSet = new Set(
    priorClientRows
      .map((row) =>
        customerIdentityKey({
          clientProfileId: row.client_profile_id as string | null,
          clientPhone: row.client_phone as string | null,
        }),
      )
      .filter((identity): identity is string => identity !== null),
  );

  type SvcJoin = { name: string };
  type BookingRow = {
    id: string;
    status: string;
    staff_id: string | null;
    service_id: string;
    start_time_utc: string | null;
    end_time_utc: string | null;
    price_cents: number | null;
    addon_price_cents: number | null;
    client_phone: string | null;
    client_profile_id: string | null;
    services: SvcJoin | SvcJoin[] | null;
  };

  const bookings = bookingRows as BookingRow[];

  function revCents(b: BookingRow): number {
    if (b.status !== "completed") return 0;
    const main =
      b.price_cents != null && Number.isFinite(Number(b.price_cents))
        ? Number(b.price_cents)
        : 0;
    const addon =
      b.addon_price_cents != null &&
      Number.isFinite(Number(b.addon_price_cents))
        ? Number(b.addon_price_cents)
        : 0;
    return main + addon;
  }

  function inRange(t: string, start: string, end: string): boolean {
    return t >= start && t < end;
  }

  // Aggregation counters
  let todayTotal = 0,
    todayConfirmed = 0,
    todayCompleted = 0,
    todayNoShows = 0,
    todayRevenueCents = 0;
  let weekRevenueCents = 0,
    weekBookings = 0,
    weekNoShows = 0,
    weekNonCancelled = 0;
  let lastWeekRevenueCents = 0,
    lastWeekBookings = 0;
  let monthRevenueCents = 0,
    monthBookings = 0;
  let tomorrowBookings = 0,
    tomorrowRevenueCents = 0;

  const dailyMap = new Map<string, number>();
  const svcAgg = new Map<
    string,
    { name: string; count: number; revenueCents: number }
  >();
  const staffAgg = new Map<
    string,
    { name: string; appointmentCount: number; revenueCents: number }
  >();
  const monthClients = new Set<string>();
  const newClients = new Set<string>();

  for (const b of bookings) {
    if (!b.start_time_utc) continue;
    const t = b.start_time_utc;
    const isCancelled = b.status === "cancelled";
    const rev = revCents(b);

    // Today
    if (inRange(t, todayStart, todayEnd)) {
      if (!isCancelled) todayTotal++;
      if (b.status === "confirmed" || b.status === "in_progress")
        todayConfirmed++;
      if (b.status === "completed") todayCompleted++;
      if (b.status === "no_show") todayNoShows++;
      todayRevenueCents += rev;
    }

    // This week
    if (!isCancelled && inRange(t, weekStart, weekEnd)) {
      weekBookings++;
      weekRevenueCents += rev;
      weekNonCancelled++;
      if (b.status === "no_show") weekNoShows++;
    }

    // Last week
    if (!isCancelled && inRange(t, lastWeekStart, lastWeekEnd)) {
      lastWeekBookings++;
      lastWeekRevenueCents += rev;
    }

    // This month
    if (!isCancelled && inRange(t, monthStart, monthEnd)) {
      monthBookings++;
      monthRevenueCents += rev;
      const clientIdentity = customerIdentityKey({
        clientProfileId: b.client_profile_id,
        clientPhone: b.client_phone,
      });
      if (clientIdentity) {
        monthClients.add(clientIdentity);
        if (!priorClientSet.has(clientIdentity)) {
          newClients.add(clientIdentity);
        }
      }
      // Top services
      const svcRaw = Array.isArray(b.services) ? b.services[0] : b.services;
      const svcName = svcRaw?.name ?? "—";
      const cur = svcAgg.get(b.service_id) ?? {
        name: svcName,
        count: 0,
        revenueCents: 0,
      };
      svcAgg.set(b.service_id, {
        name: svcName,
        count: cur.count + 1,
        revenueCents: cur.revenueCents + rev,
      });
      // Top staff
      if (b.staff_id) {
        const staffName = staffNameById.get(String(b.staff_id)) ?? "—";
        const sc = staffAgg.get(b.staff_id) ?? {
          name: staffName,
          appointmentCount: 0,
          revenueCents: 0,
        };
        staffAgg.set(b.staff_id, {
          name: staffName,
          appointmentCount: sc.appointmentCount + 1,
          revenueCents: sc.revenueCents + rev,
        });
      }
    }

    // Tomorrow
    if (!isCancelled && inRange(t, tomorrowStart, tomorrowEnd)) {
      tomorrowBookings++;
      tomorrowRevenueCents += rev;
    }

    // Daily sparkline (30 days, all non-cancelled)
    if (!isCancelled) {
      const localDate = salonYmdOfUtc(t, tz);
      dailyMap.set(localDate, (dailyMap.get(localDate) ?? 0) + rev);
    }
  }

  // Build 30-day array oldest→newest
  const dailyRevenue: Array<{ date: string; revenueCents: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const dateStr = addDays(today, -i);
    dailyRevenue.push({
      date: dateStr,
      revenueCents: dailyMap.get(dateStr) ?? 0,
    });
  }

  const topServices = [...svcAgg.values()]
    .sort((a, b) => b.count - a.count || b.revenueCents - a.revenueCents)
    .slice(0, 5);

  const topStaff = [...staffAgg.values()]
    .sort(
      (a, b) =>
        b.appointmentCount - a.appointmentCount ||
        b.revenueCents - a.revenueCents,
    )
    .slice(0, 5);

  const currentStaff = buildOwnerHomeStaffSnapshot({
    // Keep all staff above so historical leaderboards retain their names,
    // while the live snapshot only exposes the current active roster.
    staff: staffRows
      .filter(
        (staff) => staff.status === "active" && staff.deleted_at == null,
      )
      .map((staff) => ({
        id: String(staff.id),
        name: staff.name == null ? null : String(staff.name),
      })),
    bookings,
    nowMs: Date.now(),
  });

  return {
    ok: true,
    data: {
      currencyCode,
      timezone: tz,
      todayYmd: today,
      todayTotal,
      todayConfirmed,
      todayCompleted,
      todayNoShows,
      todayRevenueCents,
      currentStaff,
      weekRevenueCents,
      lastWeekRevenueCents,
      weekBookings,
      lastWeekBookings,
      monthRevenueCents,
      monthBookings,
      dailyRevenue,
      topServices,
      topStaff,
      newClientsThisMonth: newClients.size,
      totalClientsThisMonth: monthClients.size,
      noShowRateThisWeek:
        weekNonCancelled > 0 ? weekNoShows / weekNonCancelled : 0,
      tomorrowBookings,
      tomorrowRevenueCents,
      pendingApprovalsCount: pendingApprovals.length,
      unclosedCount: unclosed.count,
      unclosedItems: unclosed.items,
    },
  };
}
