"use server";

import { cookies } from "next/headers";
import { isOwner, isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { type ActorRole, logBookingEvent } from "@/shared/dashboard/auditLog";
import { sendReviewRequest } from "@/shared/dashboard/sendReviewRequest";
import { completeReferral } from "@/shared/referrals/completeReferral";
import {
  NAILQ_DEMO_SLUG_COOKIE,
} from "@/shared/lib/demoDashboardCookie";
import {
  DEMO_SALON_SLUG,
  isDemoOtpRuntime,
  isDemoSlugPinBypassed,
} from "@/shared/lib/demoOtpMode";
import {
  canChangeBookingStatus,
  normalizeSalonMemberRole,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";
import { isOpeningHoursCustomized } from "@/shared/dashboard/openingHoursDefaults";
import {
  DASHBOARD_BOOKING_SELECT,
  mapDashboardBookingRow,
  type BookingRowDb,
} from "@/shared/dashboard/dashboardBookingMap";
import {
  finalizeDashboardModules,
  parseDashboardModules,
  validateOwnerDashboardModulePatch,
  type DashboardModulesConfig,
} from "@/shared/dashboard/dashboardModules";
import {
  isPresetKey,
  type PresetKey,
} from "@/shared/dashboard/dashboardPresets";
import {
  isDensityLevel,
  type DensityLevel,
} from "@/shared/dashboard/dashboardDensity";
import type { BookingStatus, SalonDashboardBooking } from "@/shared/types";
import { ACTIVE_GRID_STATUSES } from "@/shared/types";

/** Single source of truth for the salon row shape every dashboard
 *  surface needs. Adding `timezone` + dashboard config fields here
 *  closes the triple-fetch perf bug on `/dashboard/[slug]/center`
 *  where `page.tsx` and `loadReceptionistCenterData` were each
 *  re-fetching `salons` with overlapping fields. The select is one
 *  string sent to PostgREST so extra columns are essentially free.
 *
 *  `currency_code` is cast through `as never` at SELECT-site only
 *  in `loadReceptionistCenterData` because the migration that adds
 *  the column hadn't been regenerated into `database.types.ts` yet
 *  at the time of writing; the column itself exists. Here we read
 *  the value through `as { … }` casts at the call site instead. */
const SALON_DASHBOARD_SELECT =
  "id, name, slug, phone, email, address, salon_phone, opening_hours, profile_complete, timezone, dashboard_modules, dashboard_preset, dashboard_density, currency_code, subscription_plan, plan_override, feature_flags, voice_ai_enabled, basic_mode_forced, walkin_auto_assign, queue_display_mode, staff_notification_settings, auto_no_show_minutes, vertical";

type SalonRow = {
  id: string;
  name: string;
  slug: string;
  phone: string;
  email: string | null;
  address: string | null;
  salon_phone: string | null;
  opening_hours: unknown | null;
  profile_complete: boolean;
  booking_closed_dates: unknown | null;
  /** IANA timezone string (e.g. "America/Los_Angeles"). Required by
   *  NOT NULL constraint per migration `20260512600000_timezone_required`. */
  timezone: string;
  /** JSON map of dashboard module flags. Parsed by `parseDashboardModules`
   *  before consumption. Null when never configured. */
  dashboard_modules: unknown | null;
  /** Preset key applied on top of `dashboard_modules`. */
  dashboard_preset: unknown | null;
  /** Density level (compact / cozy / spacious). */
  dashboard_density: unknown | null;
  /** Currency token (CAD / USD / VND). Drives money formatting. */
  currency_code: unknown | null;
  /* ── Release feature-flag inputs (PR1: loaded, not yet enforced) ──
   * Loaded into the dashboard context so `isReleaseFeatureEnabled`
   * (@/shared/features/featureRegistry) can resolve gating without a
   * second round-trip. Optional/nullable — partial contexts resolve to
   * registry defaults. No behavior change in PR1; consumed in PR2+. */
  subscription_plan?: string | null;
  plan_override?: string | null;
  feature_flags?: unknown;
  voice_ai_enabled?: boolean | null;
  /** `salons.basic_mode_forced` — when true, Basic Mode is auto-enabled and
   *  locked for the Receptionist board. Flows to `preFetchedSalon`. */
  basic_mode_forced?: boolean | null;
  walkin_auto_assign?: boolean | null;
  queue_display_mode?: string | null;
  staff_notification_settings?: unknown;
  auto_no_show_minutes?: number | null;
  /** Business vertical slug (e.g. "nail_salon", "head_spa"). */
  vertical?: string | null;
};

async function getSalonViaDemoCookie(slug: string): Promise<SalonRow | null> {
  // Demo cookies grant service-role-backed dashboard access. Honored ONLY
  // when demo OTP mode is on (dev/test). Production with `DEMO_OTP=false`
  // returns null here, keeping the prod B-01/B-02 attack surface closed.
  //
  // Slug pin (re-introduced after PR #16): the cookie ONLY grants access
  // to `DEMO_SALON_SLUG`. PR #16 forces every demo registration to that
  // slug, so a non-`demo-salon` cookie value cannot arise from the
  // legitimate flow. Pin prevents the cookie from being abused to access
  // any tenant's dashboard via service-role bypass.
  //
  // 🚨 Test-only bypass: `NAILIQ_TEST_BYPASS_SLUG_PIN=1` falls back to the
  // pre-PR #16 cookie===slug match. NEVER set on Vercel production.
  if (!isDemoOtpRuntime()) return null;

  const cookieStore = await cookies();
  const demoSlug = cookieStore.get(NAILQ_DEMO_SLUG_COOKIE)?.value;
  const accepted = isDemoSlugPinBypassed()
    ? Boolean(demoSlug && demoSlug === slug)
    : demoSlug === DEMO_SALON_SLUG && slug === DEMO_SALON_SLUG;
  if (!accepted) return null;

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch {
    return null;
  }

  const { data: salon, error } = await admin
    .from("salons")
    .select(SALON_DASHBOARD_SELECT)
    .eq("slug", slug)
    .maybeSingle();

  if (error || !salon) return null;
  const row = salon as SalonRow & {
    email?: unknown;
    profile_complete?: unknown;
  };
  return {
    ...row,
    address:
      row.address === undefined || row.address === null
        ? null
        : String(row.address).trim() || null,
    salon_phone:
      row.salon_phone === undefined || row.salon_phone === null
        ? null
        : String(row.salon_phone).trim() || null,
    email:
      row.email === undefined || row.email === null
        ? null
        : String(row.email).trim() || null,
    profile_complete: !!row.profile_complete,
    booking_closed_dates:
      (row as { booking_closed_dates?: unknown }).booking_closed_dates ?? null,
  };
}

/** Authorized dashboard viewer (logged-in salon member or demo cookie slug match). */
export async function resolveSalonForDashboard(
  slug: string,
): Promise<
  | {
      salon: SalonRow;
      kind: "member" | "demo_cookie";
      /** `salon_members.role` for this user-salon pair. Demo-cookie path is always `"owner"`. */
      role: SalonMemberRole;
      /**
       * Email on the resolved auth user (e.g. populated by Google OAuth or by
       * Supabase email signup). `null` for phone-only OTP users who never
       * provided one, and for the demo-cookie path (no auth user). Used by
       * the `AddEmailBanner` to suppress the recovery-email nag when the
       * viewer already has an email tied to the auth account.
       */
      viewerEmail: string | null;
      /**
       * Auth user id of the logged-in member, or `null` for the
       * demo-cookie path (no real auth user). Threaded into the audit
       * log so `booking_events.actor_user_id` records who acted.
       */
      viewerUserId: string | null;
    }
  | null
> {
  const memberHit = await getSalonIfMember(slug);
  if (memberHit) {
    return {
      salon: memberHit.salon,
      kind: "member",
      role: memberHit.role,
      viewerEmail: memberHit.viewerEmail,
      viewerUserId: memberHit.viewerUserId,
    };
  }

  const demoSalon = await getSalonViaDemoCookie(slug);
  if (demoSalon) {
    // Demo registration always inserts a `role: "owner"` salon_members row
    // (see `completeSalonRegistrationAction.ts`), so the demo-cookie path
    // can hardcode `"owner"` without re-querying. No auth user → no email.
    return {
      salon: demoSalon,
      kind: "demo_cookie",
      role: "owner",
      viewerEmail: null,
      viewerUserId: null,
    };
  }

  return null;
}

async function getSalonIfMember(
  slug: string,
): Promise<
  | {
      salon: SalonRow;
      role: SalonMemberRole;
      viewerEmail: string | null;
      viewerUserId: string;
    }
  | null
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Auth user's email — may come from Google OAuth, Supabase email signup,
  // or be null/empty for phone-only OTP users. Trim and coerce empty → null
  // so the consumer can `!!viewerEmail`-check without re-trimming.
  const rawAuthEmail =
    typeof user.email === "string" ? user.email.trim() : "";
  const viewerEmail: string | null =
    rawAuthEmail.length > 0 ? rawAuthEmail : null;

  const { data: members, error: memErr } = await supabase
    .from("salon_members")
    .select("salon_id, role")
    .eq("user_id", user.id);

  if (memErr || !members?.length) return null;

  const salonIds = members.map((m) => String(m.salon_id));

  const { data: salon, error: salErr } = await supabase
    .from("salons")
    .select(SALON_DASHBOARD_SELECT)
    .eq("slug", slug)
    .in("id", salonIds)
    .maybeSingle();

  if (salErr || !salon) return null;

  const row = salon as SalonRow & {
    email?: unknown;
    profile_complete?: unknown;
  };

  // Multi-salon: pick the membership row whose `salon_id` matches the salon
  // we just resolved (the URL slug). The earlier `.in("id", salonIds)` already
  // confines `salon` to one of the user's memberships — so a match always
  // exists. Default to "owner" defensively if the row is somehow missing.
  const matched = members.find(
    (m) => String(m.salon_id) === String(row.id),
  );
  const role = normalizeSalonMemberRole(matched?.role);

  return {
    salon: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      phone: row.phone,
      address:
        row.address === undefined || row.address === null
          ? null
          : String(row.address).trim() || null,
      salon_phone:
        row.salon_phone === undefined || row.salon_phone === null
          ? null
          : String(row.salon_phone).trim() || null,
      opening_hours: row.opening_hours ?? null,
      booking_closed_dates:
        (row as { booking_closed_dates?: unknown }).booking_closed_dates ?? null,
      email:
        row.email === undefined || row.email === null
          ? null
          : String(row.email).trim() || null,
      profile_complete: !!row.profile_complete,
      timezone:
        typeof row.timezone === "string" ? row.timezone.trim() : "",
      dashboard_modules: row.dashboard_modules ?? null,
      dashboard_preset: row.dashboard_preset ?? null,
      dashboard_density: row.dashboard_density ?? null,
      currency_code: row.currency_code ?? null,
      // Release feature-flag inputs (PR1: carried in context, not yet enforced).
      subscription_plan: row.subscription_plan ?? null,
      plan_override: row.plan_override ?? null,
      feature_flags: row.feature_flags ?? null,
      voice_ai_enabled:
        typeof row.voice_ai_enabled === "boolean"
          ? row.voice_ai_enabled
          : null,
      basic_mode_forced: row.basic_mode_forced === true,
      walkin_auto_assign: row.walkin_auto_assign ?? null,
      queue_display_mode: row.queue_display_mode ?? null,
      staff_notification_settings: row.staff_notification_settings ?? null,
      auto_no_show_minutes: row.auto_no_show_minutes ?? null,
    },
    role,
    viewerEmail,
    // Auth user id of the logged-in member — threaded into the audit log
    // so `booking_events.actor_user_id` records WHO performed a desk action.
    viewerUserId: user.id,
  };
}

