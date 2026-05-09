import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { salonDayRangeUtc } from "@/shared/lib/salonTime";
import {
  isQueuePriority,
  isQueueSource,
  parseRequestTags,
  type QueuePriority,
  type QueueRequestTag,
  type QueueSource,
  type BookingSource,
  type BookingStatus,
} from "@/shared/types";
import {
  parseDashboardModules,
  type DashboardModulesConfig,
} from "@/shared/dashboard/dashboardModules";
import {
  applyPreset,
  parsePresetKey,
  type PresetKey,
} from "@/shared/dashboard/dashboardPresets";

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
    /**
     * Operational availability status for the receptionist staff column.
     * Maps the `StaffAvatar` `StaffStatus` union:
     *   - `available`  → no `in_progress` booking right now
     *   - `busy`       → exactly one `in_progress` booking right now
     *   - `overbooked` → 2+ `in_progress` bookings right now (defended in
     *     code; cannot occur under the live `bookings_no_overlap` GIST
     *     EXCLUDE constraint, kept for future schema changes)
     *   - `offline`    → `staff.status IN ('inactive','pending')` —
     *     not customer-facing per `staff.status` migration semantics
     */
    status: "available" | "busy" | "overbooked" | "offline";
    /**
     * Relative load 0–100. Numerator: today's non-cancelled bookings for
     * this staff. Denominator: max across all staff today (so the busiest
     * staff is 100). Returns 0 when no staff has any bookings today.
     */
    workload: number;
    /**
     * Skill tags filtered to the `StaffSkill` enum from
     * `src/components/ui/StaffAvatar.tsx`. Unknown DB values are dropped
     * at the boundary so the avatar component receives only valid keys.
     */
    skills: ("acrylic" | "design" | "pedicure" | "fast" | "junior")[];
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
    /** Optional walk-in queue metadata; nullable until tagged. */
    walkin_source: QueueSource | null;
    walkin_priority: QueuePriority | null;
    walkin_request_tags: QueueRequestTag[];
    party_size: number | null;
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
    /**
     * Walk-in arrival timestamp (only set when `source === "walkin"`); used by
     * the KPI bar to compute today's average wait (joined → assigned).
     */
    joined_queue_at: string | null;
    /** Optional secondary service. Null when the booking has no add-on. */
    addon_service_id: string | null;
    addon_service_name: string | null;
    addon_duration_minutes: number | null;
    addon_buffer_minutes: number | null;
    addon_price_cents: number | null;
    /**
     * Receptionist booking-block icon flags. Derived server-side from
     * existing columns (no new DB schema) so the timeline can render them
     * synchronously on first paint:
     *
     *   - `is_vip`     → `walkin_source === 'vip'` (existing channel
     *                    enum from the walk-in queue meta migration).
     *   - `has_notes`  → `client_notes` is a non-empty string after trim.
     *   - `has_design` → service name (or addon service name) matches
     *                    `/(nail\s*art|design)/i`. Heuristic — the schema
     *                    has no first-class "requires design" flag yet,
     *                    so we match the conventional service-naming the
     *                    catalog already uses ("Acrylic with Design",
     *                    "Nail Art", etc.). Documented for PM follow-up
     *                    if a structured `service.is_design_capable`
     *                    column is preferred later.
     *
     * `is_late` is **not** stored here — it's a live derivation of
     * `status === 'in_progress' && end_time_utc < now` and is computed
     * in the client when "now" advances per minute. Per
     * `STATE_MACHINE.md` §3 + §5 `late` is an overlay flag, not a
     * status replacement.
     */
    is_vip: boolean;
    has_notes: boolean;
    has_design: boolean;
  }>;
  /** Per-staff service whitelist for this salon. `null` = no rows → all-capable fallback. */
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  selectedDate: string;
  /**
   * Effective desk flags: `applyPreset(dashboardPreset, parsedModules)`.
   * Components consume this directly — preset and per-flag overrides are
   * already merged. The raw preset is exposed below for settings UI only.
   */
  dashboardModules: DashboardModulesConfig;
  /** Active workspace preset for this salon. Drives layout + module defaults. */
  dashboardPreset: PresetKey;
  /**
   * Receptionist KPI band snapshot for the selected day. Computed server-side
   * from the same dataset as the timeline + queue so values are coherent on
   * first paint; values are only operationally meaningful when the day
   * matches "today" in the salon timezone — the consumer is responsible for
   * gating the band on `isViewingToday`.
   *
   * Note: the `inProgressCount` field maps to the codebase's actual booking
   * status `in_progress` (see `BOOKING_DAY_STATUSES` and the live
   * `bookings_status_check` constraint). The product-doc label "in service"
   * (COLOR_TOKENS) is the user-facing translation of that state.
   */
  kpiSnapshot: {
    /** Walk-ins currently in `waiting` status (== walkinQueue length). */
    waitingCount: number;
    /** Bookings currently in `in_progress` status. */
    inProgressCount: number;
    /**
     * Average minutes from walk-in arrival (`joined_queue_at`) to assignment
     * (`start_time_utc`) across today's walk-ins that have transitioned out
     * of `waiting`. `null` when no walk-in has been assigned yet today.
     */
    avgWaitMinutes: number | null;
    /** Confirmed/pending bookings starting in (now, now + 30 minutes]. */
    comingUpCount: number;
    /** `in_progress` bookings whose `end_time_utc` is in the past. */
    overdueCount: number;
    /**
     * Earliest-free staff member by current `in_progress` end time. Free
     * **now** is reported as `minutesUntilFree: 0`. `null` when no staff
     * exists.
     */
    nextAvailableStaff: { name: string; minutesUntilFree: number } | null;
    /**
     * Sum of `price_cents + addon_price_cents` across `completed` bookings
     * for the selected day. `null` when `dashboardModules.revenue_today` is
     * false (the tile must be hidden in that case — value is not "0").
     */
    revenueTodayCents: number | null;
  };
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

