"use server";

import { cookies } from "next/headers";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  NAILQ_DEMO_SLUG_COOKIE,
} from "@/shared/lib/demoDashboardCookie";
import { isOpeningHoursCustomized } from "@/shared/dashboard/openingHoursDefaults";
import type {
  BookingStatus,
  SalonDashboardBooking,
} from "@/shared/types";

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
};

async function getSalonViaDemoCookie(slug: string): Promise<SalonRow | null> {
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
    .select(SALON_DASHBOARD_SELECT)
    .eq("slug", slug)
    .in("id", salonIds)
    .maybeSingle();

  if (salErr || !salon) return null;

  const row = salon as SalonRow & {
    email?: unknown;
    profile_complete?: unknown;
  };
  return {
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
    email:
      row.email === undefined || row.email === null
        ? null
        : String(row.email).trim() || null,
    profile_complete: !!row.profile_complete,
  };
}

type ServiceJoinRow = { name: string; price_cents: number };

type BookingRowDb = {
  id: string;
  client_name: string;
  client_phone: string;
  start_time_utc: string;
  status: string;
  price_cents: number | null;
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
  const price =
    row.price_cents ?? svc?.price_cents ?? 0;
  return {
    id: row.id,
    client_name: row.client_name,
    client_phone: row.client_phone,
    start_time_utc: row.start_time_utc,
    status: safeStatus,
    service_name: svc?.name ?? "—",
    price_cents: Number(price),
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

  const { salon, kind } = resolved;
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

  const selectCols =
    "id, client_name, client_phone, start_time_utc, status, price_cents, services ( name, price_cents )";

  const { data: bookingRows, error: bookingsErr } = await supabase
    .from("bookings")
    .select(selectCols)
    .eq("salon_id", salon.id)
    .gte("start_time_utc", from.toISOString())
    .lte("start_time_utc", to.toISOString())
    .order("start_time_utc", { ascending: true });

  if (bookingsErr) {
    console.error("[loadSalonOwnerDashboard] bookings", bookingsErr);
    return { ok: false, error: "server_error" };
  }

  const allBookings = (bookingRows ?? []).map((r) =>
    mapBookingRow(r as unknown as BookingRowDb),
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