export type LoadSalonDashboardResult =
  | {
      ok: true;
      salon: {
        id: string;
        name: string;
        slug: string;
        phone: string;
        email: string | null;
        address: string | null;
        salon_phone: string | null;
        opening_hours: unknown | null;
        profile_complete: boolean;
        vertical: string | null;
      };
      setup: {
        services_count: number;
        staff_count: number;
        opening_hours_customized: boolean;
      };
      demoMode: boolean;
      /**
       * Caller's `salon_members.role` for this salon. Multi-role login uses
       * this to gate UI (e.g. owner-only sections). Phase 1: exposed to
       * dashboard UI but not yet consumed for visual gating.
       */
      role: SalonMemberRole;
      /**
       * Email on the resolved auth user (Google OAuth, Supabase email
       * signup, etc.). `null` for phone-only OTP users and demo-cookie path.
       * The `AddEmailBanner` suppresses itself when this is non-null even
       * if `salon.email` is empty — the user already has a recovery email
       * via their auth provider.
       */
      viewerEmail: string | null;
      /** Bookings in a wide UTC window; client splits "today" / "upcoming" in local timezone */
      allBookings: SalonDashboardBooking[];
    }
  | { ok: false; error: "unauthorized" | "server_error" };

export async function loadSalonOwnerDashboard(
  slug: string,
): Promise<LoadSalonDashboardResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) {
    return { ok: false, error: "unauthorized" };
  }

  const { salon, kind, role, viewerEmail } = resolved;
  const demoMode = kind === "demo_cookie";

  const supabase =
    kind === "demo_cookie"
      ? createServiceRoleClient()
      : await createClient();

  const from = new Date();
  from.setDate(from.getDate() - 3);
  from.setHours(0, 0, 0, 0);
  const to = new Date();
  to.setDate(to.getDate() + 7);
  to.setHours(23, 59, 59, 999);

  const { data: bookingRows, error: bookingsErr } = await supabase
    .from("bookings")
    .select(DASHBOARD_BOOKING_SELECT)
    .eq("salon_id", salon.id)
    /** Excludes `waiting` (walk-in queue) and `cancelled`; keeps `completed` for today stats. */
    .in("status", ACTIVE_GRID_STATUSES)
    .gte("start_time_utc", from.toISOString())
    .lte("start_time_utc", to.toISOString())
    .order("start_time_utc", { ascending: true });

  if (bookingsErr) {
    console.error("[loadSalonOwnerDashboard] bookings", bookingsErr);
    return { ok: false, error: "server_error" };
  }

  const allBookings = (bookingRows ?? []).map((r) =>
    mapDashboardBookingRow(r as unknown as BookingRowDb),
  );

  // Setup-checklist counts — soft-deleted services/staff don't count
  // toward "profile complete".
  const { count: servicesCount, error: scErr } = await supabase
    .from("services")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salon.id)
    .is("deleted_at" as never, null);

  const { count: staffCount, error: stErr } = await supabase
    .from("staff")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salon.id)
    .is("deleted_at" as never, null);

  if (scErr || stErr) {
    console.error("[loadSalonOwnerDashboard] counts", scErr ?? stErr);
    return { ok: false, error: "server_error" };
  }

  const openingHoursCustomized = isOpeningHoursCustomized(
    salon.opening_hours,
  );

  return {
    ok: true,
    salon: {
      id: salon.id,
      name: salon.name,
      slug: salon.slug,
      phone: salon.phone,
      email:
        salon.email === undefined || salon.email === null
          ? null
          : String(salon.email).trim() || null,
      address: salon.address ?? null,
      salon_phone: salon.salon_phone ?? null,
      opening_hours: salon.opening_hours ?? null,
      profile_complete: !!salon.profile_complete,
      vertical: typeof salon.vertical === "string" ? salon.vertical : null,
    },
    setup: {
      services_count: servicesCount ?? 0,
      staff_count: staffCount ?? 0,
      opening_hours_customized: openingHoursCustomized,
    },
    demoMode,
    role,
    viewerEmail,
    allBookings,
  };
}

