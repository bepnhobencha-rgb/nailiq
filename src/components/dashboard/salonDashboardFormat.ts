import { getUserMessages } from "@/shared/i18n/user";
import type { LoadSalonDashboardResult } from "@/shared/dashboard/salonOwnerActions";
import {
  OWNER_TODAY_LIST_STATUSES,
  type BookingStatus,
  type SalonDashboardBooking,
} from "@/shared/types";

const OWNER_TODAY_LIST_SET = new Set<BookingStatus>(OWNER_TODAY_LIST_STATUSES);

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
  if (current === "in_progress") return "completed";
  return null;
}

export function salonBookingStatusLabel(
  s: BookingStatus,
  t: ReturnType<typeof getUserMessages>["salonDashboard"],
): string {
  if (s === "pending") return t.statusPending;
  if (s === "confirmed") return t.statusConfirmed;
  if (s === "completed") return t.statusCompleted;
  if (s === "in_progress") return t.statusInProgress;
  if (s === "waiting") return t.statusWaiting;
  if (s === "cancelled") return t.statusCancelled;
  return t.statusPending;
}

export function salonBookingStatusClass(s: BookingStatus): string {
  if (s === "pending") {
    return "border-nq-primary/35 bg-nq-primary/10 text-nq-primary ring-1 ring-nq-primary/25";
  }
  if (s === "confirmed") {
    return "border-nq-info/35 bg-nq-info/10 text-nq-info ring-1 ring-nq-info/25";
  }
  if (s === "completed") {
    return "border-nq-success/35 bg-nq-success/10 text-nq-success ring-1 ring-nq-success/25";
  }
  if (s === "in_progress") {
    return "border-nq-primary/45 bg-nq-primary/15 text-nq-primary ring-1 ring-nq-primary/30";
  }
  if (s === "waiting") {
    return "border-nq-border/50 bg-nq-surface/50 text-nq-muted ring-1 ring-nq-border/35";
  }
  if (s === "cancelled") {
    return "border-nq-border/40 bg-nq-surface/40 text-nq-muted line-through ring-1 ring-nq-border/25";
  }
  return "border-nq-border/35 bg-nq-surface/35 text-nq-muted ring-1 ring-nq-border/25";
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

  const todayInWindow = allBookings.filter((b) => {
    if (b.start_time_utc == null) return false;
    const t = new Date(b.start_time_utc);
    return t >= todayStart && t <= todayEnd;
  });

  /** Agenda rows only (excludes completed / cancelled / queue-only). Stats still use full `todayInWindow`. */
  const today = todayInWindow.filter((b) => OWNER_TODAY_LIST_SET.has(b.status));

  const upcoming = allBookings.filter((b) => {
    if (b.start_time_utc == null) return false;
    const t = new Date(b.start_time_utc);
    return t > todayEnd && b.status === "confirmed";
  });

  const pending = todayInWindow.filter((b) => b.status === "pending").length;
  const confirmed = todayInWindow.filter((b) => b.status === "confirmed").length;
  const completed = todayInWindow.filter((b) => b.status === "completed").length;
  const revenueCents = todayInWindow.reduce((sum, b) => sum + b.price_cents, 0);

  return {
    today,
    upcoming,
    stats: {
      totalToday: todayInWindow.length,
      pending,
      confirmed,
      completed,
      revenueCents,
    },
  };
}
