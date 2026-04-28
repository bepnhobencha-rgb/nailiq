"use server";

import { cookies } from "next/headers";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  NAILQ_DEMO_SLUG_COOKIE,
} from "@/shared/lib/demoDashboardCookie";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import type {
  BookingStatus,
  SalonDashboardBooking,
} from "@/shared/types";

function utcDayBounds(
  d: Date,
): { dayStartIso: string; nextDayStartIso: string } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const dayStart = new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
  const nextDayStart = new Date(Date.UTC(y, m, day + 1, 0, 0, 0, 0));
  return {
    dayStartIso: dayStart.toISOString(),
    nextDayStartIso: nextDayStart.toISOString(),
  };
}

type SalonRow = {
  id: string;
  name: string;
  slug: string;
  phone: string;
  email: string | null;
};

async function getSalonViaDemoCookie(slug: string): Promise<SalonRow | null> {
  if (!isDemoOtpRuntime()) return null;
  const cookieStore = await cookies();
  const demoSlug = cookieStore.get(NAILQ_DEMO_SLUG_COOKIE)?.value;
  if (!demoSlug || demoSlug !== slug) return null;

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch {
    return null;
  }

  const { data: salon, error } = await admin
    .from("salons")
    .select("id, name, slug, phone, email")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !salon) return null;
  const row = salon as SalonRow & { email?: unknown };
  return {
    ...row,
    email:
      row.email === undefined || row.email === null
        ? null
        : String(row.email).trim() || null,
  };
}

/** Authorized dashboard viewer (logged-in salon member or demo cookie slug match). */
export async function resolveSalonForDashboard(
  slug: string,
): Promise<{ salon: SalonRow; kind: "member" | "demo_cookie" } | null> {
  const memberSalon = await getSalonIfMember(slug);
  if (memberSalon) return { salon: memberSalon, kind: "member" };

  const demoSalon = await getSalonViaDemoCookie(slug);
  if (demoSalon) return { salon: demoSalon, kind: "demo_cookie" };

  return null;
}

async function getSalonIfMember(slug: string): Promise<SalonRow | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: members, error: memErr } = await supabase
    .from("salon_members")
    .select("salon_id")
    .eq("user_id", user.id);

  if (memErr || !members?.length) return null;

  const salonIds = members.map((m) => String(m.salon_id));

  const { data: salon, error: salErr } = await supabase
    .from("salons")
    .select("id, name, slug, phone, email")
    .eq("slug", slug)
    .in("id", salonIds)
    .maybeSingle();

  if (salErr || !salon) return null;

  const row = salon as SalonRow & { email?: unknown };
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    phone: row.phone,
    email:
      row.email === undefined || row.email === null
        ? null
        : String(row.email).trim() || null,
  };
}

type ServiceJoinRow = { name: string; price_cents: number };

type BookingRowDb = {
  id: string;
  client_name: string;
  client_phone: string;
  start_time_utc: string;
  status: string;
  services: ServiceJoinRow | ServiceJoinRow[] | null;
};

function serviceFromJoin(
  raw: ServiceJoinRow | ServiceJoinRow[] | null,
): ServiceJoinRow | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

function mapBookingRow(row: BookingRowDb): SalonDashboardBooking {
  const status = row.status as BookingStatus;
  const safeStatus: BookingStatus =
    status === "pending" || status === "confirmed" || status === "completed"
      ? status
      : "pending";
  const svc = serviceFromJoin(row.services);
  return {
    id: row.id,
    client_name: row.client_name,
    client_phone: row.client_phone,
    start_time_utc: row.start_time_utc,
    status: safeStatus,
    service_name: svc?.name ?? "—",
    price_cents: Number(svc?.price_cents ?? 0),
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
      };
      demoMode: boolean;
      today: SalonDashboardBooking[];
      upcoming: SalonDashboardBooking[];
      stats: {
        totalToday: number;
        pending: number;
        confirmed: number;
        completed: number;
        revenueCents: number;
      };
    }
  | { ok: false; error: "unauthorized" | "server_error" };

export async function loadSalonOwnerDashboard(
  slug: string,
): Promise<LoadSalonDashboardResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) {
    return { ok: false, error: "unauthorized" };
  }

  const { salon, kind } = resolved;
  const demoMode = kind === "demo_cookie";

  const supabase =
    kind === "demo_cookie"
      ? createServiceRoleClient()
      : await createClient();
  const { dayStartIso, nextDayStartIso } = utcDayBounds(new Date());
  const upcomingEnd = new Date(nextDayStartIso);
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + 7);
  const upcomingEndIso = upcomingEnd.toISOString();

  const selectCols =
    "id, client_name, client_phone, start_time_utc, status, services ( name, price_cents )";

  const { data: todayRows, error: todayErr } = await supabase
    .from("bookings")
    .select(selectCols)
    .eq("salon_id", salon.id)
    .gte("start_time_utc", dayStartIso)
    .lt("start_time_utc", nextDayStartIso)
    .order("start_time_utc", { ascending: true });

  if (todayErr) {
    console.error("[loadSalonOwnerDashboard] today", todayErr);
    return { ok: false, error: "server_error" };
  }

  const { data: upcomingRows, error: upErr } = await supabase
    .from("bookings")
    .select(selectCols)
    .eq("salon_id", salon.id)
    .eq("status", "confirmed")
    .gte("start_time_utc", nextDayStartIso)
    .lt("start_time_utc", upcomingEndIso)
    .order("start_time_utc", { ascending: true });

  if (upErr) {
    console.error("[loadSalonOwnerDashboard] upcoming", upErr);
    return { ok: false, error: "server_error" };
  }

  const today = (todayRows ?? []).map((r) =>
    mapBookingRow(r as unknown as BookingRowDb),
  );
  const upcoming = (upcomingRows ?? []).map((r) =>
    mapBookingRow(r as unknown as BookingRowDb),
  );

  const pending = today.filter((b) => b.status === "pending").length;
  const confirmed = today.filter((b) => b.status === "confirmed").length;
  const completed = today.filter((b) => b.status === "completed").length;
  const revenueCents = today.reduce((sum, b) => sum + b.price_cents, 0);

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
    },
    demoMode,
    today,
    upcoming,
    stats: {
      totalToday: today.length,
      pending,
      confirmed,
      completed,
      revenueCents,
    },
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
  const allowed =
    (cur === "pending" && nextStatus === "confirmed") ||
    (cur === "confirmed" && nextStatus === "completed");

  if (!allowed) {
    return { ok: false, error: "invalid_transition" };
  }

  const { error: upErr } = await supabase
    .from("bookings")
    .update({ status: nextStatus })
    .eq("id", bookingId)
    .eq("salon_id", salon.id);

  if (upErr) {
    console.error("[updateBookingStatus]", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}

export type { BookingStatus, SalonDashboardBooking } from "@/shared/types";
