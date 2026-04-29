import { getUserMessages } from "@/shared/i18n/user";
import type { LoadSalonDashboardResult } from "@/shared/dashboard/salonOwnerActions";
import type { BookingStatus, SalonDashboardBooking } from "@/shared/types";

export type SalonDashboardStatsSlice = {
  totalToday: number;
  pending: number;
  confirmed: number;
  completed: number;
  revenueCents: number;
};

/** Server `allBookings` plus client-local day split (today / upcoming / stats). */
export type SalonOwnerDashboardViewPayload = Extract<
  LoadSalonDashboardResult,
  { ok: true }
> & {
  today: SalonDashboardBooking[];
  upcoming: SalonDashboardBooking[];
  stats: SalonDashboardStatsSlice;
};

export function nextBookingStatus(
  current: BookingStatus,
): BookingStatus | null {
  if (current === "pending") return "confirmed";
  if (current === "confirmed") return "completed";
  return null;
}

export function salonBookingStatusLabel(
  s: BookingStatus,
  t: ReturnType<typeof getUserMessages>["salonDashboard"],
): string {
  if (s === "pending") return t.statusPending;
  if (s === "confirmed") return t.statusConfirmed;
  return t.statusCompleted;
}

export function salonBookingStatusClass(s: BookingStatus): string {
  if (s === "pending") {
    return "border-nq-primary/35 bg-nq-primary/10 text-nq-primary ring-1 ring-nq-primary/25";
  }
  if (s === "confirmed") {
    return "border-nq-info/35 bg-nq-info/10 text-nq-info ring-1 ring-nq-info/25";
  }
  return "border-nq-success/35 bg-nq-success/10 text-nq-success ring-1 ring-nq-success/25";
}

export function formatSalonMoney(cents: number, lang: "en" | "vi"): string {
  const amount = cents / 100;
  return new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Split fetched bookings using the viewer's local calendar day (browser timezone). */
export function splitSalonDashboardBookings(
  allBookings: SalonDashboardBooking[],
): {
  today: SalonDashboardBooking[];
  upcoming: SalonDashboardBooking[];
  stats: SalonDashboardStatsSlice;
} {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const today = allBookings.filter((b) => {
    const t = new Date(b.start_time_utc);
    return t >= todayStart && t <= todayEnd;
  });

  const upcoming = allBookings.filter((b) => {
    const t = new Date(b.start_time_utc);
    return t > todayEnd && b.status === "confirmed";
  });

  const pending = today.filter((b) => b.status === "pending").length;
  const confirmed = today.filter((b) => b.status === "confirmed").length;
  const completed = today.filter((b) => b.status === "completed").length;
  const revenueCents = today.reduce((sum, b) => sum + b.price_cents, 0);

  return {
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