/**
 * Skill values surfaced on `StaffAvatar`. Mirrors the `StaffSkill` enum in
 * `src/components/ui/StaffAvatar.tsx` — kept as a literal here to avoid a
 * client→server import (the avatar is "use client"). DB stores raw text[];
 * unknown values are filtered at the boundary.
 */
const KNOWN_STAFF_SKILLS = [
  "acrylic",
  "design",
  "pedicure",
  "fast",
  "junior",
] as const;
type KnownStaffSkill = (typeof KNOWN_STAFF_SKILLS)[number];

function isKnownStaffSkill(value: unknown): value is KnownStaffSkill {
  return (
    typeof value === "string" &&
    (KNOWN_STAFF_SKILLS as readonly string[]).includes(value)
  );
}

function filterKnownSkills(raw: unknown): KnownStaffSkill[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownStaffSkill[] = [];
  for (const v of raw) {
    if (isKnownStaffSkill(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Per-staff operational availability for the receptionist staff column.
 * "now" is captured once at call time so all rows share a snapshot
 * timestamp.
 *
 * Status decision tree (in priority order):
 *   1. `staff.status IN ('inactive','pending')`        → "offline"
 *   2. count of in_progress for this staff is `>= 2`   → "overbooked"
 *   3. count of in_progress for this staff is `== 1`   → "busy"
 *   4. otherwise                                       → "available"
 *
 * Note on "overbooked": the live `bookings_no_overlap` GIST EXCLUDE
 * constraint forbids overlapping non-cancelled bookings on the same
 * staff, so under correct DB state the "2+ in_progress" branch can never
 * fire. Kept for defense if the constraint is ever loosened or a future
 * state machine permits parallel sessions per staff.
 *
 * Workload is the staff's non-cancelled booking count today divided by
 * the busiest staff's count (×100, rounded to integer). Returns 0 for
 * everyone when no staff has any booking today (avoid div-by-zero).
 */
function enrichStaffRows(
  rawStaff: ReadonlyArray<{
    id: string;
    name: string;
    job_role: string;
    status: string | null;
    skills: string[] | null;
  }>,
  bookingsForDay: ReceptionistCenterData["bookingsForDay"],
): ReceptionistCenterData["staff"] {
  // Bucket bookings by staff once for both status + workload passes.
  const inProgressByStaff = new Map<string, number>();
  const todayCountByStaff = new Map<string, number>();
  for (const b of bookingsForDay) {
    todayCountByStaff.set(b.staff_id, (todayCountByStaff.get(b.staff_id) ?? 0) + 1);
    if (b.status === "in_progress") {
      inProgressByStaff.set(
        b.staff_id,
        (inProgressByStaff.get(b.staff_id) ?? 0) + 1,
      );
    }
  }

  let maxToday = 0;
  for (const c of todayCountByStaff.values()) {
    if (c > maxToday) maxToday = c;
  }

  return rawStaff.map((s) => {
    const dbStatus = (s.status ?? "active").trim().toLowerCase();
    let avatarStatus: ReceptionistCenterData["staff"][number]["status"];
    if (dbStatus === "inactive" || dbStatus === "pending") {
      avatarStatus = "offline";
    } else {
      const inProg = inProgressByStaff.get(s.id) ?? 0;
      if (inProg >= 2) avatarStatus = "overbooked";
      else if (inProg === 1) avatarStatus = "busy";
      else avatarStatus = "available";
    }

    const myToday = todayCountByStaff.get(s.id) ?? 0;
    const workload =
      maxToday > 0 ? Math.round((myToday / maxToday) * 100) : 0;

    return {
      id: s.id,
      name: s.name,
      job_role: s.job_role,
      status: avatarStatus,
      workload,
      skills: filterKnownSkills(s.skills),
    };
  });
}

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
    .select("id, name, slug, timezone, dashboard_modules, dashboard_preset")
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
    dashboard_modules?: unknown;
    dashboard_preset?: unknown;
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

  const rawDashboardModules = parseDashboardModules(
    salonData.dashboard_modules,
  );
  const dashboardPreset = parsePresetKey(salonData.dashboard_preset);
  const dashboardModules = applyPreset(dashboardPreset, rawDashboardModules);

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
      .select("id, name, job_role, status, skills")
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
      walkin_source,
      walkin_priority,
      walkin_request_tags,
      party_size,
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
      joined_queue_at,
      walkin_source,
      addon_service_id,
      addon_price_cents,
      services!bookings_service_id_fkey ( name, duration_minutes, buffer_minutes ),
      addon:services!bookings_addon_service_id_fkey ( name, duration_minutes, buffer_minutes )
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
    status: string | null;
    skills: string[] | null;
  }> | null;

  const serviceRows = servicesResult.data as Array<{
    id: string;
    name: string;
    duration_minutes: number;
    buffer_minutes: number;
    price_cents: number;
    created_at: string | null;
  }> | null;

  const queueRows = queueResult.data as unknown as Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    service_id: string;
    staff_request_note: string | null;
    joined_queue_at: string | null;
    walkin_source?: unknown;
    walkin_priority?: unknown;
    walkin_request_tags?: unknown;
    party_size?: unknown;
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
    joined_queue_at: string | null;
    walkin_source: string | null;
    addon_service_id: string | null;
    addon_price_cents: number | null;
    services: ServiceJoinMinimal | ServiceJoinMinimal[] | null;
    addon: ServiceJoinMinimal | ServiceJoinMinimal[] | null;
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
    const partyRaw = Number(row.party_size);
    const partySize =
      Number.isFinite(partyRaw) && partyRaw >= 1 && partyRaw <= 50
        ? Math.round(partyRaw)
        : null;

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
      walkin_source: isQueueSource(row.walkin_source) ? row.walkin_source : null,
      walkin_priority: isQueuePriority(row.walkin_priority)
        ? row.walkin_priority
        : null,
      walkin_request_tags: parseRequestTags(row.walkin_request_tags),
      party_size: partySize,
    });
  }

  const bookingsForDayUnfiltered = (bookingsRows ?? []).map((row): ReceptionistCenterData["bookingsForDay"][0] | null => {
    const staffId = row.staff_id != null ? String(row.staff_id).trim() : "";
    const st = row.start_time_utc != null ? String(row.start_time_utc).trim() : "";
    const en = row.end_time_utc != null ? String(row.end_time_utc).trim() : "";

    const svc = serviceFromJoin(row.services);
    const addon = serviceFromJoin(row.addon);
    const source: BookingSource =
      row.source === "walkin" ? "walkin" : "appointment";
    const status = row.status as BookingStatus;

    if (!staffId || !st || !en) return null;

    const addonId =
      row.addon_service_id != null && String(row.addon_service_id).trim().length
        ? String(row.addon_service_id).trim()
        : null;
    // The bare `addon_service_id` column drives presence; the FK row provides
    // name/duration. If the id is set but the FK row is missing (orphaned or
    // join failure), still surface "Add-on" so the receptionist isn't silently
    // misled into seeing a single-service booking.
    const hasAddon = addonId !== null;

    const isVip =
      typeof row.walkin_source === "string" &&
      row.walkin_source.trim().toLowerCase() === "vip";
    const hasNotes =
      typeof row.client_notes === "string" && row.client_notes.trim().length > 0;
    // Heuristic: catalog naming convention. Match "nail art" or "design" in
    // either the primary or addon service name. No structured DB flag exists
    // yet; documented for PM reconciliation if a `services.is_design_capable`
    // column is preferred later.
    const designRe = /(nail\s*art|design)/i;
    const hasDesign =
      designRe.test(svc?.name ?? "") || (hasAddon && designRe.test(addon?.name ?? ""));

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
      joined_queue_at: row.joined_queue_at?.trim() ? row.joined_queue_at : null,
      addon_service_id: addonId,
      addon_service_name: hasAddon ? addon?.name ?? "—" : null,
      addon_duration_minutes: hasAddon
        ? Math.max(0, Math.round(Number(addon?.duration_minutes ?? 0)))
        : null,
      addon_buffer_minutes: hasAddon
        ? Math.max(0, Math.round(Number(addon?.buffer_minutes ?? 0)))
        : null,
      addon_price_cents: hasAddon ? row.addon_price_cents ?? null : null,
      is_vip: isVip,
      has_notes: hasNotes,
      has_design: hasDesign,
    };
  });

  const bookingsForDay = bookingsForDayUnfiltered.filter(
    (x): x is ReceptionistCenterData["bookingsForDay"][0] => x !== null,
  );

  let capabilityRows: { staff_id: string; service_id: string }[] | null = null;
  if ((staffRows?.length ?? 0) > 0) {
    const staffIds = (staffRows ?? []).map((s) => String(s.id));
    const { data: capRows, error: capErr } = await supabase
      .from("staff_services")
      .select("staff_id, service_id")
      .in("staff_id", staffIds);
    if (capErr) {
      console.error("[loadReceptionistCenterData] staff_services", capErr);
    } else if ((capRows?.length ?? 0) > 0) {
      capabilityRows = (capRows ?? []).map((r) => ({
        staff_id: String(r.staff_id),
        service_id: String(r.service_id),
      }));
    }
  }

  const enrichedStaff = enrichStaffRows(staffRows ?? [], bookingsForDay);

  const kpiSnapshot = computeKpiSnapshot({
    walkinQueue,
    bookingsForDay,
    staff: enrichedStaff,
    revenueModuleEnabled: dashboardModules.revenue_today,
  });

  return {
    ok: true,
    data: {
      salon: salonRow,
      staff: enrichedStaff,
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
      capabilityRows,
      selectedDate: dateYmd,
      dashboardModules,
      dashboardPreset,
      kpiSnapshot,
    },
  };
}