export type UpdateBookingStatusResult =
  | { ok: true }
  | {
      ok: false;
      error: "unauthorized" | "not_found" | "invalid_transition" | "server_error";
    };

export async function updateBookingStatus(
  bookingId: string,
  nextStatus: BookingStatus,
  slug: string,
): Promise<UpdateBookingStatusResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) {
    return { ok: false, error: "unauthorized" };
  }

  // Front-desk role gate. Previously ANY member (incl. view-only nail_tech)
  // could flip a booking to in_progress/completed — an ungated path that let
  // a test-click wrongly close a Hi-Lite appointment. Mirror the no-show /
  // desk-booking permission set (owner/admin/senior/receptionist). Demo-cookie
  // path resolves to role "owner" so it still passes.
  if (!canChangeBookingStatus(resolved.role)) {
    return { ok: false, error: "unauthorized" };
  }

  const { salon, kind } = resolved;
  const supabase =
    kind === "demo_cookie"
      ? createServiceRoleClient()
      : await createClient();

  const { data: row, error: fetchErr } = await supabase
    .from("bookings")
    .select("id, status, salon_id, client_phone")
    .eq("id", bookingId)
    .maybeSingle();

  if (fetchErr || !row || String(row.salon_id) !== salon.id) {
    return { ok: false, error: "not_found" };
  }

  const cur = String(row.status) as BookingStatus;
  const toInProgress =
    nextStatus === "in_progress" &&
    (cur === "pending" || cur === "confirmed");

  const allowed =
    (cur === "pending" && nextStatus === "confirmed") ||
    (cur === "confirmed" && nextStatus === "completed") ||
    (cur === "in_progress" && nextStatus === "completed") ||
    toInProgress;

  if (!allowed) {
    return { ok: false, error: "invalid_transition" };
  }

  const startedAt = new Date().toISOString();
  const patch: {
    status: BookingStatus;
    started_at?: string;
    no_show_candidate_at: null;
  } = toInProgress
    ? {
        status: "in_progress",
        started_at: startedAt,
        no_show_candidate_at: null,
      }
    : { status: nextStatus, no_show_candidate_at: null };

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update(patch)
    .eq("id", bookingId)
    .eq("salon_id", salon.id)
    .eq("status", cur)
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[updateBookingStatus]", upErr);
    return { ok: false, error: "server_error" };
  }

  if (!updated?.id) {
    return { ok: false, error: "invalid_transition" };
  }

  void logBookingEvent({
    bookingId,
    salonId: salon.id,
    // Null on the demo-cookie path (no real auth user); the member path
    // records the acting user so a desk status change is attributable.
    actorUserId: resolved.viewerUserId,
    actorRole: (kind === "demo_cookie"
      ? "demo_cookie"
      : (resolved.role as ActorRole)) satisfies ActorRole,
    eventType: "booking_status_changed",
    payload: { from: cur, to: nextStatus },
  });

  if (nextStatus === "completed") {
    // Auto review request (Pro+) — fire-and-forget.
    void sendReviewRequest(bookingId);

    // Referral reward — if this booking was booked via a referral code, issue
    // both vouchers + email them now (fire-and-forget, idempotent no-op otherwise).
    void completeReferral(bookingId);

    // Auto loyalty voucher — if trigger set rewards_earned > rewards_redeemed,
    // issue the voucher from app layer (fire-and-forget).
    const clientPhone = String((row as { client_phone?: unknown }).client_phone ?? "").trim();
    if (clientPhone) {
      void import("@/shared/loyalty/loyaltyActions").then(({ issueLoyaltyVoucherIfEarned }) =>
        issueLoyaltyVoucherIfEarned(salon.id, clientPhone),
      );
    }
  }

  return { ok: true };
}

