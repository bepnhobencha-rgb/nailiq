import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parseCurrency } from "@/shared/lib/currencyFormat";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { salonDayRangeUtc } from "@/shared/lib/salonTime";
import {
  DAY_KEYS,
  parseOpeningHours,
} from "@/shared/dashboard/openingHoursDefaults";
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
import {
  parseDensityLevel,
  type DensityLevel,
} from "@/shared/dashboard/dashboardDensity";
import {
  parseStaffNotificationSettings,
  type StaffNotificationSettings,
} from "@/shared/dashboard/staffNotificationSettings";

type DashboardSupabaseClient = SupabaseClient<Database>;

export interface ReceptionistCenterData {
  salon: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    /** P0.2 — salon-configured currency (CAD/USD/VND). Drives every
     * money-formatting surface on the desk (KPI bar, drawer price,
     * walk-in service tile, reports panel). */
    currencyCode: import("@/shared/lib/currencyFormat").Currency;
    /** `salons.walkin_auto_assign` (PR #107). When false, the
     * receptionist's "Assign immediately" path is hidden — every
     * walk-in lands in the queue first. */
    walkinAutoAssign: boolean;
    /** `salons.queue_display_mode`. 'simple' hides noise fields on queue cards. */
    queueDisplayMode: "simple" | "full";
    /** `salons.basic_mode_forced`. When true, Basic Mode is auto-enabled and cannot be toggled off. */
    basicModeForced: boolean;
    /** Square deposits enabled (`square_integrations.deposit_enabled`). Drives
     * whether the desk offers the "request deposit + text link" action — false
     * for salons without Square so they never see a dead button. */
    depositsEnabled: boolean;
    /**
     * Salon open/close minutes-from-midnight for the SELECTED day, parsed from
     * `salons.opening_hours` in the salon timezone. `null` when the salon is
     * closed that day or hours are unset/unparseable. Drives the receptionist
     * timeline grid's default window so a booking-free day still shows the real
     * business hours (the grid still widens past these for off-hours bookings).
     */
    openMinutes: number | null;
    closeMinutes: number | null;
    /**
     * Per-salon staff-action customer-notification config (channels offered +
     * smart per-event notify defaults + default language). Drives the
     * "notify the customer?" decision when staff create / reschedule / cancel.
     */
    staffNotificationSettings: StaffNotificationSettings;
    /**
     * `salons.auto_no_show_minutes` — minutes past start after which the cron
     * auto-marks a never-started booking as no_show (0/null = off). Drives the
     * grid's lateness-escalation countdown ("auto no-show at H:MM"). When off,
     * the grid still escalates on fixed 10/20-minute milestones (visual only,
     * no auto promise). The cron NEVER charges — that's the desk's call.
     */
    autoNoShowMinutes: number | null;
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
  }>;
  services: Array<{
    id: string;
    name: string;
    duration_minutes: number;
    buffer_minutes: number;
    price_cents: number;
    /** Variable-pricing model ('fixed' | 'from' | 'range'); legacy rows → 'fixed'. */
    price_type: string;
    /** Upper bound (cents) for the 'range' model; null otherwise. */
    price_max_cents: number | null;
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
    /** First-class boolean flag — pairs with `requested_staff_*` to
     * power the heart-line on the queue card. Sourced from the
     * `bookings.staff_requested_by_client` column. */
    staff_requested_by_client: boolean;
    /** Resolved name of the requested staff member when the queue
     * row carries `staff_id`. Null when no specific staff requested
     * or when the FK can't be resolved (deleted staff, etc.). */
    requested_staff_name: string | null;
    /** UTC ISO time the requested staff is projected to be free.
     * Null when no requested staff or when projection is unknown. */
    requested_staff_ready_at_iso: string | null;
    /** True when the customer is a returning VIP per
     * `client_profiles.is_vip` (joined by phone, salon-agnostic). */
    is_vip: boolean;
    /** UTC ISO time the soft hold expires; null when not held (PR #104). */
    soft_hold_until: string | null;
    joined_queue_at: string;
    /** Optional walk-in queue metadata; nullable until tagged. */
    walkin_source: QueueSource | null;
    walkin_priority: QueuePriority | null;
    walkin_request_tags: QueueRequestTag[];
    party_size: number | null;
  }>;
  /**
   * Online customers who joined the waitlist (`booking_waitlist_entries`)
   * because their desired slot was full. Surfaced in the Receptionist Center
   * next to the walk-in queue so staff can invite a waiting customer in one
   * tap (sends them the claim link via SMS). Scoped to this salon, from the
   * salon-timezone "today" (`selectedDate`) onward, FIFO by `created_at`.
   * Surfaces `waiting` / `notified` entries (staff invite them) AND
   * recently-`claimed` entries (claimed_at within the last 24h, regardless of
   * booking_date) so staff convert a grabbed slot into a real appointment.
   */
  onlineWaitlist: Array<{
    id: string;
    clientName: string;
    serviceId: string;
    serviceName: string;
    bookingDate: string; // YYYY-MM-DD
    preferredSlotLabel: string | null;
    phone: string;
    status: string; // 'waiting' | 'notified' | 'claimed'
    /** When the customer claimed the slot (status='claimed'); null otherwise. */
    claimedAt: string | null;
    /** Staff the freed slot was offered to (`offered_staff_id`), when a concrete
     *  slot was freed; null otherwise. Lets "Tạo lịch" prefill the freed tech so
     *  the manual path matches what auto-book would have done. */
    offeredStaffId: string | null;
    createdAt: string;
  }>;
  bookingsForDay: Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    /** For the staff-action notify panel: is the Email channel offerable? */
    client_email: string | null;
    /** Site language captured at online-booking time; drives the notify
     *  preview locale (null for desk-created → salon default / English). */
    client_locale: string | null;
    client_notes: string | null;
    staff_id: string;
    start_time_utc: string;
    end_time_utc: string;
    status: BookingStatus;
    source: BookingSource;
    /** Raw source channel ("voice" | "online" | "phone" | "walkin" |
     * "appointment" | …) preserved for the compact source icon. */
    source_channel: string | null;
    /** When this booking was CREATED (not the appointment time). Drives the
     * drawer "Đặt lúc / Booked" line so the desk sees when + via which channel
     * the booking was placed. */
    created_at: string | null;
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
    /** All add-ons on this booking (from `booking_addons`). Empty when none.
     *  `concurrent` = runs during the main service (+0 time). */
    addons: {
      name: string;
      price_cents: number | null;
      duration_minutes: number;
      concurrent: boolean;
    }[];
    /** Client's lifetime no-show count (cross-salon, phone-keyed). 0 = clean. */
    client_no_show_count: number;
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
    /**
     * Booking carries a non-empty `staff_request_note` ("requests
     * Tuong Vy", "wants the same staff as last time", etc.). Surfaces
     * a heart icon on the booking block so the receptionist sees the
     * request preference without opening the drawer.
     */
    has_staff_request: boolean;
    /** Group-booking marker (migration 20260512200000). Non-null
     * UUID means this booking is part of a multi-member group;
     * UI renders a 👥 indicator and the drawer surfaces group
     * context. */
    group_id: string | null;
    group_size: number | null;
    /** Couple/group "seat next to each other" preference (migration
     * 20260607100000). True → reception sets up adjacent beds + shared
     * curtain; UI renders a 💕 badge on the booking block. */
    seat_together: boolean;
    /** Smart verification method used (none/otp/deposit/vip_skip). Null = old bookings. */
    verification_method: string | null;
    /** When SMS confirmation was sent to this customer. Null = not sent or failed. */
    sms_confirmation_sent_at: string | null;
    /** Non-null when SMS failed — reception should see warning badge. */
    sms_confirmation_failed_at: string | null;
    /** No-show risk score 0-100. Higher = more likely to no-show. */
    no_show_risk_score: number | null;
    /** Deposit lifecycle (required/paid/waived/...). Null = no deposit on this booking. */
    deposit_status: string | null;
    /** Deposit amount in cents (paid via Square). Drives the checkout "remaining" line. */
    deposit_amount_cents: number | null;
    /** Wix booking id if this booking was synced from Wix. Drives the desk Approve/Decline
     * buttons on a Wix-origin pending card (status='pending' + non-null here). */
    wix_booking_id: string | null;
    /** Square card-on-file saved for this booking's no-show fee. Non-null →
     * the desk's no-show action offers a "charge $X / waive" choice. */
    noshow_card_id: string | null;
    /** Fee (cents) that would be collected if this booking no-shows. Set when a
     * card was saved at booking time (risk-gated). */
    noshow_fee_cents: number | null;
    /** No-show fee lifecycle: 'saved' (card on file, uncharged) | 'charged' |
     * 'failed' | 'waived'. Null = no fee on this booking. */
    noshow_charge_status: string | null;
  }>;
  /** Per-staff service whitelist for this salon. `null` = no rows → all-capable fallback. */
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  /**
   * Today's no-show bookings (status `no_show`), surfaced in the "needs
   * attention" strip so a wrongly-flagged guest can be undone in one tap.
   * Separate from `bookingsForDay` (which only carries active statuses).
   */
  noShowsToday: Array<{
    id: string;
    clientName: string;
    startTimeUtc: string;
    /** Service end (for the grid tombstone's span/position). */
    endTimeUtc: string;
    serviceName: string;
    staffName: string | null;
    /** Staff row the no-show belonged to — places the tombstone in the grid. */
    staffId: string | null;
    /** No-show fee (cents) on file, if a card was saved. Null = none. */
    feeCents: number | null;
    /** Fee lifecycle: 'saved'|'charged'|'failed'|'waived' | null. */
    chargeStatus: string | null;
    /** True when a Square card is on file (a fee can still be collected). */
    hasCard: boolean;
  }>;
  /**
   * Top services by booking frequency on the selected day, ordered by count
   * (descending). Up to 3 ids. Empty when fewer than 2 bookings exist (the
   * "popular" signal is meaningless on a near-empty day). Computed from the
   * already-loaded `bookingsForDay` so no extra query is required.
   */
  popularServiceIds: string[];
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
   * Salon-wide UI density (Simple ↔ Balanced ↔ Pro). Orthogonal to
   * preset + modules; tunes visual rhythm only (block min height,
   * label visibility, slot height) per `dashboardDensity.ts`.
   */
  dashboardDensity: DensityLevel;
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
  /**
   * Pre-fetched salon row from `getDashboardWriteClient`. When the
   * caller already has the salon row in hand (the only real caller is
   * `/dashboard/[slug]/center/page.tsx`), passing it here lets the
   * loader skip its own `salons` SELECT — saving one Vercel→Supabase
   * round-trip per page load. The loader still uses the caller's
   * supabase client for the remaining queries (staff / services /
   * queue / bookings / capabilities).
   *
   * Must carry the dashboard-config fields (`timezone`,
   * `dashboard_modules`, `dashboard_preset`, `dashboard_density`,
   * `currency_code`) so the loader can derive its outputs without a
   * second fetch. `resolveSalonForDashboard`'s expanded SELECT
   * (PR — perf/center-eliminate-triple-salon-fetch) gathers these
   * up front.
   */
  preFetchedSalon?: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    dashboard_modules: unknown | null;
    dashboard_preset: unknown | null;
    dashboard_density: unknown | null;
    currency_code: unknown | null;
    walkin_auto_assign?: unknown | null;
    opening_hours?: unknown | null;
  };
};

