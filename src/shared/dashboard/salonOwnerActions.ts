"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { type ActorRole, logBookingEvent } from "@/shared/dashboard/auditLog";
import {
  NAILQ_DEMO_SLUG_COOKIE,
} from "@/shared/lib/demoDashboardCookie";
import {
  DEMO_SALON_SLUG,
  isDemoOtpRuntime,
  isDemoSlugPinBypassed,
} from "@/shared/lib/demoOtpMode";
import {
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

const SALON_DASHBOARD_SELECT =
  "id, name, slug, phone, email, address, salon_phone, opening_hours, profile_complete";

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
    };
  }

  return null;
}

async function getSalonIfMember(
  slug: string,
): Promise<
  | { salon: SalonRow; role: SalonMemberRole; viewerEmail: string | null }
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
    },
    role,
    viewerEmail,
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

  const { count: servicesCount, error: scErr } = await supabase
    .from("services")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salon.id);

  const { count: staffCount, error: stErr } = await supabase
    .from("staff")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salon.id);

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

  const { salon, kind } = resolved;
  const supabase =
    kind === "demo_cookie"
      ? createServiceRoleClient()
      : await createClient();

  const { data: row, error: fetchErr } = await supabase
    .from("bookings")
    .select("id, status, salon_id")
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
  const patch: { status: BookingStatus; started_at?: string } = toInProgress
    ? { status: "in_progress", started_at: startedAt }
    : { status: nextStatus };

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
    actorUserId: null,
    actorRole: (kind === "demo_cookie"
      ? "demo_cookie"
      : (resolved.role as ActorRole)) satisfies ActorRole,
    eventType: "booking_status_changed",
    payload: { from: cur, to: nextStatus },
  });

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
  if (ctx.role !== "owner") {
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
  if (ctx.role !== "owner") {
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
  if (ctx.role !== "owner") {
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