export type OwnerSalonSummary = {
  id: string;
  name: string;
  slug: string;
  role: SalonMemberRole;
};

/**
 * Returns every salon the current auth user owns, as `{id, name, slug,
 * role}`. Used by the dashboard sidebar to render the salon switcher in
 * the footer when the user has more than one owner-membership.
 *
 * Owner-only by design: switcher is currently a power-tool for
 * multi-salon owners. Other roles (`senior`, `nail_tech`) typically
 * belong to a single salon — the cleaner cross-tenant flow for them is
 * `/choose-salon`. The `slug` arg is part of the call signature for
 * symmetry with other dashboard actions but is not required to scope
 * the query (membership lookup is auth-bound to the current user).
 *
 * Returns `[]` for unauthenticated callers, demo-cookie viewers (no
 * auth user), and users with no owner memberships.
 */
export async function loadOwnerSalons(
  _slug: string,
): Promise<OwnerSalonSummary[]> {
  void _slug;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: members, error: memErr } = await supabase
    .from("salon_members")
    .select("salon_id, role")
    .eq("user_id", user.id)
    .eq("role", "owner");

  if (memErr) {
    console.error("[loadOwnerSalons] members", memErr);
    return [];
  }
  if (!members?.length) return [];

  const salonIds = members.map((m) => String(m.salon_id));

  const { data: salons, error: salErr } = await supabase
    .from("salons")
    .select("id, name, slug")
    .in("id", salonIds);

  if (salErr) {
    console.error("[loadOwnerSalons] salons", salErr);
    return [];
  }
  if (!salons?.length) return [];

  const roleByid = new Map<string, SalonMemberRole>();
  for (const m of members) {
    roleByid.set(String(m.salon_id), normalizeSalonMemberRole(m.role));
  }

  return salons
    .map((s) => ({
      id: String(s.id),
      name: String(s.name ?? "").trim() || String(s.slug ?? ""),
      slug: String(s.slug ?? ""),
      role: roleByid.get(String(s.id)) ?? "owner",
    }))
    .filter((s) => s.slug.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Sign out the current viewer and redirect to /login.
 *
 * Works for every auth method (phone OTP, Google OAuth, email magic link)
 * because Supabase's `signOut()` clears the cookie-based session regardless
 * of how it was obtained. Demo-cookie viewers don't have a Supabase session,
 * so `signOut()` is a no-op for them — but the dashboard hides the button
 * in demo mode anyway (see `SalonOwnerDashboardMain`).
 *
 * `redirect()` throws a Next.js redirect signal; the explicit `return` after
 * it is unreachable but pleases the type checker.
 */
export async function signOutAction(): Promise<never> {
  const supabase = await createClient();
  // Audit BEFORE signOut, while the session (and getUser) is still live.
  await (await import("@/shared/dashboard/recordAuthEvent")).recordAuthEvent({
    event: "logout",
  });
  await supabase.auth.signOut();
  redirect("/login");
}

export type { BookingStatus, SalonDashboardBooking } from "@/shared/types";

export type UpdateDashboardModulesResult =
  | { ok: true; modules: DashboardModulesConfig }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_keys"
        | "server_error";
    };

