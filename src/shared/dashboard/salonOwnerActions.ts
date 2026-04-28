"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";

export type BookingStatus = "pending" | "confirmed" | "completed";

export type SalonDashboardBooking = {
  id: string;
  client_name: string;
  client_phone: string;
  start_time_utc: string;
  status: BookingStatus;
  service_name: string;
  price_cents: number;
};

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

type SalonRow = { id: string; name: string; slug: string; phone: string };

async function getSalonIfOwner(
  slug: string,
  ownerPhoneRaw: string,
): Promise<SalonRow | null> {
  const ownerPhone = normalizeRegisterPhone(ownerPhoneRaw);
  if (!isRegisterPhoneDigitsValid(ownerPhone)) return null;

  const supabase = await createClient();
  const { data: salon, error } = await supabase
    .from("salons")
    .select("id, name, slug, phone")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !salon) return null;
  if (normalizeRegisterPhone(String(salon.phone)) !== ownerPhone) return null;

  return salon as SalonRow;
}

type BookingRowDb = {
  id: string;
  client_name: string;
  client_phone: string;
  start_time_utc: string;
  status: string;
  services: { name: string; price_cents: number } | null;
};

function mapBookingRow(row: BookingRowDb): SalonDashboardBooking {
  const status = row.status as BookingStatus;
  const safeStatus: BookingStatus =
    status === "pending" || status === "confirmed" || status === "completed"
      ? status
      : "pending";
  return {
    id: row.id,
    client_name: row.client_name,
    client_phone: row.client_phone,
    start_time_utc: row.start_time_utc,
    status: safeStatus,
    service_name: row.services?.name ?? "—",
    price_cents: Number(row.services?.price_cents ?? 0),
  };
}

export type LoadSalonDashboardResult =
  | {
      ok: true;
      salon: { id: string; name: string; slug: string };
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

/**
 * Owner gate: `createClient()` verifies salon slug + phone (public `salons` select).
 * Booking rows are read with the service role because RLS denies anon SELECT on `bookings`.
 */
export async function loadSalonOwnerDashboard(
  slug: string,
  ownerPhone: string,
): Promise<LoadSalonDashboardResult> {
  const salon = await getSalonIfOwner(slug, ownerPhone);
  if (!salon) {
    return { ok: false, error: "unauthorized" };
  }

  let sb;
  try {
    sb = createServiceRoleClient();
  } catch {
    return { ok: false, error: "server_error" };
  }

  const { dayStartIso, nextDayStartIso } = utcDayBounds(new Date());
  const upcomingEnd = new Date(nextDayStartIso);
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + 7);
  const upcomingEndIso = upcomingEnd.toISOString();

  const selectCols =
    "id, client_name, client_phone, start_time_utc, status, services ( name, price_cents )";

  const { data: todayRows, error: todayErr } = await sb
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

  const { data: upcomingRows, error: upErr } = await sb
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
    salon: { id: salon.id, name: salon.name, slug: salon.slug },
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
  | { ok: false; error: "unauthorized" | "not_found" | "invalid_transition" | "server_error" };

export async function updateBookingStatus(
  bookingId: string,
  nextStatus: BookingStatus,
  slug: string,
  ownerPhone: string,
): Promise<UpdateBookingStatusResult> {
  const salon = await getSalonIfOwner(slug, ownerPhone);
  if (!salon) {
    return { ok: false, error: "unauthorized" };
  }

  let sb;
  try {
    sb = createServiceRoleClient();
  } catch {
    return { ok: false, error: "server_error" };
  }

  const { data: row, error: fetchErr } = await sb
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

  const { error: upErr } = await sb
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