const COMING_UP_WINDOW_MINUTES = 30;

/**
 * Pure derivation of the receptionist KPI snapshot from already-loaded
 * bookings/walk-ins/staff. Kept as a top-level fn so it can be unit-tested
 * without a Supabase client. Time arithmetic uses `Date.now()` once per call
 * for snapshot-stability across all tiles.
 */
function computeKpiSnapshot(args: {
  walkinQueue: ReceptionistCenterData["walkinQueue"];
  bookingsForDay: ReceptionistCenterData["bookingsForDay"];
  staff: ReceptionistCenterData["staff"];
  revenueModuleEnabled: boolean;
}): ReceptionistCenterData["kpiSnapshot"] {
  const { walkinQueue, bookingsForDay, staff, revenueModuleEnabled } = args;
  const nowMs = Date.now();
  const comingUpCutoffMs = nowMs + COMING_UP_WINDOW_MINUTES * 60_000;

  const waitingCount = walkinQueue.length;
  const inProgressCount = bookingsForDay.filter(
    (b) => b.status === "in_progress",
  ).length;

  let comingUpCount = 0;
  let overdueCount = 0;
  for (const b of bookingsForDay) {
    const startMs = Date.parse(b.start_time_utc);
    const endMs = Date.parse(b.end_time_utc);
    if (
      (b.status === "pending" || b.status === "confirmed") &&
      Number.isFinite(startMs) &&
      startMs > nowMs &&
      startMs <= comingUpCutoffMs
    ) {
      comingUpCount += 1;
    }
    if (
      b.status === "in_progress" &&
      Number.isFinite(endMs) &&
      endMs < nowMs
    ) {
      overdueCount += 1;
    }
  }

  // Avg wait: walk-ins assigned today (`waiting → in_progress/completed`).
  let waitSampleCount = 0;
  let waitTotalMs = 0;
  for (const b of bookingsForDay) {
    if (b.source !== "walkin") continue;
    if (b.status !== "in_progress" && b.status !== "completed") continue;
    if (!b.joined_queue_at) continue;
    const joinedMs = Date.parse(b.joined_queue_at);
    const startMs = Date.parse(b.start_time_utc);
    if (!Number.isFinite(joinedMs) || !Number.isFinite(startMs)) continue;
    waitTotalMs += Math.max(0, startMs - joinedMs);
    waitSampleCount += 1;
  }
  const avgWaitMinutes =
    waitSampleCount > 0
      ? Math.round(waitTotalMs / waitSampleCount / 60_000)
      : null;

  // Next available staff: per-staff max(end_time_utc) over `in_progress`,
  // floored to "now" (a free staff is free **now**, not negative-minutes).
  let nextAvailableStaff: ReceptionistCenterData["kpiSnapshot"]["nextAvailableStaff"] =
    null;
  if (staff.length > 0) {
    let earliestFreeMs = Number.POSITIVE_INFINITY;
    let earliestStaffName: string | null = null;
    for (const s of staff) {
      let staffMaxEndMs = 0;
      for (const b of bookingsForDay) {
        if (b.status !== "in_progress" || b.staff_id !== s.id) continue;
        const endMs = Date.parse(b.end_time_utc);
        if (Number.isFinite(endMs) && endMs > staffMaxEndMs) {
          staffMaxEndMs = endMs;
        }
      }
      const freeMs = Math.max(staffMaxEndMs, nowMs);
      if (freeMs < earliestFreeMs) {
        earliestFreeMs = freeMs;
        earliestStaffName = s.name;
      }
    }
    if (earliestStaffName !== null && Number.isFinite(earliestFreeMs)) {
      nextAvailableStaff = {
        name: earliestStaffName,
        minutesUntilFree: Math.max(
          0,
          Math.round((earliestFreeMs - nowMs) / 60_000),
        ),
      };
    }
  }

  // Revenue: only when the module is on (the tile must be hidden otherwise,
  // distinct from "$0").
  let revenueTodayCents: number | null = null;
  if (revenueModuleEnabled) {
    let total = 0;
    for (const b of bookingsForDay) {
      if (b.status !== "completed") continue;
      const main = b.price_cents != null ? Number(b.price_cents) : 0;
      const addon = b.addon_price_cents != null ? Number(b.addon_price_cents) : 0;
      if (Number.isFinite(main)) total += main;
      if (Number.isFinite(addon)) total += addon;
    }
    revenueTodayCents = total;
  }

  return {
    waitingCount,
    inProgressCount,
    avgWaitMinutes,
    comingUpCount,
    overdueCount,
    nextAvailableStaff,
    revenueTodayCents,
  };
}