/**
 * Owner-only: merges validated patch into `salons.dashboard_modules`.
 * Unknown keys are ignored; `queue_panel` stays enabled.
 */
export async function updateDashboardModules(
  slug: string,
  patch: unknown,
): Promise<UpdateDashboardModulesResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    return { ok: false, error: "unauthorized" };
  }
  if (!isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "forbidden" };
  }

  const parsed = validateOwnerDashboardModulePatch(patch);
  if (!parsed.ok) {
    return { ok: false, error: "invalid_keys" };
  }

  const { data: row, error: selErr } = await ctx.supabase
    .from("salons")
    .select("dashboard_modules")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  if (selErr) {
    console.error("[updateDashboardModules] select", selErr);
    return { ok: false, error: "server_error" };
  }

  const current = parseDashboardModules(row?.dashboard_modules);
  const next = finalizeDashboardModules({ ...current, ...parsed.patch });

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ dashboard_modules: next })
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateDashboardModules] update", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, modules: next };
}

export type UpdateDashboardPresetResult =
  | { ok: true; preset: PresetKey }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_preset"
        | "server_error";
    };

/**
 * Owner-only: writes the workspace preset onto `salons.dashboard_preset`.
 * Per-flag `dashboard_modules` overrides are preserved verbatim; the loader
 * merges preset + modules at read time via `applyPreset`.
 */
export async function updateDashboardPreset(
  slug: string,
  preset: PresetKey,
): Promise<UpdateDashboardPresetResult> {
  if (!isPresetKey(preset)) {
    return { ok: false, error: "invalid_preset" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    return { ok: false, error: "unauthorized" };
  }
  if (!isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "forbidden" };
  }

  // `dashboard_preset` is not yet in the auto-generated Supabase types; cast
  // the patch object so .update() accepts the new column. Will become a plain
  // typed call after the next `database.types.ts` regeneration.
  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ dashboard_preset: preset } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateDashboardPreset]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, preset };
}

export type UpdateDashboardDensityResult =
  | { ok: true; density: DensityLevel }
  | {
      ok: false;
      error: "unauthorized" | "forbidden" | "invalid_density" | "server_error";
    };

/**
 * Salon-wide density preference (Simple ↔ Balanced ↔ Pro).
 *
 * Permission: matches the existing `updateDashboardPreset` pattern —
 * owner-only for salon-wide writes. `PERMISSION_MATRIX.md §3` describes
 * "personal preset vs salon-wide preset when distinguished" as a
 * Partial for senior/nail_tech; until product introduces the personal
 * tier, salon-wide writes stay owner-only (conservative default per
 * `ARCHITECTURE_LOCK §6`).
 */
export async function updateDashboardDensity(
  slug: string,
  density: DensityLevel,
): Promise<UpdateDashboardDensityResult> {
  if (!isDensityLevel(density)) {
    return { ok: false, error: "invalid_density" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    return { ok: false, error: "unauthorized" };
  }
  if (!isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "forbidden" };
  }

  // `dashboard_density` may not yet be in the auto-generated Supabase
  // types until the next regeneration — cast keeps the boundary safe.
  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ dashboard_density: density } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateDashboardDensity]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, density };
}



/* ───────────────── Brand color (PR #109) ───────────────── */

export type UpdateBrandColorResult =
  | { ok: true; brandColor: string }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_color"
        | "server_error";
    };

/**
 * Member-gated: writes `salons.brand_color`. Color must be a 6-digit
 * hex literal (e.g. `#D4AF37`) — `isValidBrandColor` mirrors the DB
 * CHECK constraint so we reject the bad value before the round-trip.
 *
 * Open to any salon member (not owner-only) so a senior reception
 * rebrand isn't blocked by an absent owner. The role gate could be
 * tightened later via `canEditBrand` if PM asks.
 */
export async function updateBrandColor(
  slug: string,
  color: string,
): Promise<UpdateBrandColorResult> {
  const { isValidBrandColor } = await import("@/shared/lib/brandColor");
  if (!isValidBrandColor(color)) {
    return { ok: false, error: "invalid_color" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  // Cast: `brand_color` is not yet in the auto-generated Supabase
  // types until the next regeneration.
  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ brand_color: color.trim().toUpperCase() } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateBrandColor]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, brandColor: color.trim().toUpperCase() };
}

/* ───────────────── Theme mode (light / dark booking page) ───────────────── */

export type UpdateThemeModeResult =
  | { ok: true; themeMode: "dark" | "light" }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_mode" | "server_error" };

/**
 * Member-gated: writes `salons.theme_mode`. Mirrors the DB CHECK
 * constraint — only `"dark"` or `"light"` are accepted.
 *
 * Open to any salon member (matches `updateBrandColor` permission
 * scope) so a senior reception can flip the booking page theme
 * without an owner present.
 */
