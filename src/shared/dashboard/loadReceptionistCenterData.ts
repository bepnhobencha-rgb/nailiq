import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { salonDayRangeUtc } from "@/shared/lib/salonTime";
import type { BookingSource, BookingStatus } from "@/shared/types";

type DashboardSupabaseClient = SupabaseClient<Database>;

export interface ReceptionistCenterData {
  salon: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
  };
  staff: Array<{
    id: string;
    name: string;
    job_role: string;
  }>;
  services: Array<{
    id: string;
    name: string;
    duration_minutes: number;
    buffer_minutes: number;
    price_cents: number;
    created_at: string | null;
  }>;
  walkinQueue: Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    service_id: string;
    service_name: string;
    service_duration_minutes: number;
    staff_request_note: string | null;
    joined_queue_at: string;
  }>;
  bookingsForDay: Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    client_notes: string | null;
    staff_id: string;
    start_time_utc: string;
    end_time_utc: string;
    status: BookingStatus;
    source: BookingSource;
    service_id: string;
    service_name: string;
    service_duration_minutes: number;
    price_cents: number | null;
    /** Cleanup / turnover minutes after service (catalog); used for drawer time copy. */
    service_buffer_minutes: number;
  }>;
  selectedDate: string;
}

export type LoadReceptionistCenterError =
  | "unauthorized"
  | "salon_not_found"
  | "invalid_date"
  | "server_error";

export type LoadReceptionistCenterResult =
  | { ok: true; data: ReceptionistCenterData }
  | { ok: false; error: LoadReceptionistCenterError };

type ServiceJoinMinimal = {
  name: string;
  duration_minutes: number;
  buffer_minutes: number;
};

/** Same pattern as `dashboardBookingMap.serviceFromJoin`. */
function serviceFromJoin(
  raw: ServiceJoinMinimal | ServiceJoinMinimal[] | null,
): ServiceJoinMinimal | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

type DashboardWriteResolver = (
  slug: string,
) => Promise<
  | null
  | {
      salon: { id: string };
      kind: "member" | "demo_cookie";
      supabase: DashboardSupabaseClient;
    }
>;

export type ReceptionistCenterDataLoaderDeps = {
  /** Omit in app routes; smoke tests inject a service-role resolver. */
  resolveWrite?: DashboardWriteResolver;
};

const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_DAY_STATUSES: BookingStatus[] = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
];

async function defaultResolveWrite(
  slug: string,
): Promise<Awaited<ReturnType<DashboardWriteResolver>>> {
  const { getDashboardWriteClient } =
    await import("@/shared/dashboard/setupActions");
  return getDashboardWriteClient(slug);
}

/**
 * Loads salon meta, catalog, walk-in queue, and day-grid bookings for Receptionist Center.
 * Server-side only via `resolveWrite`; uses dynamic import so tooling can inject `deps` without loading Next.
 */