const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "HH:MM" → minutes from midnight, or null when malformed. */
function hmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return Math.min(23, Math.max(0, h)) * 60 + Math.min(59, Math.max(0, min));
}

/**
 * Resolve the salon's open/close minutes for a given calendar day (YYYY-MM-DD)
 * from `salons.opening_hours`. Returns {null, null} when closed/unset/unparseable
 * — the timeline grid then falls back to its default window. Weekday is derived
 * from the calendar date itself (no timezone shift: a YYYY-MM-DD names one day).
 */
function openingHoursForDay(
  rawOpeningHours: unknown,
  dateYmd: string,
): { openMinutes: number | null; closeMinutes: number | null } {
  const week = parseOpeningHours(rawOpeningHours);
  if (!week) return { openMinutes: null, closeMinutes: null };
  const utcDay = new Date(`${dateYmd}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const dayKey = DAY_KEYS[(utcDay + 6) % 7]; // shift so Monday=0
  const day = week[dayKey];
  if (!day || day.closed) return { openMinutes: null, closeMinutes: null };
  const openMinutes = hmToMinutes(day.open);
  const closeMinutes = hmToMinutes(day.close);
  if (openMinutes === null || closeMinutes === null || closeMinutes <= openMinutes) {
    return { openMinutes: null, closeMinutes: null };
  }
  return { openMinutes, closeMinutes };
}
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

  // Perf — when the caller already has the salon row (the
  // /center page route now does, since `resolveSalonForDashboard`
  // SELECTs everything we need in one go), skip the dedicated
  // salons fetch. Smoke tests and any other caller that doesn't
  // pre-fetch still hit the original query path.
  type SalonShape = {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    dashboard_modules?: unknown;
    dashboard_preset?: unknown;
    dashboard_density?: unknown;
    currency_code?: unknown;
    walkin_auto_assign?: unknown;
    queue_display_mode?: unknown;
    basic_mode_forced?: unknown;
    opening_hours?: unknown;
  };
  let salonData: SalonShape | null;
  if (deps?.preFetchedSalon) {
    salonData = {
      id: deps.preFetchedSalon.id,
      name: deps.preFetchedSalon.name,
      slug: deps.preFetchedSalon.slug,
      timezone: deps.preFetchedSalon.timezone,
      dashboard_modules: deps.preFetchedSalon.dashboard_modules,
      dashboard_preset: deps.preFetchedSalon.dashboard_preset,
      dashboard_density: deps.preFetchedSalon.dashboard_density,
      currency_code: deps.preFetchedSalon.currency_code,
      walkin_auto_assign: deps.preFetchedSalon.walkin_auto_assign,
      // Carried so the /center route (which pre-fetches the salon) honors
      // forced Basic Mode without a second salons query.
      basic_mode_forced: (deps.preFetchedSalon as { basic_mode_forced?: unknown })
        .basic_mode_forced,
      // Drives the timeline grid's default window on booking-free days.
      // SALON_DASHBOARD_SELECT already fetches opening_hours, so no extra query.
      opening_hours: deps.preFetchedSalon.opening_hours,
    };
  } else {
    const salonResult = await supabase
      .from("salons")
      .select(
        // currency_code + walkin_auto_assign added by recent migrations
        // (20260512000000 / 20260511100000) — not in auto-generated
        // types yet, hence the `as never` cast on the SELECT string.
        // basic_mode_forced: auto-enable Basic Mode for receptionist if salon config requires it
        "id, name, slug, timezone, dashboard_modules, dashboard_preset, dashboard_density, currency_code, walkin_auto_assign, queue_display_mode, basic_mode_forced, opening_hours, staff_notification_settings, auto_no_show_minutes" as never,
      )
      .eq("id", ctx.salon.id)
      .maybeSingle();

    if (salonResult.error) {
      console.error("[loadReceptionistCenterData] salons", salonResult.error);
      return { ok: false, error: "server_error" };
    }
    salonData = salonResult.data as SalonShape | null;
  }

  if (!salonData?.id || typeof salonData.timezone !== "string" || salonData.timezone.trim() === "") {
    return { ok: false, error: "salon_not_found" };
  }

  // Square deposits enabled for this salon? Read with the service-role client —
  // square_integrations is RLS-restricted, and deposit_enabled is a non-secret
  // config flag the desk uses to decide whether to show the "request deposit +
  // text link" action (so non-Square salons never get a dead button).
  let depositsEnabled = false;
  try {
    const { data: sqRow } = await createServiceRoleClient()
      .from("square_integrations")
      .select("deposit_enabled")
      .eq("salon_id", ctx.salon.id)
      .maybeSingle();
    depositsEnabled =
      (sqRow as { deposit_enabled?: boolean } | null)?.deposit_enabled === true;
  } catch {
    /* leave false — desk just won't show the deposit action */
  }

  const salonRow = {
    id: salonData.id,
    name: String(salonData.name ?? ""),
    slug: String(salonData.slug ?? ""),
    timezone: salonData.timezone.trim(),
    currencyCode: parseCurrency(salonData.currency_code),
    walkinAutoAssign: salonData.walkin_auto_assign === false ? false : true,
    queueDisplayMode: (salonData.queue_display_mode === "simple" ? "simple" : "full") as "simple" | "full",
    // TODO: Regenerate types when Docker is available (npx supabase gen types typescript --local)
    basicModeForced: (salonData as any).basic_mode_forced === true,
    depositsEnabled,
    ...openingHoursForDay(salonData.opening_hours, dateYmd),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- types not regenerated yet (see basic_mode_forced TODO above)
    staffNotificationSettings: parseStaffNotificationSettings(
      (salonData as any).staff_notification_settings,
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- types not regenerated yet (see basic_mode_forced TODO above)
    autoNoShowMinutes: (() => {
      const v = (salonData as any).auto_no_show_minutes;
      if (v == null) return null;
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
  };

  const rawDashboardModules = parseDashboardModules(
    salonData.dashboard_modules,
  );
  const dashboardPreset = parsePresetKey(salonData.dashboard_preset);
  const dashboardModules = applyPreset(dashboardPreset, rawDashboardModules);
  const dashboardDensity = parseDensityLevel(salonData.dashboard_density);

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
      // Only ACTIVE providers get a grid column — same filter the public
      // booking page + walk-in assign use. `inactive`/`pending` rows (e.g.
      // receptionists added via addTeamMember with takesBookings=false, or
      // temporarily-off therapists) stay in the Team page but never clutter
      // the operational timeline (they aren't bookable anyway).
      .select("id, name, job_role, status")
      .eq("salon_id", ctx.salon.id)
      .eq("status", "active")
      .is("deleted_at" as never, null)
      .order("created_at", { ascending: true }),
    supabase
      .from("services")
      .select(
        "id, name, duration_minutes, buffer_minutes, price_cents, price_type, price_max_cents, created_at",
      )
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null)
      .order("created_at", { ascending: true }),
    supabase
      .from("bookings")
      .select(
        `
      id,
      client_name,
      client_phone,
      service_id,
      staff_id,
      staff_request_note,
      staff_requested_by_client,
      soft_hold_until,
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
      client_email,
      client_locale,
      client_notes,
      staff_request_note,
      staff_requested_by_client,
      staff_id,
      start_time_utc,
      end_time_utc,
      status,
      source,
      booking_channel,
      created_at,
      service_id,
      price_cents,
      joined_queue_at,
      walkin_source,
      addon_service_id,
      addon_price_cents,
      group_id,
      group_size,
      seat_together,
      verification_method,
      sms_confirmation_sent_at,
      sms_confirmation_failed_at,
      no_show_risk_score,
      deposit_status,
      deposit_amount_cents,
      wix_booking_id,
      noshow_card_id,
      noshow_fee_cents,
      noshow_charge_status,
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

  const staffRows = staffResult.data as unknown as Array<{
    id: string;
    name: string;
    job_role: string;
    status: string | null;
  }> | null;

  const serviceRows = servicesResult.data as unknown as Array<{
    id: string;
    name: string;
    duration_minutes: number;
    buffer_minutes: number;
    price_cents: number;
    price_type: string | null;
    price_max_cents: number | null;
    created_at: string | null;
  }> | null;

  const queueRows = queueResult.data as unknown as Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    service_id: string;
    staff_id: string | null;
    staff_request_note: string | null;
    staff_requested_by_client: boolean | null;
    soft_hold_until: string | null;
    joined_queue_at: string | null;
    walkin_source?: unknown;
    walkin_priority?: unknown;
    walkin_request_tags?: unknown;
    party_size?: unknown;
    services: ServiceJoinMinimal | ServiceJoinMinimal[] | null;
  }> | null;

  // Cast through `unknown` because `staff_requested_by_client` isn't
  // in the auto-generated DB types yet (added by the 2026-05-10
  // migration); the Supabase typegen returns a `SelectQueryError`
  // placeholder for unknown columns and the direct `as` cast trips
  // on insufficient-overlap. The runtime shape matches.
  const bookingsRows = bookingsResult.data as unknown as Array<{
    id: string;
    client_name: string;
    client_phone: string | null;
    client_email: string | null;
    client_locale: string | null;
    client_notes: string | null;
    staff_request_note: string | null;
    staff_requested_by_client: boolean | null;
    staff_id: string | null;
    start_time_utc: string | null;
    end_time_utc: string | null;
    status: string;
    source: string | null;
    booking_channel: string | null;
    created_at: string | null;
    service_id: string;
    price_cents: number | null;
    joined_queue_at: string | null;
    walkin_source: string | null;
    addon_service_id: string | null;
    addon_price_cents: number | null;
    services: ServiceJoinMinimal | ServiceJoinMinimal[] | null;
    addon: ServiceJoinMinimal | ServiceJoinMinimal[] | null;
  }> | null;

  const rawQueueRows: Array<{
    row: NonNullable<typeof queueRows>[number];
    svc: ReturnType<typeof serviceFromJoin>;
    spanMin: number;
    partySize: number | null;
  }> = [];

  for (const row of queueRows ?? []) {
    const svc = serviceFromJoin(row.services);
    if (!row.joined_queue_at?.trim()) continue;
    const dRaw = Number(svc?.duration_minutes ?? 0);
    const bRaw = Number(svc?.buffer_minutes ?? 0);
    const d = Number.isFinite(dRaw) ? Math.round(dRaw) : 0;
    const buf = Number.isFinite(bRaw) ? Math.round(bRaw) : 0;
    const spanMin = Math.max(0, serviceBlockMinutes(d, buf));
    const partyRaw = Number(row.party_size);
    const partySize =
      Number.isFinite(partyRaw) && partyRaw >= 1 && partyRaw <= 50
        ? Math.round(partyRaw)
        : null;
    rawQueueRows.push({ row, svc, spanMin, partySize });
  }

  // VIP enrichment — single bulk query against `client_profiles`
  // (global table, salon-agnostic per the schema doc). Phones already
  // stored in normalized digit form, so we lower-noise compare.
  const queuePhones = Array.from(
    new Set(
      rawQueueRows
        .map((r) => (r.row.client_phone ?? "").trim())
        .filter((p) => p.length > 0),
    ),
  );
  const vipByPhone = new Map<string, boolean>();
  if (queuePhones.length > 0) {
    const vipRes = (await supabase
      .from("client_profiles")
      .select("phone, is_vip" as never)
      .in("phone", queuePhones)) as {
      data: Array<{ phone: string; is_vip: boolean | null }> | null;
      error: unknown;
    };
    if (!vipRes.error) {
      for (const r of vipRes.data ?? []) {
        if (r.phone) vipByPhone.set(String(r.phone), r.is_vip === true);
      }
    } else {
      console.error("[loadReceptionistCenterData] vip lookup", vipRes.error);
    }
  }

  // Project per-staff "free at" by looking at the in-progress + confirmed
  // bookings already loaded for the day. Same heuristic the
  // availability engine uses: staff is free at max(end_time_utc) of
  // their in-progress + currently-active confirmed window, floored to
  // "now". We compute it here so each queue card can carry its own
  // ready-at hint without an extra round-trip.
  const nowMsForReady = Date.now();
  const freeAtMsByStaff = new Map<string, number>();
  for (const b of bookingsRows ?? []) {
    const sid = b.staff_id?.trim();
    if (!sid) continue;
    const endMs = b.end_time_utc ? Date.parse(b.end_time_utc) : NaN;
    if (!Number.isFinite(endMs)) continue;
    if (b.status !== "in_progress" && b.status !== "confirmed") continue;
    const prev = freeAtMsByStaff.get(sid) ?? 0;
    if (endMs > prev) freeAtMsByStaff.set(sid, endMs);
  }

  // Resolve requested staff name from `staff_id` when present (the
  // assign-to-specific-staff path sets staff_id even before the
  // booking flips out of `waiting`). When absent but the receptionist
  // wrote a free-text note, we keep the heart line but leave the
  // name null so the card just reads "❤️ Yêu cầu thợ này".
  const staffNameById = new Map<string, string>();
  for (const s of staffRows ?? []) {
    if (s.id) staffNameById.set(s.id, String(s.name ?? "").trim());
  }

  const walkinQueue: ReceptionistCenterData["walkinQueue"] = rawQueueRows.map(
    ({ row, svc, spanMin, partySize }) => {
      const phone = (row.client_phone ?? "").trim();
      const requestedStaffId = row.staff_id?.trim() || null;
      const freeAtMs = requestedStaffId
        ? freeAtMsByStaff.get(requestedStaffId) ?? null
        : null;
      const readyAtMs = freeAtMs == null ? null : Math.max(freeAtMs, nowMsForReady);
      return {
        id: row.id,
        client_name: row.client_name,
        client_phone: row.client_phone ?? null,
        service_id: row.service_id,
        service_name: svc?.name ?? "—",
        service_duration_minutes: spanMin,
        staff_request_note: row.staff_request_note ?? null,
        staff_requested_by_client:
          row.staff_requested_by_client === true ||
          (typeof row.staff_request_note === "string" &&
            row.staff_request_note.trim().length > 0),
        requested_staff_name: requestedStaffId
          ? staffNameById.get(requestedStaffId) ?? null
          : null,
        requested_staff_ready_at_iso:
          readyAtMs != null ? new Date(readyAtMs).toISOString() : null,
        is_vip: phone ? vipByPhone.get(phone) === true : false,
        soft_hold_until: row.soft_hold_until ?? null,
        joined_queue_at: row.joined_queue_at!,
        walkin_source: isQueueSource(row.walkin_source)
          ? row.walkin_source
          : null,
        walkin_priority: isQueuePriority(row.walkin_priority)
          ? row.walkin_priority
          : null,
        walkin_request_tags: parseRequestTags(row.walkin_request_tags),
        party_size: partySize,
      };
    },
  );

  // Apply server-side priority sort. Ordered:
  //   1. VIP customers first
  //   2. Anyone waiting > 20 min (longest first within this band)
  //   3. Customers whose requested staff is free now
  //   4. FIFO joined_queue_at for the rest
  sortQueueByPriority(walkinQueue, nowMsForReady);

  // Itemized add-ons for the day's bookings. `booking_addons` is RLS-locked
  // (writes via SECURITY DEFINER RPC), so read with the service-role client,
  // scoped to this salon's booking ids (already salon-filtered above).
  const addonsByBooking = new Map<
    string,
    { name: string; price_cents: number | null; duration_minutes: number; concurrent: boolean }[]
  >();
  // Lifetime no-show count per client (client_profiles is global, phone-keyed).
  const noShowByPhone = new Map<string, number>();
  // Today's no-shows (separate from the active grid statuses).
  const noShowsToday: ReceptionistCenterData["noShowsToday"] = [];
  // Online waitlist (booking_waitlist_entries) for the Receptionist Center
  // panel. Service name resolved from the already-loaded catalog (no extra
  // join). Populated in the concurrent enrichment block below; falls back to
  // [] on any error so a waitlist hiccup never breaks the RC load.
  const onlineWaitlist: ReceptionistCenterData["onlineWaitlist"] = [];
  const serviceNameById = new Map<string, string>();
  for (const s of serviceRows ?? []) {
    if (s.id) serviceNameById.set(String(s.id), String(s.name ?? ""));
  }
  // These enrichment round-trips are mutually independent (they only need
  // the day's bookings / catalog already in hand) — run them concurrently.
  await Promise.all([
    (async () => {
    const dayBookingIds = (bookingsRows ?? [])
      .map((r) => (r.id != null ? String(r.id) : ""))
      .filter(Boolean);
    if (dayBookingIds.length > 0) {
      try {
        const svc = createServiceRoleClient();
        const { data: addonRows } = await svc
          .from("booking_addons")
          .select(
            "booking_id, name, price_cents, duration_minutes, created_at, service:services!booking_addons_service_id_fkey(addon_timing)",
          )
          .in("booking_id", dayBookingIds)
          .order("created_at", { ascending: true });
        for (const a of (addonRows ?? []) as Array<{
          booking_id: string;
          name: string;
          price_cents: number | null;
          duration_minutes: number | null;
          service: { addon_timing?: unknown } | { addon_timing?: unknown }[] | null;
        }>) {
          const bid = String(a.booking_id);
          const svcJoin = Array.isArray(a.service) ? a.service[0] : a.service;
          const concurrent = svcJoin?.addon_timing === "concurrent";
          const list = addonsByBooking.get(bid) ?? [];
          list.push({
            name: String(a.name ?? ""),
            price_cents: a.price_cents,
            duration_minutes: Math.max(0, Math.round(Number(a.duration_minutes ?? 0))),
            concurrent,
          });
          addonsByBooking.set(bid, list);
        }
      } catch (e) {
        console.error("[loadReceptionistCenterData] booking_addons", e);
      }
    }
    })(),
    (async () => {
    const phones = Array.from(
      new Set(
        (bookingsRows ?? [])
          .map((r) => (r.client_phone ?? "").trim())
          .filter(Boolean),
      ),
    );
    if (phones.length > 0) {
      try {
        const svc = createServiceRoleClient();
        const { data: rows } = await svc
          .from("client_profiles")
          .select("phone, no_show_count")
          .in("phone", phones);
        for (const r of (rows ?? []) as Array<{
          phone: string;
          no_show_count: number | null;
        }>) {
          noShowByPhone.set(
            String(r.phone),
            Math.max(0, Math.round(Number(r.no_show_count) || 0)),
          );
        }
      } catch (e) {
        console.error("[loadReceptionistCenterData] no_show_count", e);
      }
    }
    })(),
    (async () => {
    const { data, error } = await ctx.supabase
      .from("bookings")
      .select(
        "id, client_name, start_time_utc, end_time_utc, staff_id, noshow_fee_cents, noshow_card_id, noshow_charge_status, services!bookings_service_id_fkey(name), staff(name)",
      )
      .eq("salon_id", ctx.salon.id)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc)
      .eq("status", "no_show")
      .order("start_time_utc", { ascending: true });
    if (error) {
      console.error("[loadReceptionistCenterData] no_shows_today", error);
    } else {
      for (const r of (data ?? []) as unknown as Array<{
        id: string;
        client_name: string | null;
        start_time_utc: string;
        end_time_utc: string | null;
        staff_id: string | null;
        noshow_fee_cents: number | null;
        noshow_card_id: string | null;
        noshow_charge_status: string | null;
        services?: { name?: string | null } | null;
        staff?: { name?: string | null } | null;
      }>) {
        const feeCents =
          r.noshow_fee_cents == null || !Number.isFinite(Number(r.noshow_fee_cents))
            ? null
            : Number(r.noshow_fee_cents);
        noShowsToday.push({
          id: String(r.id),
          clientName: r.client_name ?? "",
          startTimeUtc: r.start_time_utc,
          endTimeUtc: r.end_time_utc ?? r.start_time_utc,
          serviceName: r.services?.name ?? "",
          staffName: r.staff?.name ?? null,
          staffId: r.staff_id != null ? String(r.staff_id) : null,
          feeCents,
          chargeStatus:
            typeof r.noshow_charge_status === "string" && r.noshow_charge_status
              ? r.noshow_charge_status
              : null,
          hasCard:
            typeof r.noshow_card_id === "string" && r.noshow_card_id.length > 0,
        });
      }
    }
    })(),
    (async () => {
      // Online waitlist for THIS salon, from the salon-tz "today" (dateYmd ==
      // selectedDate) onward, only actionable statuses, FIFO. Service-role
      // client (booking_waitlist_entries is RLS-locked). Never throws — a
      // failure leaves onlineWaitlist empty so the RC load is unaffected.
      type WlRow = {
        id: string;
        service_id: string | null;
        booking_date: string | null;
        preferred_slot_label: string | null;
        client_name: string | null;
        client_phone: string | null;
        status: string | null;
        claimed_at: string | null;
        offered_staff_id: string | null;
        created_at: string | null;
      };
      const pushWlRow = (r: WlRow) => {
        const serviceId = r.service_id != null ? String(r.service_id) : "";
        const slot =
          typeof r.preferred_slot_label === "string" &&
          r.preferred_slot_label.trim().length > 0
            ? r.preferred_slot_label.trim()
            : null;
        onlineWaitlist.push({
          id: String(r.id),
          clientName: String(r.client_name ?? ""),
          serviceId,
          serviceName: serviceNameById.get(serviceId) ?? "—",
          bookingDate: String(r.booking_date ?? "").slice(0, 10),
          preferredSlotLabel: slot,
          phone: String(r.client_phone ?? ""),
          status: String(r.status ?? "waiting"),
          claimedAt: r.claimed_at ? String(r.claimed_at) : null,
          offeredStaffId: r.offered_staff_id ? String(r.offered_staff_id) : null,
          createdAt: String(r.created_at ?? ""),
        });
      };
      const WL_SELECT =
        "id, service_id, booking_date, preferred_slot_label, client_name, client_phone, status, claimed_at, offered_staff_id, created_at";
      try {
        const svc = createServiceRoleClient();
        // Actionable (waiting / notified) — from selected day onward, FIFO.
        const { data: wlRows, error: wlErr } = await svc
          .from("booking_waitlist_entries")
          .select(WL_SELECT)
          .eq("salon_id", ctx.salon.id)
          .in("status", ["waiting", "notified"])
          .gte("booking_date", dateYmd)
          .order("created_at", { ascending: true })
          .limit(50);
        if (wlErr) {
          console.error("[loadReceptionistCenterData] online_waitlist", wlErr);
        } else {
          for (const r of (wlRows ?? []) as unknown as WlRow[]) pushWlRow(r);
        }

        // Recently claimed (last 24h, any booking_date) — staff must convert
        // these into a real appointment. Sorted claimed_at desc (most recent
        // first). Separate query so the FIFO ordering of waiting/notified is
        // untouched; failure here leaves the actionable list intact.
        const claimedSince = new Date(
          Date.now() - 24 * 60 * 60 * 1000,
        ).toISOString();
        const { data: claimedRows, error: claimedErr } = await svc
          .from("booking_waitlist_entries")
          .select(WL_SELECT)
          .eq("salon_id", ctx.salon.id)
          .eq("status", "claimed")
          .gte("claimed_at", claimedSince)
          .order("claimed_at", { ascending: false })
          .limit(50);
        if (claimedErr) {
          console.error(
            "[loadReceptionistCenterData] online_waitlist_claimed",
            claimedErr,
          );
        } else {
          for (const r of (claimedRows ?? []) as unknown as WlRow[]) {
            pushWlRow(r);
          }
        }
      } catch (e) {
        console.error("[loadReceptionistCenterData] online_waitlist", e);
      }
    })(),
  ]);

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
    // First-class signal (preferred): the new
    // `staff_requested_by_client` boolean. Set on insert by every
    // booking source (online → specific staff chosen, walk-in →
    // checkbox or non-empty note). Note non-empty stays a fallback so
    // any older row that wasn't backfilled still surfaces the heart.
    const hasStaffRequest =
      row.staff_requested_by_client === true ||
      (typeof row.staff_request_note === "string" &&
        row.staff_request_note.trim().length > 0);
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
      client_email: row.client_email ?? null,
      client_locale: row.client_locale ?? null,
      client_notes: row.client_notes ?? null,
      staff_id: staffId,
      start_time_utc: st,
      end_time_utc: en,
      status,
      source,
      // Granular origin channel for the compact source icon — prefer the
      // explicit `booking_channel` (online | square | wix | voice | walkin |
      // desk) so online/Square/Wix/front-desk are distinguishable, falling
      // back to the raw `source` for any legacy row not yet backfilled.
      source_channel:
        typeof row.booking_channel === "string" && row.booking_channel.trim()
          ? row.booking_channel.trim().toLowerCase()
          : typeof row.source === "string" && row.source.trim()
            ? row.source.trim().toLowerCase()
            : null,
      created_at: row.created_at ?? null,
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
      addons: addonsByBooking.get(String(row.id)) ?? [],
      client_no_show_count:
        noShowByPhone.get((row.client_phone ?? "").trim()) ?? 0,
      is_vip: isVip,
      has_notes: hasNotes,
      has_design: hasDesign,
      has_staff_request: hasStaffRequest,
      group_id:
        (row as { group_id?: unknown }).group_id != null
          ? String((row as { group_id?: unknown }).group_id)
          : null,
      group_size: (() => {
        const v = (row as { group_size?: unknown }).group_size;
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })(),
      seat_together: (row as { seat_together?: unknown }).seat_together === true,
      verification_method: (row as { verification_method?: unknown }).verification_method != null
        ? String((row as { verification_method?: unknown }).verification_method)
        : null,
      sms_confirmation_sent_at: (row as { sms_confirmation_sent_at?: unknown }).sms_confirmation_sent_at != null
        ? String((row as { sms_confirmation_sent_at?: unknown }).sms_confirmation_sent_at)
        : null,
      sms_confirmation_failed_at: (row as { sms_confirmation_failed_at?: unknown }).sms_confirmation_failed_at != null
        ? String((row as { sms_confirmation_failed_at?: unknown }).sms_confirmation_failed_at)
        : null,
      no_show_risk_score: (() => {
        const v = (row as { no_show_risk_score?: unknown }).no_show_risk_score;
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })(),
      deposit_status: (row as { deposit_status?: unknown }).deposit_status != null
        ? String((row as { deposit_status?: unknown }).deposit_status)
        : null,
      deposit_amount_cents: (() => {
        const v = (row as { deposit_amount_cents?: unknown }).deposit_amount_cents;
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })(),
      wix_booking_id: (() => {
        const v = (row as { wix_booking_id?: unknown }).wix_booking_id;
        return typeof v === "string" && v.length > 0 ? v : null;
      })(),
      noshow_card_id: (() => {
        const v = (row as { noshow_card_id?: unknown }).noshow_card_id;
        return typeof v === "string" && v.length > 0 ? v : null;
      })(),
      noshow_fee_cents: (() => {
        const v = (row as { noshow_fee_cents?: unknown }).noshow_fee_cents;
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      })(),
      noshow_charge_status: (() => {
        const v = (row as { noshow_charge_status?: unknown })
          .noshow_charge_status;
        return typeof v === "string" && v.length > 0 ? v : null;
      })(),
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
      capabilityRows = ((capRows ?? []) as any).map((r: any) => ({
        staff_id: String(r.staff_id),
        service_id: String(r.service_id),
      }));
    }
  }

  const enrichedStaff = enrichStaffRows(staffRows ?? [], bookingsForDay);

  const popularServiceIds = computePopularServiceIds(bookingsForDay);

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
          // Legacy rows (pre variable-pricing) → default to "fixed".
          price_type:
            typeof s.price_type === "string" && s.price_type.trim().length > 0
              ? s.price_type.trim()
              : "fixed",
          price_max_cents:
            s.price_max_cents != null &&
            Number.isFinite(Number(s.price_max_cents))
              ? Math.round(Number(s.price_max_cents))
              : null,
          created_at: s.created_at,
        })) ?? [],
      walkinQueue,
      onlineWaitlist,
      bookingsForDay,
      noShowsToday,
      capabilityRows,
      popularServiceIds,
      selectedDate: dateYmd,
      dashboardModules,
      dashboardPreset,
      dashboardDensity,
      kpiSnapshot,
    },
  };
}