export async function updateSalonThemeMode(
  slug: string,
  themeMode: "dark" | "light",
): Promise<UpdateThemeModeResult> {
  if (themeMode !== "dark" && themeMode !== "light") {
    return { ok: false, error: "invalid_mode" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  // Cast: `theme_mode` is not yet in the auto-generated Supabase
  // types until the next regeneration.
  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ theme_mode: themeMode } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateSalonThemeMode]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, themeMode };
}

/* ─────────────────── Voice AI persona name ─────────────────── */

export type UpdateVoiceAiPersonaNameResult =
  | { ok: true; personaName: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_name" | "server_error" };

/**
 * Owner-only: updates `salons.voice_ai_persona_name`.
 * Max 40 chars, letters/spaces/hyphens only so the name is safe to
 * embed in a spoken system prompt.
 */
export async function updateVoiceAiPersonaName(
  slug: string,
  name: string,
): Promise<UpdateVoiceAiPersonaNameResult> {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed || !/^[\p{L}\p{M}\s\-'.]+$/u.test(trimmed)) {
    return { ok: false, error: "invalid_name" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ voice_ai_persona_name: trimmed } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateVoiceAiPersonaName]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, personaName: trimmed };
}

/* ───────────── Business vertical (Phase 1) ───────────── */

export type UpdateSalonVerticalResult =
  | { ok: true; vertical: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_vertical" | "server_error" };

/**
 * Owner-only: writes `salons.vertical`. Drives the schema.org type, AI prompt
 * descriptors, staff-role label, hero tagline, and seed catalogue via the
 * vertical registry. Validated against the known registry slugs so the column
 * never receives an unrenderable value.
 */
export async function updateSalonVertical(
  slug: string,
  vertical: string,
): Promise<UpdateSalonVerticalResult> {
  const { isKnownVertical } = await import("@/shared/verticals/registry");
  const normalized = String(vertical ?? "").trim().toLowerCase();
  if (!isKnownVertical(normalized)) {
    return { ok: false, error: "invalid_vertical" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwner(ctx.role)) return { ok: false, error: "forbidden" };

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ vertical: normalized } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateSalonVertical]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, vertical: normalized };
}

/* ───────────── Win-back email (opt-out) ───────────── */

export type UpdateWinBackResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

/** Owner-only: toggles `salons.winback_enabled` (friendly rebook email after a
 *  no-show). Default true. */
export async function updateWinBackEnabled(
  slug: string,
  enabled: boolean,
): Promise<UpdateWinBackResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("salons")
    .update({ winback_enabled: enabled } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateWinBackEnabled]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, enabled };
}

/* ───────────── Auto no-show (opt-in) ───────────── */

export type UpdateAutoNoShowResult =
  | { ok: true; minutes: number }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid" | "server_error" };

/**
 * Owner/admin: writes `salons.auto_no_show_minutes`. When > 0, a pg_cron
 * worker flags still-`confirmed` bookings for human no-show review once they
 * are this many minutes past start. It never changes status or guest history.
 * 0 = off.
 */
export async function updateAutoNoShowMinutes(
  slug: string,
  minutes: number,
): Promise<UpdateAutoNoShowResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 0 || m > 240) {
    return { ok: false, error: "invalid" };
  }

  const { error } = await ctx.supabase
    .from("salons")
    .update({ auto_no_show_minutes: m } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateAutoNoShowMinutes]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, minutes: m };
}

/* ───────────── Clients lifecycle thresholds (new / at-risk) ───────────── */

export type UpdateClientSegmentResult =
  | { ok: true; newMaxVisits: number; atRiskDays: number }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

/**
 * Owner-only: writes `salons.client_segment_settings` (jsonb). Controls how the
 * Clients page buckets customers — "New" (≤ newMaxVisits visits) and "At-risk"
 * (no visit in atRiskDays). Values are clamped by parseClientSegmentSettings so
 * out-of-range input falls back to the defaults rather than being rejected.
 */
export async function updateClientSegmentSettings(
  slug: string,
  input: { newMaxVisits: number; atRiskDays: number },
): Promise<UpdateClientSegmentResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const { parseClientSegmentSettings, toClientSegmentJson } = await import(
    "@/shared/dashboard/clientSegmentSettings"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const clamped = parseClientSegmentSettings({
    new_max_visits: input.newMaxVisits,
    at_risk_days: input.atRiskDays,
  });

  const { error } = await ctx.supabase
    .from("salons")
    .update({ client_segment_settings: toClientSegmentJson(clamped) } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateClientSegmentSettings]", error);
    return { ok: false, error: "server_error" };
  }
  return {
    ok: true,
    newMaxVisits: clamped.newMaxVisits,
    atRiskDays: clamped.atRiskDays,
  };
}

/* ───────────── Booking lead time (min advance notice) ───────────── */

export type UpdateBookingLeadResult =
  | { ok: true; minutes: number }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid" | "server_error" };

/**
 * Owner-only: writes `salons.booking_lead_minutes` — the minimum advance notice
 * before a same-day slot is bookable (slots starting sooner than now()+this are
 * hidden). Clamped 0–1440. Replaces the old hardcoded 15-min buffer.
 */
export async function updateBookingLeadMinutes(
  slug: string,
  minutes: number,
): Promise<UpdateBookingLeadResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 0 || m > 1440) {
    return { ok: false, error: "invalid" };
  }

  const { error } = await ctx.supabase
    .from("salons")
    .update({ booking_lead_minutes: m } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateBookingLeadMinutes]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, minutes: m };
}

export type UpdateGroupTogetherResult =
  | { ok: true; minutes: number }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid" | "server_error" };