export async function loadReceptionistCenterData(
  slug: string,
  dateYmd: string,
  deps?: ReceptionistCenterDataLoaderDeps,
): Promise<LoadReceptionistCenterResult> {
  if (!DATE_YMD_RE.test(dateYmd)) {
    return { ok: false, error: "invalid_date" };
  }

  const resolveWrite = deps?.resolveWrite ?? defaultResolveWrite;
  const ctx = await resolveWrite(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const supabase = ctx.supabase;

  const salonResult = await supabase
    .from("salons")
    .select("id, name, slug, timezone")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  if (salonResult.error) {
    console.error("[loadReceptionistCenterData] salons", salonResult.error);
    return { ok: false, error: "server_error" };
  }

  const salonData = salonResult.data as {
    id: string;
    name: string;
    slug: string;
    timezone: string;
  } | null;

  if (!salonData?.id || typeof salonData.timezone !== "string" || salonData.timezone.trim() === "") {
    return { ok: false, error: "salon_not_found" };
  }

  const salonRow = {
    id: salonData.id,
    name: String(salonData.name ?? ""),
    slug: String(salonData.slug ?? ""),
    timezone: salonData.timezone.trim(),
  };

  let startUtc: string;
  let endUtc: string;
  try {
    ({ startUtc, endUtc } = salonDayRangeUtc(dateYmd, salonRow.timezone));
  } catch (e) {
    console.error("[loadReceptionistCenterData] salonDayRangeUtc", e);
    return { ok: false, error: "invalid_date" };
  }

  const [staffResult, servicesResult, queueResult, bookingsResult] = await Promise.all([
    supabase
      .from("staff")
      .select("id, name, job_role")
      .eq("salon_id", ctx.salon.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("services")
      .select("id, name, duration_minutes, buffer_minutes, price_cents, created_at")
      .eq("salon_id", ctx.salon.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("bookings")
      .select(
        `
      id,
      client_name,
      client_phone,
      service_id,
      staff_request_note,
      joined_queue_at,
      services!bookings_service_id_fkey ( name, duration_minutes, buffer_minutes )
    `,
      )
      .eq("salon_id", ctx.salon.id)
      .eq("source", "walkin")
      .eq("status", "waiting")
      .order("joined_queue_at", { ascending: true }),
    supabase
      .from("bookings")
      .select(
        `
      id,
      client_name,
      client_phone,
      client_notes,
      staff_id,
      start_time_utc,
      end_time_utc,
      status,
      source,
      service_id,
      price_cents,
      services!bookings_service_id_fkey ( name, duration_minutes, buffer_minutes )
    `,
      )
      .eq("salon_id", ctx.salon.id)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc)
      .in("status", [...BOOKING_DAY_STATUSES])
      .order("start_time_utc", { ascending: true }),
  ]);

  if (staffResult.error) {
    console.error("[loadReceptionistCenterData] staff", staffResult.error);
    return { ok: false, error: "server_error" };
  }
  if (servicesResult.error) {
    console.error("[loadReceptionistCenterData] services", servicesResult.error);
    return { ok: false, error: "server_error" };
  }
  if (queueResult.error) {
    console.error("[loadReceptionistCenterData] queue", queueResult.error);
    return { ok: false, error: "server_error" };
  }
  if (bookingsResult.error) {
    console.error("[loadReceptionistCenterData] bookings", bookingsResult.error);
    return { ok: false, error: "server_error" };
  }

  const staffRows = staffResult.data as Array<{
    id: string;
    name: string;
    job_role: string;
  }> | null;

  const serviceRows = servicesResult.data as Array<{
    id: string;
    name: string;
    duration_minutes: number;
    buffer_minutes: number;
    price_cents: number;
    created_at: string | null;
  }> | null;

  const queueRows = queueResult.data as Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    service_id: string;
    staff_request_note: string | null;
    joined_queue_at: string | null;
    services: ServiceJoinMinimal | ServiceJoinMinimal[] | null;
  }> | null;

  const bookingsRows = bookingsResult.data as Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    client_notes: string | null;
    staff_id: string | null;
    start_time_utc: string | null;
    end_time_utc: string | null;
    status: string;
    source: string | null;
    service_id: string;
    price_cents: number | null;
    services: ServiceJoinMinimal | ServiceJoinMinimal[] | null;
  }> | null;

  const walkinQueue: ReceptionistCenterData["walkinQueue"] = [];

  for (const row of queueRows ?? []) {
    const svc = serviceFromJoin(row.services);
    if (!row.joined_queue_at?.trim()) continue;
    const dRaw = Number(svc?.duration_minutes ?? 0);
    const bRaw = Number(svc?.buffer_minutes ?? 0);
    const d = Number.isFinite(dRaw) ? Math.round(dRaw) : 0;
    const buf = Number.isFinite(bRaw) ? Math.round(bRaw) : 0;
    const spanMin = Number.isFinite(d + buf) && d + buf > 0 ? d + buf : 0;
    walkinQueue.push({
      id: row.id,
      client_name: row.client_name,
      client_phone: row.client_phone ?? null,
      service_id: row.service_id,
      service_name: svc?.name ?? "—",
      /** Total slot span (duration + buffer) aligned with catalog + desk assign/conflict logic. */
      service_duration_minutes: spanMin,
      staff_request_note: row.staff_request_note ?? null,
      joined_queue_at: row.joined_queue_at,
    });
  }

  const bookingsForDayUnfiltered = (bookingsRows ?? []).map((row): ReceptionistCenterData["bookingsForDay"][0] | null => {
    const staffId = row.staff_id != null ? String(row.staff_id).trim() : "";
    const st = row.start_time_utc != null ? String(row.start_time_utc).trim() : "";
    const en = row.end_time_utc != null ? String(row.end_time_utc).trim() : "";

    const svc = serviceFromJoin(row.services);
    const source: BookingSource =
      row.source === "walkin" ? "walkin" : "appointment";
    const status = row.status as BookingStatus;

    if (!staffId || !st || !en) return null;

    return {
      id: row.id,
      client_name: row.client_name,
      client_phone: row.client_phone ?? null,
      client_notes: row.client_notes ?? null,
      staff_id: staffId,
      start_time_utc: st,
      end_time_utc: en,
      status,
      source,
      service_id: row.service_id,
      service_name: svc?.name ?? "—",
      service_duration_minutes: Number(svc?.duration_minutes ?? 0),
      service_buffer_minutes: Math.max(
        0,
        Math.round(Number(svc?.buffer_minutes ?? 0)),
      ),
      price_cents: row.price_cents,
    };
  });

  const bookingsForDay = bookingsForDayUnfiltered.filter(
    (x): x is ReceptionistCenterData["bookingsForDay"][0] => x !== null,
  );

  return {
    ok: true,
    data: {
      salon: salonRow,
      staff: staffRows ?? [],
      services:
        serviceRows?.map((s) => ({
          id: s.id,
          name: s.name,
          duration_minutes: Number(s.duration_minutes),
          buffer_minutes: Number(s.buffer_minutes),
          price_cents: Number(s.price_cents),
          created_at: s.created_at,
        })) ?? [],
      walkinQueue,
      bookingsForDay,
      selectedDate: dateYmd,
    },
  };
}