const COMING_UP_WINDOW_MINUTES = 30;
const POPULAR_SERVICE_MAX = 3;
const POPULAR_SERVICE_MIN_BOOKINGS = 2;

/**
 * Top-N service ids by booking frequency on the selected day. Used by
 * Quick Add to surface shortcut chips that auto-select a service. Returns
 * `[]` when fewer than `POPULAR_SERVICE_MIN_BOOKINGS` bookings exist —
 * the signal is too noisy on near-empty days.
 *
 * Cancelled bookings are still counted: from the receptionist's
 * perspective, "what people asked for today" is the right popularity
 * signal regardless of whether the booking ultimately stuck.
 */
function computePopularServiceIds(
  bookingsForDay: ReceptionistCenterData["bookingsForDay"],
): string[] {
  if (bookingsForDay.length < POPULAR_SERVICE_MIN_BOOKINGS) return [];
  const counts = new Map<string, number>();
  for (const b of bookingsForDay) {
    const id = String(b.service_id ?? "").trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = Array.from(counts.entries())
    .filter(([, n]) => n >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, POPULAR_SERVICE_MAX)
    .map(([id]) => id);
  return ranked;
}

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

  // Next available staff — 4-level sort when multiple staff are tied:
  //   1. Earliest free (from in_progress end times)
  //   2. Latest next upcoming confirmed/pending booking (longer free window)
  //   3. Fewest total bookings today (lighter schedule = more available)
  //   4. Name alphabetical (deterministic, avoids created_at bias)
  // Fixes: Liam (first by created_at) always won even when Jenny/Mai had
  // 0 bookings today — they should always beat a busier colleague.
  let nextAvailableStaff: ReceptionistCenterData["kpiSnapshot"]["nextAvailableStaff"] =
    null;
  if (staff.length > 0) {
    type Candidate = {
      name: string;
      freeMs: number;
      nextBookingStartMs: number;
      totalBookings: number;
    };
    let best: Candidate | null = null;

    for (const s of staff) {
      let staffMaxEndMs = 0;
      let nextBookingStartMs = Number.POSITIVE_INFINITY;
      let totalBookings = 0;

      for (const b of bookingsForDay) {
        if (b.staff_id !== s.id) continue;
        totalBookings++;
        if (b.status === "in_progress") {
          const endMs = Date.parse(b.end_time_utc);
          if (Number.isFinite(endMs) && endMs > staffMaxEndMs) staffMaxEndMs = endMs;
        }
        if (b.status === "confirmed" || b.status === "pending") {
          const startMs = Date.parse(b.start_time_utc);
          if (Number.isFinite(startMs) && startMs > nowMs && startMs < nextBookingStartMs) {
            nextBookingStartMs = startMs;
          }
        }
      }

      const freeMs = Math.max(staffMaxEndMs, nowMs);
      const curr: Candidate = { name: s.name, freeMs, nextBookingStartMs, totalBookings };

      if (!best) { best = curr; continue; }

      // 1. Earlier free wins
      if (freeMs < best.freeMs) { best = curr; continue; }
      if (freeMs > best.freeMs) continue;
      // Tied on freeMs — apply secondary sorts only when both are "free now"
      if (freeMs !== nowMs) continue;

      // 2. Later next booking = longer free window
      if (nextBookingStartMs > best.nextBookingStartMs) { best = curr; continue; }
      if (nextBookingStartMs < best.nextBookingStartMs) continue;

      // 3. Fewer total bookings today = lighter schedule
      if (totalBookings < best.totalBookings) { best = curr; continue; }
      if (totalBookings > best.totalBookings) continue;

      // 4. Alphabetical name (deterministic)
      if (s.name < best.name) best = curr;
    }

    if (best) {
      nextAvailableStaff = {
        name: best.name,
        minutesUntilFree: Math.max(0, Math.round((best.freeMs - nowMs) / 60_000)),
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


/**
 * Server-side queue sort with operational priority. Mutates in place
 * for cheap allocation in the hot loader path; callers may treat the
 * input array as the canonical FIFO list and let this rewrite the
 * order for dispatch-board rendering.
 *
 * Ordering bands (highest priority first):
 *   1. VIP customers (`is_vip` from client_profiles).
 *   2. Anyone waiting longer than the danger threshold (20 min) —
 *      the > 20 min protection prevents starvation when many newer
 *      VIPs join.
 *   3. Customers whose requested staff is free right now (the heart
 *      ❤️-line is the operational signal were honouring).
 *   4. FIFO `joined_queue_at` for everyone else.
 *
 * Within each band the older `joined_queue_at` wins.
 */
const QUEUE_LONG_WAIT_DANGER_MS = 20 * 60 * 1000;

export function sortQueueByPriority<
  T extends {
    is_vip: boolean;
    joined_queue_at: string;
    requested_staff_name: string | null;
    requested_staff_ready_at_iso: string | null;
  },
>(queue: T[], nowMs: number): T[] {
  function band(item: T): number {
    if (item.is_vip) return 0;
    const joinedMs = Date.parse(item.joined_queue_at);
    if (
      Number.isFinite(joinedMs) &&
      nowMs - joinedMs >= QUEUE_LONG_WAIT_DANGER_MS
    ) {
      return 1;
    }
    if (item.requested_staff_name) {
      const readyMs = item.requested_staff_ready_at_iso
        ? Date.parse(item.requested_staff_ready_at_iso)
        : NaN;
      if (Number.isFinite(readyMs) && readyMs <= nowMs) return 2;
    }
    return 3;
  }
  queue.sort((a, b) => {
    const ba = band(a);
    const bb = band(b);
    if (ba !== bb) return ba - bb;
    const aMs = Date.parse(a.joined_queue_at);
    const bMs = Date.parse(b.joined_queue_at);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
    return 0;
  });
  return queue;
}