/**
 * Owner/admin: writes `salons.group_together_threshold_minutes` — group members
 * starting within this spread still count as arriving "together", so the
 * booking flow offers a small offset before suggesting an all-together time.
 * Clamped 0–240.
 */
export async function updateGroupTogetherThreshold(
  slug: string,
  minutes: number,
): Promise<UpdateGroupTogetherResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 0 || m > 240) {
    return { ok: false, error: "invalid" };
  }

  const { error } = await ctx.supabase
    .from("salons")
    .update({ group_together_threshold_minutes: m } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateGroupTogetherThreshold]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, minutes: m };
}

/* ───────────── Reference-image upload toggle ───────────── */

export type UpdateReferenceImageResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

/**
 * Owner-only: writes an explicit `salons.reference_image_enabled` override for
 * the optional booking reference-image upload (NULL would mean "use vertical
 * default"; this action always sets an explicit true/false once the owner
 * touches it).
 */
export async function updateReferenceImageEnabled(
  slug: string,
  enabled: boolean,
): Promise<UpdateReferenceImageResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("salons")
    .update({ reference_image_enabled: enabled } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateReferenceImageEnabled]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, enabled };
}

/* ───────────── Staff selection toggle ───────────── */

export type UpdateStaffSelectionResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

/**
 * Owner-only: writes `salons.staff_selection_enabled`. When false, the public
 * booking wizard hides the "choose staff" step and auto-assigns any available
 * provider (common for spas where customers don't pick a therapist).
 */
export async function updateStaffSelectionEnabled(
  slug: string,
  enabled: boolean,
): Promise<UpdateStaffSelectionResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("salons")
    .update({ staff_selection_enabled: enabled } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateStaffSelectionEnabled]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, enabled };
}

/* ───────────── Walk-in auto-assign toggle (PR #107) ───────────── */

export type UpdateWalkinAutoAssignResult =
  | { ok: true; walkinAutoAssign: boolean }
  | {
      ok: false;
      error: "unauthorized" | "forbidden" | "server_error";
    };

/**
 * Owner-only: writes `salons.walkin_auto_assign`. Controls whether
 * the receptionist's "Assign immediately" path is enabled when a
 * walk-in is added and the chosen staff is free now.
 *
 * TRUE  → existing behavior (skip the queue, confirm at start=now()).
 * FALSE → every walk-in lands in `status=waiting` first; the
 *         receptionist must dispatch from the queue panel even when
 *         a staff member is available now.
 */
export async function updateWalkinAutoAssign(
  slug: string,
  enabled: boolean,
): Promise<UpdateWalkinAutoAssignResult> {
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "server_error" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  // Cast: `walkin_auto_assign` is not yet in the auto-generated
  // Supabase types until the next regeneration.
  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ walkin_auto_assign: enabled } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateWalkinAutoAssign]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, walkinAutoAssign: enabled };
}

type UpdateQueueDisplayModeResult =
  | { ok: true; queueDisplayMode: "simple" | "full" }
  | { ok: false; error: string };

export async function updateQueueDisplayMode(
  slug: string,
  mode: "simple" | "full",
): Promise<UpdateQueueDisplayModeResult> {
  if (mode !== "simple" && mode !== "full") {
    return { ok: false, error: "server_error" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ queue_display_mode: mode } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateQueueDisplayMode]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, queueDisplayMode: mode };
}

type UpdatePhoneOtpResult =
  | { ok: true; phoneOtpEnabled: boolean }
  | { ok: false; error: string };

export async function updatePhoneOtpEnabled(
  slug: string,
  enabled: boolean,
): Promise<UpdatePhoneOtpResult> {
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "server_error" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ phone_otp_enabled: enabled } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updatePhoneOtpEnabled]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, phoneOtpEnabled: enabled };
}

export type BookingVerificationMode =
  | "never"
  | "auto"
  | "always_otp"
  | "always_deposit"
  | "deposit_first";

export async function updateBookingVerificationMode(
  slug: string,
  mode: BookingVerificationMode,
): Promise<{ ok: boolean; error?: string }> {
  const VALID_MODES: BookingVerificationMode[] = [
    "never", "auto", "always_otp", "always_deposit", "deposit_first",
  ];
  if (!VALID_MODES.includes(mode)) return { ok: false, error: "invalid_mode" };

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ booking_verification_mode: mode } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[updateBookingVerificationMode]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}

/* ───────────── AI agent feature flags ───────────── */

// Types live in aiAgentTypes.ts (no "use server") so client components can import them.
export type { AiAgentFlagKey, AiAgentFlags } from "@/shared/dashboard/aiAgentTypes";
import {
  AI_AGENT_IMPACT,
  isAiAgentFlagKey,
  requiresAiAgentEnableAcknowledgement,
  type AiAgentFlagKey,
} from "@/shared/dashboard/aiAgentTypes";

export type UpdateAiAgentFlagResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_flag"
        | "invalid_enabled_value"
        | "impact_confirmation_required"
        | "server_error";
    };

/** Owner/admin: merge a single AI agent flag into salons.feature_flags JSONB. */
export async function updateAiAgentFlag(
  slug: string,
  flagKey: AiAgentFlagKey,
  enabled: boolean,
  options?: { impactAcknowledged?: boolean },
): Promise<UpdateAiAgentFlagResult> {
  if (!isAiAgentFlagKey(flagKey)) {
    return { ok: false, error: "invalid_flag" };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "invalid_enabled_value" };
  }
  if (
    enabled &&
    requiresAiAgentEnableAcknowledgement(flagKey) &&
    options?.impactAcknowledged !== true
  ) {
    return { ok: false, error: "impact_confirmation_required" };
  }

  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { data, error } = await createServiceRoleClient().rpc(
    "set_ai_agent_permission" as never,
    {
      p_salon_id: ctx.salon.id,
      p_actor_user_id: ctx.userId,
      p_actor_role: ctx.role,
      p_actor_kind: ctx.kind,
      p_flag_key: flagKey,
      p_enabled: enabled,
      p_impact: AI_AGENT_IMPACT[flagKey],
      p_impact_acknowledged: options?.impactAcknowledged === true,
    } as never,
  );
  if (error) {
    console.error("[updateAiAgentFlag]", flagKey, error.code);
    return { ok: false, error: "server_error" };
  }

  const result = (data ?? {}) as {
    success?: boolean;
    code?: string;
    changed?: boolean;
    had_any_agent?: boolean;
    has_ai_profile?: boolean;
  };
  if (!result.success) {
    if (result.code === "impact_confirmation_required") {
      return { ok: false, error: "impact_confirmation_required" };
    }
    if (result.code === "forbidden" || result.code === "invalid_actor") {
      return { ok: false, error: "forbidden" };
    }
    return { ok: false, error: "server_error" };
  }

  // First agent ever enabled + no SIP yet → fire-and-forget buildSip so
  // Manager Briefing can open with "Minh đã tự học..." instead of blank slate.
  if (
    enabled &&
    result.changed &&
    !result.had_any_agent &&
    !result.has_ai_profile
  ) {
    import("@/shared/ai/buildSip")
      .then(({ buildSip }) => buildSip(ctx.salon.id))
      .catch((e) => console.error("[updateAiAgentFlag] buildSip", e));
  }

  return { ok: true };
}

/* ───────────── AI Manager instructions ───────────── */

export type UpdateAiManagerInstructionsResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

/** Owner/admin: save standing instructions for Minh (max 1000 chars). */
export async function updateAiManagerInstructions(
  slug: string,
  instructions: string,
): Promise<UpdateAiManagerInstructionsResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const trimmed = instructions.trim().slice(0, 1000);

  const { error } = await ctx.supabase
    .from("salons")
    .update({ ai_manager_instructions: trimmed || null } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateAiManagerInstructions]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true };
}

// ─── Owner notification settings ────────────────────────────────────────────

export type UpdateOwnerNotifResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

export async function updateOwnerNotificationSettings(
  slug: string,
  settings: {
    channel: "email" | "sms" | "both";
    phone: string;
  },
): Promise<UpdateOwnerNotifResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  // Normalize phone to E.164 if provided
  const rawPhone = settings.phone.replace(/\s/g, "");
  const phone = rawPhone.length > 0 ? rawPhone : null;

  const { error } = await ctx.supabase
    .from("salons")
    .update({
      owner_notification_channel: settings.channel,
      owner_phone: phone,
    } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateOwnerNotificationSettings]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true };
}

/* ───────────────── Salon logo (public booking header) ───────────────── */

export type SalonLogoResult =
  | { ok: true; logoUrl: string | null }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "no_file"
        | "file_too_large"
        | "invalid_type"
        | "server_error";
    };

/** 2 MB — a logo has no business being larger, and the booking header renders it small. */
const SALON_LOGO_MAX_BYTES = 2 * 1024 * 1024;
const SALON_LOGO_MIME = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

/**
 * Member-gated upload of `salons.logo_url`. Mirrors `uploadSectionImage`:
 * auth through `getDashboardWriteClient`, bytes through the service-role client
 * into the public `salon-imports` bucket.
 *
 * The path is timestamped rather than overwritten so a cached CDN copy of the
 * old logo can't outlive the change.
 */
export async function uploadSalonLogo(
  slug: string,
  formData: FormData,
): Promise<SalonLogoResult> {
  const { getDashboardWriteClient } = await import("@/shared/dashboard/setupActions");
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return { ok: false, error: "no_file" };
  if (file.size > SALON_LOGO_MAX_BYTES) return { ok: false, error: "file_too_large" };
  if (!SALON_LOGO_MIME.includes(file.type)) return { ok: false, error: "invalid_type" };

  const ext = file.type === "image/svg+xml" ? "svg" : (file.name.split(".").pop()?.toLowerCase() ?? "png");
  const path = `${ctx.salon.id}/logo/logo-${Date.now()}.${ext}`;

  const db = createServiceRoleClient();
  const { error: uploadErr } = await db.storage
    .from("salon-imports")
    .upload(path, file, { contentType: file.type, upsert: true });

  if (uploadErr) {
    console.error("[uploadSalonLogo] storage", uploadErr);
    return { ok: false, error: "server_error" };
  }

  const { data } = db.storage.from("salon-imports").getPublicUrl(path);
  const logoUrl = data.publicUrl;

  const { error: upErr } = await ctx.supabase
    .from("salons")
    .update({ logo_url: logoUrl } as never)
    .eq("id", ctx.salon.id);

  if (upErr) {
    console.error("[uploadSalonLogo] update", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, logoUrl };
}

/** Clears `salons.logo_url`. The stored object is left in place — it is small,
 *  and deleting it would break any page still holding the old URL. */
export async function removeSalonLogo(slug: string): Promise<SalonLogoResult> {
  const { getDashboardWriteClient } = await import("@/shared/dashboard/setupActions");
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("salons")
    .update({ logo_url: null } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[removeSalonLogo]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, logoUrl: null };
}
